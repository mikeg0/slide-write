// Slide Write — content-script bootstrap. Runs in the page (so the SSE stream survives the whole
// run, §10.2/§12). Mounts a Shadow-DOM widget on every matching origin; if this origin isn't
// enabled in config (§11) the panel shows a disabled "set up" state rather than going live. Classic
// content script: it dynamically imports the ES modules (panel.js → sse.js; picker.js) as
// web-accessible resources.
(async () => {
  const ORIGIN = location.origin;

  // 1. Read this origin's config (§11). Unlike before, we DON'T bail when it's absent/disabled — the
  //    panel still mounts, in a disabled "set up" state with an Open-settings button, so clicking the
  //    toolbar icon always does something on a matching origin (better first-run UX). Enabling the
  //    origin in Options then flips it live via the storage listener in step 8 — no page reload.
  let cfg;
  try {
    cfg = await chrome.runtime.sendMessage({ type: "getOrigin", origin: ORIGIN });
  } catch { cfg = null; }

  // Derive the effective settings from a raw per-origin config (may be null/partial).
  function resolve(c) {
    return {
      configured: !!(c && c.enabled && c.token),
      shimUrl: ((c && c.shimUrl) || ORIGIN + "/_slidewrite").replace(/\/$/, ""),
      token: (c && c.token) || "",
      autoReload: !!(c && c.autoReload),
      model: (c && c.model) || "",   // persisted model selection (empty = use shim default)
      geminiKey: (c && c.geminiKey) || "",            // global Gemini key (getOrigin merges it in)
      imageInstructions: (c && c.imageInstructions) || "",  // per-origin image-integration steps
    };
  }
  async function fetchMeta(shimUrl, token) {
    if (!token) return null;
    try {
      const r = await fetch(`${shimUrl}/meta`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return await r.json();
    } catch { /* offline / agent down */ }
    return null;
  }

  const init = resolve(cfg);
  const shimUrl = init.shimUrl;
  const token = init.token;

  // 2. Shadow-DOM host. Tag it (and everything inside) data-slidewrite-ui so the picker skips it (§10.3).
  const host = document.createElement("div");
  host.setAttribute("data-slidewrite-ui", "");
  host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(Object.assign(document.createElement("link"),
    { rel: "stylesheet", href: chrome.runtime.getURL("styles.css") }));
  const rootEl = document.createElement("div");
  rootEl.setAttribute("data-slidewrite-ui", "");
  shadow.append(rootEl);
  (document.body || document.documentElement).append(host);

  // 3. If already wired up, confirm which repo this tab is connected to (§11): GET <shimUrl>/meta.
  const meta = init.configured ? await fetchMeta(shimUrl, token) : null;

  // 4. Mount the panel (always — disabled "set up" state when not yet configured).
  const { createPanel } = await import(chrome.runtime.getURL("content/panel.js"));
  let pickerActive = false;
  const panel = createPanel({
    root: rootEl, shimUrl, token, meta,
    configured: init.configured,
    autoReload: init.autoReload,
    model: init.model,
    geminiKey: init.geminiKey,
    imageInstructions: init.imageInstructions,
    onMarkup: () => startMarkup(),
    onAddImage: () => startImagePicker(),
    onOpenOptions: () => chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {}),
    // Persist the model choice per-origin so it survives reloads (background store, §11).
    onSelectModel: (id) => chrome.runtime.sendMessage({ type: "setOrigin", origin: ORIGIN, value: { model: id } }).catch(() => {}),
  });

  // 5. No in-page affordance: the panel is toggled by the toolbar icon (action.onClicked →
  //    background → "toggle-panel") and the keyboard command, both relayed in step 7.

  // 6. Markup mode — lazily import the picker (Phase 5). Picks an element, fills the §7 context,
  //    then opens the composer anchored to it. The panel stays open during picking (the picker
  //    skips its own data-slidewrite-ui nodes), so the chat doesn't slide shut on every pick.
  //    The image variant (🖼️) reuses the same picker but asks it to also capture the element's
  //    current pixels (for image-to-image), and routes the result into image mode.
  async function startPick({ image }) {
    if (pickerActive) return;
    pickerActive = true;
    const setActive = (on) => image ? panel.setImageActive(on) : panel.setMarkupActive(on);
    setActive(true);
    try {
      const { startPicker } = await import(chrome.runtime.getURL("content/picker.js"));
      startPicker((ctx) => {
        pickerActive = false;
        setActive(false);
        if (ctx) { (image ? panel.setImageContext : panel.setElementContext)(ctx); panel.open(); }
      }, { captureImage: image });
    } catch (e) {
      pickerActive = false;
      setActive(false);
      console.warn("[slide-write] picker unavailable:", e);
    }
  }
  const startMarkup = () => startPick({ image: false });
  const startImagePicker = () => startPick({ image: true });

  // 7. Keyboard shortcut relayed from the background command.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "toggle-panel") panel.toggle();
  });

  // 8. Live config: when this origin's settings change in Options, re-resolve and push to the panel
  //    so a freshly-enabled origin goes live in place — no page reload. (background.js stores the
  //    whole config under the "slidewrite" key in chrome.storage.local.)
  let liveCfg = init, lastMeta = meta;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.slidewrite) return;
    const nv = changes.slidewrite.newValue || {};
    // The global Gemini key lives at the config root; merge it in like background.js's getOrigin does.
    const next = resolve({ ...((nv.origins || {})[ORIGIN] || null), geminiKey: nv.geminiKey || "" });
    // Only re-fetch /meta when the connection actually changed — a model-only edit (which we write
    // here ourselves on selection) reuses the cached meta, so the dropdown doesn't churn.
    const connChanged = next.shimUrl !== liveCfg.shimUrl || next.token !== liveCfg.token || next.configured !== liveCfg.configured;
    const m = connChanged ? (next.configured ? await fetchMeta(next.shimUrl, next.token) : null) : lastMeta;
    liveCfg = next; lastMeta = m;
    panel.setConfig({ shimUrl: next.shimUrl, token: next.token, meta: m, autoReload: next.autoReload,
      configured: next.configured, model: next.model, geminiKey: next.geminiKey, imageInstructions: next.imageInstructions });
  });
})();
