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
      pollInterval: (c && c.pollInterval) || 0,       // global liveness-poll seconds (getOrigin merges it in; 0 = default)
      imageInstructions: (c && c.imageInstructions) || "",  // per-origin image-integration steps
    };
  }
  // Probe the shim so the panel can show *targeted* help instead of a flat "not connected".
  // /health needs no auth (pure reachability); /meta is the Bearer-gated truth (auth + repo info).
  // Returns one of: { state:"live", meta } · { state:"unauthorized" } (token rejected) ·
  // { state:"unreachable", detail? } (shim down / not forwarded) · { state:null } (no token yet).
  async function probe(shimUrl, token) {
    if (!token) return { state: null };
    try {
      const h = await fetch(`${shimUrl}/health`, { cache: "no-store" });
      if (!h.ok) return { state: "unreachable", detail: `health ${h.status}` };
    } catch { return { state: "unreachable" }; }
    try {
      const r = await fetch(`${shimUrl}/meta`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (r.status === 401) return { state: "unauthorized" };
      if (r.ok) return { state: "live", meta: await r.json() };
      return { state: "unreachable", detail: `meta ${r.status}` };
    } catch { return { state: "unreachable" }; }
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

  // 3. If already wired up, probe the shim (§11): /health for reachability, /meta for repo + auth.
  const conn = init.configured ? await probe(shimUrl, token) : { state: null };
  const meta = conn.meta || null;

  // 4. Mount the panel (always — disabled "set up" state when not yet configured).
  const { createPanel } = await import(chrome.runtime.getURL("content/panel.js"));
  let pickerActive = false;
  const panel = createPanel({
    root: rootEl, shimUrl, token, meta,
    conn: { state: conn.state, detail: conn.detail },
    onProbe: probe,                  // panel re-checks on open / poll / after a failed send
    configured: init.configured,
    autoReload: init.autoReload,
    model: init.model,
    geminiKey: init.geminiKey,
    pollInterval: init.pollInterval,
    imageInstructions: init.imageInstructions,
    onMarkup: () => startMarkup(),
    onOpenOptions: () => chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {}),
    // Persist the model choice per-origin so it survives reloads (background store, §11).
    onSelectModel: (id) => chrome.runtime.sendMessage({ type: "setOrigin", origin: ORIGIN, value: { model: id } }).catch(() => {}),
  });

  // 5. No in-page affordance: the panel is toggled by the toolbar icon (action.onClicked →
  //    background → "toggle-panel") and the keyboard command, both relayed in step 7.

  // 6. Markup mode — lazily import the picker (Phase 5). Picks an element, fills the §7 context,
  //    then opens the composer anchored to it. The panel stays open during picking (the picker
  //    skips its own data-slidewrite-ui nodes), so the chat doesn't slide shut on every pick.
  //    We always capture the element's current pixels (cheap, img-only) so that if the user then
  //    toggles Image Generation in the composer's "+" menu the shim can do image-to-image; the
  //    composer strips that field back out for plain /design sends.
  async function startMarkup() {
    if (pickerActive) return;
    pickerActive = true;
    panel.setMarkupActive(true);
    try {
      const { startPicker } = await import(chrome.runtime.getURL("content/picker.js"));
      startPicker(async (ctx) => {
        pickerActive = false;
        panel.setMarkupActive(false);
        if (!ctx) return;
        // Best-effort screenshot of the picked element's rendered pixels (Chrome has no
        // "screenshot this element" API — we grab the viewport and crop). Degrades silently to
        // text-only context on any failure (restricted page, tainted canvas, off-screen rect).
        const shot = await captureElementShot(ctx.rect);
        if (shot) { ctx.screenshotDataUrl = shot.dataUrl; ctx.screenshotW = shot.w; ctx.screenshotH = shot.h; }
        panel.setElementContext(ctx);
        panel.open();
      }, { captureImage: true });
    } catch (e) {
      pickerActive = false;
      panel.setMarkupActive(false);
      console.warn("[slide-write] picker unavailable:", e);
    }
  }

  // Capture the visible tab (via the background worker — chrome.tabs isn't available here) and crop
  // it to the element's rect. The picker's own highlight overlay is gone by now (cleanup() runs
  // before the pick callback), so it never appears in the shot. Known limitation: the open panel
  // occupies the right edge of the viewport, so an element behind it would be partly covered.
  async function captureElementShot(rect) {
    if (!rect || rect.w < 1 || rect.h < 1) return null;
    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "captureTab" }); } catch { return null; }
    if (!resp || !resp.ok || !resp.dataUrl) return null;
    return cropDataUrl(resp.dataUrl, rect);
  }

  // Crop a viewport PNG (device pixels) to a CSS-px rect. captureVisibleTab renders at
  // devicePixelRatio, while rect is in CSS px, so scale the source coords by dpr. Clamp to the
  // viewport (a tall element extending below the fold is captured only to the visible edge) and
  // downscale to a modest max edge so the data URL stays small. Returns null on any failure.
  function cropDataUrl(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const dpr = window.devicePixelRatio || 1;
          const vw = window.innerWidth, vh = window.innerHeight;
          const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
          const w = Math.min(rect.w - (x - rect.x), vw - x);
          const h = Math.min(rect.h - (y - rect.y), vh - y);
          if (w < 1 || h < 1) return resolve(null);
          const sx = x * dpr, sy = y * dpr, sw = w * dpr, sh = h * dpr;
          const max = 1400;
          const scale = Math.min(1, max / Math.max(sw, sh));
          const cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
          const canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
          resolve({ dataUrl: canvas.toDataURL("image/png"), w: Math.round(w), h: Math.round(h) });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // 7. Keyboard shortcut relayed from the background command.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "toggle-panel") panel.toggle();
  });

  // 8. Live config: when this origin's settings change in Options, re-resolve and push to the panel
  //    so a freshly-enabled origin goes live in place — no page reload. (background.js stores the
  //    whole config under the "slidewrite" key in chrome.storage.local.)
  let liveCfg = init, lastMeta = meta, lastConn = conn;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.slidewrite) return;
    const nv = changes.slidewrite.newValue || {};
    // The global settings live at the config root; merge them in like background.js's getOrigin does.
    const next = resolve({ ...((nv.origins || {})[ORIGIN] || null), geminiKey: nv.geminiKey || "", pollInterval: nv.pollInterval || 0 });
    // Only re-probe when the connection actually changed — a model-only edit (which we write here
    // ourselves on selection) reuses the cached state, so the dropdown/status don't churn.
    const connChanged = next.shimUrl !== liveCfg.shimUrl || next.token !== liveCfg.token || next.configured !== liveCfg.configured;
    const c = connChanged ? (next.configured ? await probe(next.shimUrl, next.token) : { state: null }) : lastConn;
    const m = c.meta || (connChanged ? null : lastMeta);
    liveCfg = next; lastMeta = m; lastConn = c;
    panel.setConfig({ shimUrl: next.shimUrl, token: next.token, meta: m, conn: { state: c.state, detail: c.detail },
      autoReload: next.autoReload, configured: next.configured, model: next.model, geminiKey: next.geminiKey,
      pollInterval: next.pollInterval, imageInstructions: next.imageInstructions });
  });
})();
