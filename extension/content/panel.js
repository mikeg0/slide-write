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

// Built-in fallback model list — used until /meta (which advertises the shim's allowlist) arrives,
// or when the shim is unreachable. Kept in sync with the shim's MODELS.
const FALLBACK_MODELS = [
  { id: "claude-opus-4-8",           label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export function createPanel({ root, shimUrl, token, meta, model, onMarkup, onOpenOptions, onSelectModel, autoReload, configured }) {
  // Live config — reassignable via api.setConfig so enabling the origin in Options flips the panel
  // from its disabled "set up" state to live, with no page reload.
  let cfg = { shimUrl, token, meta, autoReload: !!autoReload, configured: !!configured };
  // Model selection state. `models` is the menu list (server-driven via /meta, else fallback);
  // `selectedModel` is the chosen id sent with each /design request and persisted by inject.js.
  let models = (meta && Array.isArray(meta.models) && meta.models.length) ? meta.models : FALLBACK_MODELS;
  let selectedModel = model || (meta && meta.defaultModel) || models[0].id;
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
    placeholder: "Describe what you want to create…",
    onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } },
  });

  // Model selector — a text button (current model + chevron) over a menu that opens upward.
  const modelLabel = el("span", { class: "dmsg-modellabel" });
  const modelBtn = el("button", { class: "dmsg-model", title: "Choose model" }, [
    modelLabel, el("span", { class: "dmsg-chevron", text: "▾" }),
  ]);
  modelBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleModelMenu(); });
  const modelMenu = el("div", { class: "dmsg-modelmenu", hidden: "" });

  const sendIcon = el("span", { class: "dmsg-sendicon", text: "➤" });
  const sendLabel = el("span", { class: "dmsg-sendlabel", text: "Send" });
  const sendBtn = el("button", { class: "dmsg-send", title: "Send (⌘/Ctrl+Enter)", onclick: () => send() }, [sendIcon, sendLabel]);

  const toolbar = el("div", { class: "dmsg-toolbar" }, [
    el("div", { class: "dmsg-modelwrap" }, [modelMenu, modelBtn]),
    sendBtn,
  ]);
  const inputCard = el("div", { class: "dmsg-inputcard" }, [textarea, toolbar]);
  const composer = el("div", { class: "dmsg-composer" }, [ctxChip, inputCard]);

  // Render the model button label + menu items to reflect `models` / `selectedModel`.
  function renderModels() {
    const cur = models.find((m) => m.id === selectedModel);
    modelLabel.textContent = cur ? cur.label : (selectedModel || "Model");
    modelMenu.textContent = "";
    for (const m of models) {
      const active = m.id === selectedModel;
      modelMenu.append(el("button", {
        class: `dmsg-modelitem${active ? " dmsg-modelitem-active" : ""}`,
        onclick: (e) => { e.stopPropagation(); selectModel(m.id); },
      }, [
        el("span", { class: "dmsg-modelitem-label", text: m.label }),
        active ? el("span", { class: "dmsg-modelitem-check", text: "✓" }) : null,
      ]));
    }
  }
  function toggleModelMenu(force) {
    const open = force != null ? force : modelMenu.hidden;
    modelMenu.hidden = !open;
    modelBtn.classList.toggle("dmsg-model-open", open);
  }
  function selectModel(id) {
    selectedModel = id;
    renderModels();
    toggleModelMenu(false);
    onSelectModel && onSelectModel(id);   // persist per-origin (inject.js → background store)
  }
  // Close the menu on any click elsewhere (composed clicks from inside the shadow root that should
  // keep it open call stopPropagation, so they never reach here) and on Esc before it closes the
  // whole panel.
  document.addEventListener("click", () => toggleModelMenu(false));
  composer.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modelMenu.hidden) { e.stopPropagation(); toggleModelMenu(false); }
  });
  renderModels();

  // First-run / unconfigured state: the panel still slides out, but instead of a live composer it
  // shows a prompt + a big button into Options. Hidden once the origin is wired up.
  const setup = el("div", { class: "dmsg-setup", hidden: "" }, [
    el("div", { class: "dmsg-setup-title", text: "Connect this app to an agent" }),
    el("p", { class: "dmsg-setup-text", text: "This origin isn’t wired up yet. Add the agent URL and token to start editing the running app." }),
    el("button", { class: "dmsg-setup-btn", text: "⚙️  Open settings", onclick: () => onOpenOptions && onOpenOptions() }),
  ]);

  const panel = el("div", { class: "dmsg-panel", "data-slidewrite-ui": "" }, [header, setup, transcript, composer]);
  root.append(panel);

  applyConfigured();

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
        if (cfg.autoReload) { setStatus("reloading…"); setTimeout(() => location.reload(), 400); }
        break;
      case "commit_error": addRow(el("div", { class: "dmsg-row dmsg-error", text: `commit error: ${ev.message}` })); break;
      case "error":   addRow(el("div", { class: "dmsg-row dmsg-error", text: ev.message })); break;
      case "aborted": addRow(el("div", { class: "dmsg-row dmsg-note", text: "stream ended" })); break;
      case "done":    setBusy(false); setStatus(cfg.meta ? `wired to ${cfg.meta.project} @ ${cfg.meta.branch}` : "idle"); break;
      default: break; // unknown types are ignored (forward-compatible, §6)
    }
  }

  function setBusy(b) {
    busy = b;
    textarea.disabled = b || !cfg.configured;
    sendLabel.textContent = b ? "Cancel" : "Send";
    sendIcon.textContent = b ? "■" : "➤";
    sendBtn.title = b ? "Cancel run" : "Send (⌘/Ctrl+Enter)";
    sendBtn.classList.toggle("dmsg-busy", b);
  }

  // Reflect cfg.configured across the UI: live composer vs. the "set up" prompt.
  function applyConfigured() {
    const ok = cfg.configured;
    setup.hidden = ok;
    transcript.hidden = !ok;
    composer.hidden = !ok;
    markupBtn.disabled = !ok;
    textarea.disabled = busy || !ok;
    sendBtn.disabled = !ok;
    setStatus(ok ? (cfg.meta ? `wired to ${cfg.meta.project} @ ${cfg.meta.branch}` : "not connected") : "not configured");
  }

  async function send() {
    if (busy) { controller && controller.abort(); return; }
    if (!cfg.configured) return;
    const prompt = textarea.value.trim();
    if (!prompt) return;
    const payload = { prompt, screen: location.pathname + location.search, model: selectedModel };
    if (elementCtx) payload.element = elementCtx;
    addRow(el("div", { class: "dmsg-bubble dmsg-user" }, [el("div", { class: "dmsg-bubbletext", text: prompt })]));
    textarea.value = "";
    clearElementContext();
    setBusy(true);
    controller = new AbortController();
    try {
      await streamDesign(cfg.shimUrl, cfg.token, payload, onEvent, controller.signal);
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
    // Reflect picker (markup) mode on the 🎯 button so it reads as toggled-on while picking.
    setMarkupActive(on) {
      markupBtn.classList.toggle("dmsg-iconbtn-active", on);
      markupBtn.title = on ? "Picking… (Esc to cancel)" : "Pick an element";
    },
    isBusy: () => busy,
    // Live-update config (e.g. after the origin is enabled in Options) without remounting. Also
    // refreshes the model list from a freshly-fetched /meta and keeps the selection valid.
    setConfig(next) {
      cfg = { ...cfg, ...next, configured: !!next.configured };
      if (next.meta && Array.isArray(next.meta.models) && next.meta.models.length) models = next.meta.models;
      if (next.model && models.some((m) => m.id === next.model)) selectedModel = next.model;
      if (!models.some((m) => m.id === selectedModel)) selectedModel = (next.meta && next.meta.defaultModel) || models[0].id;
      renderModels();
      applyConfigured();
    },
  };
  return api;
}
