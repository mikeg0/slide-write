// Slide Write — capture-phase element picker (§10.3). Hover to highlight, click to capture the §7
// element context. The four robustness rules:
//   1. Listen on `window` in the CAPTURE phase; preventDefault + stopPropagation on click so marking
//      an element never triggers the app's own handlers (clicking a nav item doesn't navigate).
//      Clicks on our own UI (data-slidewrite-ui) are NOT suppressed — the panel stays usable while armed.
//   2. document.elementFromPoint, then walk up and skip our own UI (tagged data-slidewrite-ui).
//   3. Highlight box is position:fixed; pointer-events:none, so it never intercepts the hit-test.
//   4. Capture the §7 context per click and hand it back — the picker STAYS ARMED for consecutive
//      picks. It disarms on Escape (onPick(null) after cleanup) or when the consumer calls the
//      returned stop() (🎯 toggled off, element cap reached).

// Verbatim from §10.3 — never mark our own UI.
function skipOwnUI(el) {
  let n = el;
  while (n && n !== document.body && n !== document.documentElement) {
    if (n.dataset && "slidewriteUi" in n.dataset) return null;
    n = n.parentElement;
  }
  return (!el || el === document.body || el === document.documentElement) ? null : el;
}

// Build domPath as an nth-of-type chain of ≤5 ancestors, stopping at the first id (§7).
function buildDomPath(el) {
  const parts = [];
  let n = el, depth = 0;
  while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && depth < 5) {
    let seg = n.tagName.toLowerCase();
    if (n.id) { parts.unshift(`${seg}#${n.id}`); break; }      // stop at first id
    if (n.classList && n.classList.length) {
      seg += "." + Array.from(n.classList).slice(0, 3).join(".");
    }
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

// Build the FULL root-to-element selector for the auto-copy-to-clipboard target: unlike buildDomPath
// this is uncapped and never stops at an id — it walks all the way up to (and including) <body>,
// keeping every class and an nth-of-type disambiguator, so the result resolves uniquely via
// document.querySelector.
function buildFullPath(el) {
  const parts = [];
  let n = el;
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

// Best-effort copy: the async Clipboard API works here because onClick runs inside the user's click
// gesture; fall back to a temporary (data-slidewrite-ui tagged) textarea + execCommand for contexts
// where it's unavailable or rejects. Never throws — just warns on total failure.
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
  } else {
    execCommandCopy(text);
  }
}

function execCommandCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.setAttribute("data-slidewrite-ui", "");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch (e) {
    console.warn("[slide-write] clipboard copy failed:", e);
  }
}

// Best-effort capture of an <img>'s current pixels as a PNG data-URL, for image-to-image. Returns
// null for non-images, not-yet-loaded images, or a tainted (cross-origin, no-CORS) canvas — callers
// then fall back to pure text-to-image. Downscaled to keep the payload modest.
function captureImageData(el) {
  try {
    if (el.tagName.toLowerCase() !== "img" || !el.complete || !el.naturalWidth) return null;
    const max = 1024;
    const scale = Math.min(1, max / Math.max(el.naturalWidth, el.naturalHeight));
    const w = Math.max(1, Math.round(el.naturalWidth * scale)), h = Math.max(1, Math.round(el.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(el, 0, 0, w, h);
    return canvas.toDataURL("image/png");   // throws if the canvas is tainted (cross-origin)
  } catch { return null; }
}

function captureContext(el, captureImage) {
  const r = el.getBoundingClientRect();
  const ctx = {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === "string" ? el.className : (el.getAttribute("class") || null),
    text: (el.textContent || "").trim().slice(0, 120) || null,
    domPath: buildDomPath(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
  if (captureImage) {
    const dataUrl = captureImageData(el);
    if (dataUrl) ctx.imageDataUrl = dataUrl;   // present → shim does image-to-image; absent → text-to-image
  }
  return ctx;
}

export function startPicker(onPick, { captureImage = false } = {}) {
  let current = null;
  let paused = false;   // highlight + picking suspended while the consumer handles a pick (screenshot)
  let done = false;

  const box = document.createElement("div");
  box.setAttribute("data-slidewrite-ui", "");
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4646a0;" +
    "background:rgba(70,70,160,.15);border-radius:3px;display:none;";
  const label = document.createElement("div");
  label.setAttribute("data-slidewrite-ui", "");
  label.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;background:#4646a0;color:#fff;" +
    "font:11px ui-monospace,monospace;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;";
  document.body.append(box, label);

  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";

  function place(el) {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left}px`; box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`; box.style.height = `${r.height}px`;
    const tag = el.tagName.toLowerCase();
    const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "";
    label.textContent = `${tag}${el.id ? "#" + el.id : ""}${cls}`;
    label.style.display = "block";
    label.style.left = `${r.left}px`;
    label.style.top = `${Math.max(0, r.top - 20)}px`;
  }

  function hideHighlight() { box.style.display = "none"; label.style.display = "none"; }

  // Transient "✓ Path copied" confirmation after the auto-copy on a pick. Reuses the highlight label;
  // safe to call after hideHighlight() because onMove is suspended (paused) until the pick finishes.
  function flashCopied(e) {
    label.textContent = "✓ Path copied";
    label.style.display = "block";
    label.style.left = `${e.clientX + 8}px`;
    label.style.top = `${Math.max(0, e.clientY - 20)}px`;
    setTimeout(() => { if (!done) label.style.display = "none"; }, 1200);
  }

  function onMove(e) {
    if (paused) return;
    const hit = skipOwnUI(document.elementFromPoint(e.clientX, e.clientY));
    current = hit;
    if (hit) place(hit); else hideHighlight();
  }

  function suppress(e) {
    // Capture-phase block so marking never reaches the app (rule 1).
    e.preventDefault(); e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  // Suppress only over pickable elements: clicks/presses on our own UI (the panel, its chips) and on
  // bare body/html pass through untouched, so the chat stays usable while the picker is armed.
  function maybeSuppress(e) {
    if (paused || skipOwnUI(document.elementFromPoint(e.clientX, e.clientY))) suppress(e);
  }

  function onClick(e) {
    if (paused) return suppress(e);   // a pick is still being handled — swallow stray clicks
    const hit = skipOwnUI(document.elementFromPoint(e.clientX, e.clientY)) || current;
    if (!hit) return;                 // our own UI / nothing pickable — let the click through, stay armed
    suppress(e);
    copyToClipboard(buildFullPath(hit));   // auto-copy the full selector on EVERY pick (parity with the §8.5 CDP picker)
    // STAY ARMED: hide the highlight before handing off (so the consumer's screenshot is clean) and
    // pause until the (possibly async) consumer finishes, then re-arm on the next mousemove.
    paused = true; current = null; hideHighlight();
    flashCopied(e);   // after hideHighlight() so it isn't immediately re-hidden
    Promise.resolve(onPick(captureContext(hit, captureImage))).finally(() => { paused = false; });
  }

  function onKey(e) {
    if (e.key === "Escape") { suppress(e); stop(); onPick(null); }
  }

  function stop() {
    if (done) return;
    done = true;
    cleanup();
  }

  function cleanup() {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("mousedown", maybeSuppress, true);
    window.removeEventListener("pointerdown", maybeSuppress, true);
    window.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = prevCursor;
    box.remove(); label.remove();
  }

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("mousedown", maybeSuppress, true);   // stop focus/nav side effects pre-click
  window.addEventListener("pointerdown", maybeSuppress, true);
  window.addEventListener("keydown", onKey, true);

  return stop;   // consumer disarms explicitly (🎯 toggle, element cap); safe to call after Escape too
}
