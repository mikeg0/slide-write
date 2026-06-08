// Slide Write — chat panel: transcript + composer. Renders the §6 SSE event contract.
// Free-to-implement UI; the contract it honors is fixed: each event `type` maps to a row, and
// consecutive same-role streaming deltas coalesce into one bubble (tool/result rows break the chain).
import { streamDesign } from "./sse.js";

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtUsd = (u) => (u == null ? "" : `$${u.toFixed(4)}`);
function tokens(usage) {
  if (!usage) return "";
  const i = usage.input_tokens || 0, o = usage.output_tokens || 0;
  const c = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return `${i + c} in / ${o} out`;
}

// Width of the right-hand drawer, kept in sync with `.dmsg-panel` in styles.css. Used to push the
// host page over by the same amount when the drawer opens.
const PANEL_WIDTH = 390;

// Inject (once) a light-DOM rule that shifts the app's <html> left while the drawer is open, so the
// whole page slides over instead of being covered. Lives outside the shadow root because it must
// affect the host page; scoped to a data attribute we toggle, and skipped on narrow viewports where
// the drawer overlays full-width instead.
function ensurePushStyle() {
  if (document.getElementById("slidewrite-push-style")) return;
  const s = document.createElement("style");
  s.id = "slidewrite-push-style";
  s.textContent =
    `html{transition:margin-right .28s cubic-bezier(.4,0,.2,1)}` +
    `@media (min-width:700px){html[data-slidewrite-open]{margin-right:${PANEL_WIDTH}px !important}}`;
  (document.head || document.documentElement).append(s);
}

