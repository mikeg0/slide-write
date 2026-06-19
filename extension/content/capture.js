// Slide Write — the in-page capture function for the CDP picker.
//
// This is NOT a content script. The picker is driven from background.js via chrome.debugger / the
// Chrome DevTools Protocol (Overlay.setInspectMode). When the user clicks an element, the background
// resolves the picked node to a RemoteObject (DOM.resolveNode) and runs THIS function on it via
// Runtime.callFunctionOn — i.e. `swCapture.toString()` is shipped into the page and invoked with
// `this` bound to the picked element, IN THAT ELEMENT'S OWN FRAME (so it works inside iframes,
// cross-origin included). It must therefore be fully self-contained: every helper is defined inside
// the function body, because only the function source crosses the protocol — outer references would
// be undefined in the page.
//
// It returns the §7 element-capture contract (minus the screenshot, which the background grabs via
// Page.captureScreenshot). The shape MUST match content/picker.js's old captureContext + the §7 spec.
export function swCapture(captureImage) {
  const el = this;
  if (!el || el.nodeType !== 1) return null;

  // domPath: nth-of-type chain of ≤5 ancestors, stops at the first id (§7). Within the element's
  // own frame's document, so an iframe element's path is relative to the iframe document.
  function buildDomPath(node) {
    const parts = [];
    let n = node, depth = 0;
    while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && depth < 5) {
      let seg = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(`${seg}#${n.id}`); break; }
      if (n.classList && n.classList.length) seg += "." + Array.from(n.classList).slice(0, 3).join(".");
      const parent = n.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
      }
      parts.unshift(seg);
      n = n.parentElement; depth++;
    }
    return parts.join(" > ");
  }

  // fullPath: the uncapped root-to-element selector (the auto-copy-to-clipboard target). Walks all
  // the way to <body>, never stops at an id, keeps every class + nth-of-type so it resolves uniquely.
  function buildFullPath(node) {
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      let seg = n.tagName.toLowerCase();
      if (n.id) seg += `#${n.id}`;
      else if (n.classList && n.classList.length) seg += "." + Array.from(n.classList).join(".");
      const parent = n.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
      }
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.join(" > ");
  }

  // Best-effort PNG data-URL of an <img>'s current pixels (image-to-image). null for non-images,
  // not-yet-loaded images, or a tainted (cross-origin) canvas — caller falls back to text-to-image.
  function captureImageData(node) {
    try {
      if (node.tagName.toLowerCase() !== "img" || !node.complete || !node.naturalWidth) return null;
      const max = 1024;
      const scale = Math.min(1, max / Math.max(node.naturalWidth, node.naturalHeight));
      const w = Math.max(1, Math.round(node.naturalWidth * scale)), h = Math.max(1, Math.round(node.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(node, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    } catch { return null; }
  }

  const r = el.getBoundingClientRect();
  const ctx = {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === "string" ? el.className : (el.getAttribute("class") || null),
    text: (el.textContent || "").trim().slice(0, 120) || null,
    domPath: buildDomPath(el),
    fullPath: buildFullPath(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
  if (captureImage) {
    const dataUrl = captureImageData(el);
    if (dataUrl) ctx.imageDataUrl = dataUrl;   // present → shim does image-to-image; absent → text-to-image
  }
  return ctx;
}
