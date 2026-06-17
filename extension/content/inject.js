// Slide Write — content-script picker bridge. The chat UI + SSE stream now live in the side panel
// (sidepanel.js, an extension page that persists while open). This script stays in the page for the
// two things only a page-context content script can do: run the element picker (capture-phase
// hit-testing + an overlay highlight, §10.3) and crop the picked element's screenshot (needs the
// page's window dimensions). It's inert until the side panel arms it over runtime messaging, and
// posts picks back the same way. The picker STAYS ARMED for consecutive picks; the side panel
// disarms it on the 🎯 toggle or at the element cap, and Escape disarms it from here.
(() => {
  let armed = false;
  let stopPicker = null;   // the picker's disarm fn while armed (null otherwise)

  // Mirror the picker's armed/disarmed state up to the side panel so the 🎯 button stays in sync —
  // covers Escape (picker self-disarms) and the cap (side panel disarms us).
  function reportState(active) {
    chrome.runtime.sendMessage({ type: "sw-picker-state", active }).catch(() => {});
  }

  async function armPicker() {
    if (armed) return;
    armed = true;
    reportState(true);
    try {
      const { startPicker } = await import(chrome.runtime.getURL("content/picker.js"));
      if (!armed) return;   // disarmed while the picker module was loading
      stopPicker = startPicker(async (ctx) => {
        if (!ctx) { armed = false; stopPicker = null; reportState(false); return; }  // Escape — picker cleaned up
        // Best-effort screenshot of the picked element's rendered pixels (Chrome has no
        // "screenshot this element" API — grab the viewport and crop). Degrades silently to
        // text-only context on any failure (restricted page, tainted canvas, off-screen rect).
        const shot = await captureElementShot(ctx.rect);
        if (shot) { ctx.screenshotDataUrl = shot.dataUrl; ctx.screenshotW = shot.w; ctx.screenshotH = shot.h; }
        else console.warn("[slide-write] element screenshot capture returned no image for rect", ctx.rect);
        chrome.runtime.sendMessage({ type: "sw-element-picked", ctx }).catch((e) => console.warn("[slide-write] sw-element-picked send failed:", e));
      }, { captureImage: true });
    } catch (e) {
      armed = false; stopPicker = null; reportState(false);
      console.warn("[slide-write] picker unavailable:", e);
    }
  }

  function disarmPicker() {
    if (!armed) return;
    armed = false;
    if (stopPicker) { stopPicker(); stopPicker = null; }  // no-op if the picker already cleaned up
    reportState(false);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "sw-arm-picker") armPicker();
    else if (msg.type === "sw-disarm-picker") disarmPicker();
  });

  // Capture the visible tab (via the background worker — chrome.tabs isn't available here) and crop
  // it to the element's rect. The picker's own highlight overlay is gone by now (cleanup() runs
  // before the pick callback), so it never appears in the shot.
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
})();
