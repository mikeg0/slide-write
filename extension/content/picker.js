// Slide Write — capture-phase element picker (§10.3). Hover to highlight, click to capture the §7
// element context. The four robustness rules:
//   1. Listen on `window` in the CAPTURE phase; preventDefault + stopPropagation on click so marking
//      an element never triggers the app's own handlers (clicking a nav item doesn't navigate).
//   2. document.elementFromPoint, then walk up and skip our own UI (tagged data-slidewrite-ui).
//   3. Highlight box is position:fixed; pointer-events:none, so it never intercepts the hit-test.
//   4. Capture the §7 context, leave markup mode, hand it back to open the composer anchored to it.

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

function captureContext(el) {
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === "string" ? el.className : (el.getAttribute("class") || null),
    text: (el.textContent || "").trim().slice(0, 120) || null,
    domPath: buildDomPath(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

export function startPicker(onPick) {
  let current = null;

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

  function onMove(e) {
    const hit = skipOwnUI(document.elementFromPoint(e.clientX, e.clientY));
    current = hit;
    if (hit) place(hit); else { box.style.display = "none"; label.style.display = "none"; }
  }

  function suppress(e) {
    // Capture-phase block so marking never reaches the app (rule 1).
    e.preventDefault(); e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onClick(e) {
    suppress(e);
    const hit = skipOwnUI(document.elementFromPoint(e.clientX, e.clientY)) || current;
    cleanup();
    onPick(hit ? captureContext(hit) : null);
  }

  function onKey(e) {
    if (e.key === "Escape") { suppress(e); cleanup(); onPick(null); }
  }

  function cleanup() {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("mousedown", suppress, true);
    window.removeEventListener("pointerdown", suppress, true);
    window.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = prevCursor;
    box.remove(); label.remove();
  }

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("mousedown", suppress, true);   // stop focus/nav side effects pre-click
  window.addEventListener("pointerdown", suppress, true);
  window.addEventListener("keydown", onKey, true);
}
