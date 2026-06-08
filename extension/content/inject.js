// Slide Write — content-script bootstrap. Runs in the page (so the SSE stream survives the whole
// run, §10.2/§12). Mounts a Shadow-DOM widget ONLY on origins that are enabled in config (§11);
// inert everywhere else. Classic content script: it dynamically imports the ES modules
// (panel.js → sse.js; picker.js) as web-accessible resources.
(async () => {
  const ORIGIN = location.origin;

  // 1. Per-origin opt-in (§11). Ask the background for this origin's config; stay inert if absent/disabled.
  let cfg;
  try {
    cfg = await chrome.runtime.sendMessage({ type: "getOrigin", origin: ORIGIN });
  } catch { return; }
  if (!cfg || !cfg.enabled || !cfg.token) return;

  const shimUrl = (cfg.shimUrl || ORIGIN + "/_slidewrite").replace(/\/$/, "");
  const token = cfg.token;

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

  // 3. Confirm which repo this tab is wired to (§11): GET <shimUrl>/meta.
  let meta = null;
  try {
    const r = await fetch(`${shimUrl}/meta`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) meta = await r.json();
  } catch { /* offline / agent down — panel still loads, status shows "not connected" */ }

  // 4. Mount the panel.
  const { createPanel } = await import(chrome.runtime.getURL("content/panel.js"));
  let pickerActive = false;
  const panel = createPanel({
    root: rootEl, shimUrl, token, meta,
    autoReload: !!cfg.autoReload,
    onMarkup: () => startMarkup(),
    onOpenOptions: () => chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {}),
  });

  // 5. No in-page affordance: the panel is toggled by the toolbar icon (action.onClicked →
  //    background → "toggle-panel") and the keyboard command, both relayed in step 7.

  // 6. Markup mode — lazily import the picker (Phase 5). Picks an element, fills the §7 context,
  //    then opens the composer anchored to it.
  async function startMarkup() {
    if (pickerActive) return;
    pickerActive = true;
    try {
      const { startPicker } = await import(chrome.runtime.getURL("content/picker.js"));
      panel.close();
      startPicker((ctx) => {
        pickerActive = false;
        if (ctx) { panel.setElementContext(ctx); panel.open(); }
      });
    } catch (e) {
      pickerActive = false;
      console.warn("[slide-write] picker unavailable:", e);
    }
  }

  // 7. Keyboard shortcut relayed from the background command, plus Esc to close.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "toggle-panel") panel.toggle();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.isOpen()) panel.close();
  });
})();