export function createPanel({ root, shimUrl, token, meta, onMarkup, onOpenOptions, autoReload }) {
  let busy = false;
  let controller = null;
  let elementCtx = null;            // §7 element context (set by the picker in Phase 5)
  let stream = { role: null, body: null };  // current coalescing bubble

  const status = el("span", { class: "dmsg-status" });
  const markupBtn = el("button", {
    class: "dmsg-iconbtn", title: "Pick an element", text: "🎯",
    onclick: () => onMarkup && onMarkup(),
  });
  const settingsBtn = el("button", {
    class: "dmsg-iconbtn", title: "Options", text: "⚙️",
    onclick: () => onOpenOptions && onOpenOptions(),
  });
  const header = el("div", { class: "dmsg-header" }, [
    el("span", { class: "dmsg-title", text: "Slide Write" }),
    status,
    markupBtn,
    settingsBtn,
    el("button", { class: "dmsg-iconbtn", title: "Close (Esc)", text: "✕", onclick: () => api.close() }),
  ]);
  const transcript = el("div", { class: "dmsg-transcript" });
  const ctxChip = el("div", { class: "dmsg-chip", hidden: "" });
  const textarea = el("textarea", {
    class: "dmsg-input", rows: "3",
    placeholder: "Describe a change… (⌘/Ctrl+Enter to send)",
    onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } },
  });
  const sendBtn = el("button", { class: "dmsg-send", text: "Send", onclick: () => send() });
  const composer = el("div", { class: "dmsg-composer" }, [ctxChip, textarea, sendBtn]);
  const panel = el("div", { class: "dmsg-panel", "data-slidewrite-ui": "" }, [header, transcript, composer]);
  root.append(panel);

  setStatus(meta ? `wired to ${meta.project} @ ${meta.branch}` : "not connected");

  function setStatus(t) { status.textContent = t; }
  function scroll() { transcript.scrollTop = transcript.scrollHeight; }
  function addRow(node) { breakChain(); transcript.append(node); scroll(); return node; }
  function breakChain() { stream = { role: null, body: null }; }

  function appendDelta(role, text) {
    if (stream.role !== role || !stream.body) {
      const body = el("div", { class: "dmsg-bubbletext" });
      const bubble = el("div", { class: `dmsg-bubble dmsg-${role}` }, [body]);
      transcript.append(bubble);
      stream = { role, body };
    }
    stream.body.append(document.createTextNode(text));
    scroll();
  }

  function toolRow(label, detail, cls = "dmsg-tool") {
    return addRow(el("div", { class: `dmsg-row ${cls}` }, [
      el("span", { class: "dmsg-toolname", text: label }),
      detail ? el("code", { class: "dmsg-detail", text: detail }) : null,
    ]));
  }

  function resultRow(tool, text, isError, truncated) {
    const details = el("details", { class: `dmsg-row dmsg-result ${isError ? "dmsg-error" : ""}` });
    if (isError) details.setAttribute("open", "");
    details.append(
      el("summary", { text: `${tool || "tool"} output${truncated ? " (truncated)" : ""}${isError ? " — error" : ""}` }),
      el("pre", { class: "dmsg-pre", text: text || "(empty)" }),
    );
    return addRow(details);
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "start":   setStatus(`running · ${ev.model || ""}`); break;
      case "delta":   appendDelta("assistant", ev.text); break;
      case "thinking_delta": appendDelta("thinking", ev.text); break;
      case "tool":    toolRow(ev.tool, ev.detail); break;
      case "file_edit": toolRow(`✏️ ${ev.tool}`, ev.path, "dmsg-edit"); break;
      case "tool_result": resultRow(ev.tool, ev.text, ev.isError, ev.truncated); break;
      case "result": {
        const bits = [
          ev.numTurns != null ? `${ev.numTurns} turns` : null,
          fmtMs(ev.durationMs), tokens(ev.usage), fmtUsd(ev.totalCostUsd),
        ].filter(Boolean).join(" · ");
        if (ev.result) appendDelta("assistant", ev.result); // final-text fallback if no deltas streamed
        addRow(el("div", { class: "dmsg-row dmsg-stats", text: bits }));
        break;
      }
      case "commit":
        addRow(el("div", { class: "dmsg-row dmsg-commit", text: `✓ Committed ${ev.sha} · ${ev.count} file${ev.count === 1 ? "" : "s"}` }));
        if (autoReload) { setStatus("reloading…"); setTimeout(() => location.reload(), 400); }
        break;
      case "commit_error": addRow(el("div", { class: "dmsg-row dmsg-error", text: `commit error: ${ev.message}` })); break;
      case "error":   addRow(el("div", { class: "dmsg-row dmsg-error", text: ev.message })); break;
      case "aborted": addRow(el("div", { class: "dmsg-row dmsg-note", text: "stream ended" })); break;
      case "done":    setBusy(false); setStatus(meta ? `wired to ${meta.project} @ ${meta.branch}` : "idle"); break;
      default: break; // unknown types are ignored (forward-compatible, §6)
    }
  }

  function setBusy(b) {
    busy = b;
    textarea.disabled = b;
    sendBtn.textContent = b ? "Cancel" : "Send";
    sendBtn.classList.toggle("dmsg-busy", b);
  }

  async function send() {
    if (busy) { controller && controller.abort(); return; }
    const prompt = textarea.value.trim();
    if (!prompt) return;
    const payload = { prompt, screen: location.pathname + location.search };
    if (elementCtx) payload.element = elementCtx;
    addRow(el("div", { class: "dmsg-bubble dmsg-user" }, [el("div", { class: "dmsg-bubbletext", text: prompt })]));
    textarea.value = "";
    clearElementContext();
    setBusy(true);
    controller = new AbortController();
    try {
      await streamDesign(shimUrl, token, payload, onEvent, controller.signal);
    } catch (e) {
      if (e.name !== "AbortError") onEvent({ type: "error", message: String(e.message || e) });
    } finally {
      setBusy(false);
      controller = null;
    }
  }

  function setElementContext(ctx) {
    elementCtx = ctx;
    const label = [ctx.tag, ctx.id ? `#${ctx.id}` : "", ctx.className ? `.${String(ctx.className).split(/\s+/).join(".")}` : ""].join("");
    ctxChip.textContent = "";
    ctxChip.append(
      el("span", { class: "dmsg-chiptext", text: `🎯 ${label || "element"}${ctx.text ? ` — "${ctx.text.slice(0, 40)}"` : ""}` }),
      el("button", { class: "dmsg-iconbtn", text: "✕", title: "Clear", onclick: () => clearElementContext() }),
    );
    ctxChip.hidden = false;
    textarea.focus();
  }
  function clearElementContext() { elementCtx = null; ctxChip.hidden = true; ctxChip.textContent = ""; }

  ensurePushStyle();

  const api = {
    el: panel,
    isOpen: () => panel.classList.contains("dmsg-open"),
    open() {
      panel.classList.add("dmsg-open");
      document.documentElement.toggleAttribute("data-slidewrite-open", true); // push the page left
      textarea.focus();
    },
    close() {
      panel.classList.remove("dmsg-open");
      document.documentElement.toggleAttribute("data-slidewrite-open", false);
    },
    toggle() { api.isOpen() ? api.close() : api.open(); },
    setElementContext,
    isBusy: () => busy,
  };
  return api;
}
