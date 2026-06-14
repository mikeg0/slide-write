// Slide Write — chat panel: transcript + composer. Renders the §6 SSE event contract.
// Free-to-implement UI; the contract it honors is fixed: each event `type` maps to a row, and
// consecutive same-role streaming deltas coalesce into one bubble (tool/result rows break the chain).
import { streamDesign, fetchHistory, fetchHistoryDetail } from "./sse.js";

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

// Minimal, self-contained markdown → HTML renderer for assistant/thinking bubbles. No deps (CSP-
// safe). Everything is HTML-escaped first, so the only HTML we ever emit is the tags we generate;
// link hrefs are scheme-checked. Re-run on every delta against the full accumulated text — partial
// fences/spans mid-stream just settle once the closing token arrives.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderInline(s) {
  // s is already HTML-escaped. Protect inline-code spans so their contents aren't re-formatted.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    return /^(https?:|mailto:)/i.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}
function renderMarkdown(src) {
  // CommonMark §2.3: replace U+0000 in input with U+FFFD. Also guarantees input can never collide
  // with renderInline's U+0000 sentinel.
  src = src.replace(/\u0000/g, "\uFFFD");
  const lines = escapeHtml(src).split("\n");
  const out = [];
  let i = 0, list = null; // list = "ul" | "ol" | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      closeList();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; // skip closing fence
      out.push(`<pre class="dmsg-md-pre"><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const n = heading[1].length;
      out.push(`<h${n}>${renderInline(heading[2])}</h${n}>`);
      i++; continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${renderInline((ul || ol)[1])}</li>`);
      i++; continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    // Paragraph: gather consecutive plain lines, join with <br>.
    closeList();
    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
           !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i])) {
      para.push(renderInline(lines[i])); i++;
    }
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  closeList();
  return out.join("");
}

const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtUsd = (u) => (u == null ? "" : `$${u.toFixed(4)}`);
const fmtTok = (n) => (n < 1000 ? `${n}` : n < 100000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);
function tokens(usage) {
  if (!usage) return "";
  const i = usage.input_tokens || 0, o = usage.output_tokens || 0;
  const c = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return `${i + c} in / ${o} out`;
}
function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString();
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
  { id: "claude-fable-5",            label: "Claude Fable 5" },
  { id: "claude-opus-4-8",           label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export function createPanel({ root, shimUrl, token, meta, conn, model, onMarkup, onOpenOptions, onProbe, onSelectModel, autoReload, autoCommit, configured, geminiKey, pollInterval, imageInstructions }) {
  // Live config — reassignable via api.setConfig so enabling the origin in Options flips the panel
  // from its disabled "set up" state to live, with no page reload.
  let cfg = { shimUrl, token, meta, conn: conn || { state: null }, autoReload: !!autoReload,
    autoCommit: autoCommit !== false, configured: !!configured,
    geminiKey: geminiKey || "", pollInterval: pollInterval || 0, imageInstructions: imageInstructions || "" };
  // Model selection state. `models` is the menu list (server-driven via /meta, else fallback);
  // `selectedModel` is the chosen id sent with each /design request and persisted by inject.js.
  let models = (meta && Array.isArray(meta.models) && meta.models.length) ? meta.models : FALLBACK_MODELS;
  let selectedModel = model || (meta && meta.defaultModel) || models[0].id;
  let busy = false;
  let controller = null;
  let filesChangedThisRun = false;  // any file_edit this run → auto-reload-on-save reloads at `done`
  // Run-status spinner state: while busy, the status bar shows an animated frame + the current run
  // phase + a live token count fed by the §6 `usage` events (output + in-flight thinking estimate).
  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinTimer = null, spinIdx = 0;
  let runLabel = "", runModel = "", runTokens = null, runTokensEst = 0;
  const MAX_ELEMENTS = 5;           // stacked-picks cap, so the prompt/context window stays sane
  let elementCtxs = [];             // §7 element contexts (the picker appends; ≤ MAX_ELEMENTS)
  let imageMode = false;            // when true, the next send generates an image into the picked element(s)
  let resumeId = null;              // when set, each send continues this past session
  let liveResumeId = null;          // live chat's session, stashed while a history detail owns resumeId
  let inHistoryDetail = false;      // viewing one past session (composer sends resume into it)
  let stream = { role: null, body: null };  // current coalescing bubble
  let target;                       // where rows render — the live transcript, or a history pane

  const status = el("span", { class: "dmsg-status" });
  const markupBtn = el("button", {
    class: "dmsg-iconbtn", title: "Pick an element", text: "🎯",
    onclick: () => {
      if (elementCtxs.length >= MAX_ELEMENTS) { setStatus(`element limit reached (${MAX_ELEMENTS} max)`); return; }
      onMarkup && onMarkup();
    },
  });
  const newChatBtn = el("button", {
    class: "dmsg-iconbtn", title: "New chat", text: "＋",
    onclick: () => newChat(),
  });
  const historyBtn = el("button", {
    class: "dmsg-iconbtn", title: "Chat history", text: "🕘",
    onclick: () => openHistory(),
  });
  const settingsBtn = el("button", {
    class: "dmsg-iconbtn", title: "Options", text: "⚙️",
    onclick: () => onOpenOptions && onOpenOptions(),
  });
  const header = el("div", { class: "dmsg-header" }, [
    el("span", { class: "dmsg-title", text: "Slide Write" }),
    markupBtn,
    newChatBtn,
    historyBtn,
    settingsBtn,
    el("button", { class: "dmsg-iconbtn", title: "Close (Esc)", text: "✕", onclick: () => api.close() }),
  ]);
  // Status bar — a muted line directly under the header. Normally shows the "wired to <project>"
  // connection state; while a header button is hovered it borrows that button's tooltip text, then
  // reverts on mouse-out. Hover is handled by delegation so it tracks dynamic titles (e.g. the 🎯
  // button's "Picking…" label) at the moment of hover.
  const statusbar = el("div", { class: "dmsg-statusbar" }, [status]);
  header.addEventListener("mouseover", (e) => {
    const btn = e.target.closest && e.target.closest("button[title]");
    if (btn) setHoverHelp(btn.getAttribute("title"));
  });
  header.addEventListener("mouseout", (e) => {
    const btn = e.target.closest && e.target.closest("button[title]");
    if (btn) setHoverHelp(null);
  });
  const transcript = el("div", { class: "dmsg-transcript" });
  target = transcript;
  // History pane (list of past sessions, or a read-only replay of one) — shown in place of the
  // transcript+composer; everything stays inside the shadow root.
  const historyView = el("div", { class: "dmsg-history", hidden: "" });
  // Picked elements render as a stack of chips (one identity chip + optional screenshot chip each),
  // each individually removable — re-rendered wholesale by renderChips().
  const ctxChips = el("div", { class: "dmsg-chips", hidden: "" });
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

  // "+" composer menu — toggles per-message modes (currently Image Generation). Opens upward like
  // the model menu. The Image Generation item is a checkbox-style toggle: when on, the next send
  // routes to /generate-image and places the result onto the selected element (img src or div
  // background, per the element type — the shim decides).
  const plusBtn = el("button", { class: "dmsg-plus", title: "Add to message", text: "＋" });
  plusBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePlusMenu(); });
  const plusMenu = el("div", { class: "dmsg-plusmenu", hidden: "" });

  const toolbar = el("div", { class: "dmsg-toolbar" }, [
    el("div", { class: "dmsg-toolbar-left" }, [
      el("div", { class: "dmsg-pluswrap" }, [plusMenu, plusBtn]),
      el("div", { class: "dmsg-modelwrap" }, [modelMenu, modelBtn]),
    ]),
    sendBtn,
  ]);
  const inputCard = el("div", { class: "dmsg-inputcard" }, [textarea, toolbar]);
  const composer = el("div", { class: "dmsg-composer" }, [ctxChips, inputCard]);

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

  // Render the "+" menu items, reflecting current toggle state (Image Generation = imageMode).
  function renderPlusMenu() {
    plusMenu.textContent = "";
    plusMenu.append(el("button", {
      class: `dmsg-menuitem${imageMode ? " dmsg-menuitem-active" : ""}`,
      onclick: (e) => { e.stopPropagation(); setImageMode(!imageMode); togglePlusMenu(false); },
    }, [
      el("span", { class: "dmsg-menuitem-label", text: "🖼️  Image Generation" }),
      imageMode ? el("span", { class: "dmsg-menuitem-check", text: "✓" }) : null,
    ]));
  }
  function togglePlusMenu(force) {
    const open = force != null ? force : plusMenu.hidden;
    if (open) renderPlusMenu();
    plusMenu.hidden = !open;
    plusBtn.classList.toggle("dmsg-plus-open", open);
  }
  // Flip image mode on/off and reflect it in the composer (placeholder, element chip icons, the
  // "+" button's active styling). Sticky until toggled off or reset after a send.
  function setImageMode(on) {
    imageMode = !!on;
    plusBtn.classList.toggle("dmsg-plus-active", imageMode);
    renderPlaceholder();
    if (elementCtxs.length) renderChips();
    renderPlusMenu();
  }
  function renderPlaceholder() {
    textarea.placeholder = imageMode ? "Describe the image to generate…"
      : inHistoryDetail ? "Continue this conversation…"
      : "Describe what you want to create…";
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
  document.addEventListener("click", () => { toggleModelMenu(false); togglePlusMenu(false); });
  composer.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!modelMenu.hidden) { e.stopPropagation(); toggleModelMenu(false); }
    else if (!plusMenu.hidden) { e.stopPropagation(); togglePlusMenu(false); }
  });
  renderModels();
  renderPlusMenu();

  // First-run / unconfigured state: the panel still slides out, but instead of a live composer it
  // shows a prompt + a big button into Options. Hidden once the origin is wired up.
  const setup = el("div", { class: "dmsg-setup", hidden: "" }, [
    el("div", { class: "dmsg-setup-title", text: "Connect this app to an agent" }),
    el("p", { class: "dmsg-setup-text", text: "This origin isn’t wired up yet. Add the agent URL and token to start editing the running app." }),
    el("button", { class: "dmsg-setup-btn", text: "⚙️  Open settings", onclick: () => onOpenOptions && onOpenOptions() }),
  ]);

  // Disconnected diagnostics — shown when the origin IS configured but the shim isn't answering as
  // expected. Distinguishes "shim down / not forwarded" (unreachable, with a copy-pasteable start
  // command) from "token rejected" (unauthorized, → Options). Replaces the old flat "not connected".
  const diagTitle = el("div", { class: "dmsg-diag-title" });
  const diagText = el("p", { class: "dmsg-diag-text" });
  // Two start commands — the Node reference shim and the stdlib-only Python port (hosts without
  // Node). Each is its own copy-pasteable panel with a label.
  const diagCodeNode = el("code", { class: "dmsg-diag-code" });
  const diagCodePy = el("code", { class: "dmsg-diag-code" });
  const diagCodes = el("div", { class: "dmsg-diag-clis", hidden: "" }, [
    el("div", { class: "dmsg-diag-cli" }, [
      el("div", { class: "dmsg-diag-cli-label", text: "Node" }),
      diagCodeNode,
    ]),
    el("div", { class: "dmsg-diag-cli" }, [
      el("div", { class: "dmsg-diag-cli-label", text: "Python" }),
      diagCodePy,
    ]),
  ]);
  const diagRetry = el("button", { class: "dmsg-diag-btn", text: "↻ Retry", onclick: () => reprobe() });
  const diagSettings = el("button", { class: "dmsg-diag-btn dmsg-diag-btn-ghost", text: "⚙️ Options", onclick: () => onOpenOptions && onOpenOptions() });
  const diag = el("div", { class: "dmsg-diag", hidden: "" }, [
    diagTitle, diagText, diagCodes,
    el("div", { class: "dmsg-diag-actions" }, [diagRetry, diagSettings]),
  ]);

  const panel = el("div", { class: "dmsg-panel", "data-slidewrite-ui": "" }, [header, statusbar, diag, setup, transcript, historyView, composer]);
  root.append(panel);

  // Status text is two layers: `baseStatus` is the persistent connection/run state (set via
  // setStatus); `hoverHelp`, when non-null, temporarily overrides it with a hovered button's tooltip.
  let baseStatus = "";
  let hoverHelp = null;
  function renderStatus() { status.textContent = hoverHelp != null ? hoverHelp : baseStatus; }
  function setStatus(t) { baseStatus = t; renderStatus(); }
  function setHoverHelp(t) { hoverHelp = t; renderStatus(); }

  const shimHost = () => { try { return new URL(cfg.shimUrl).host; } catch { return cfg.shimUrl; } };
  const shimPort = () => { try { return new URL(cfg.shimUrl).port || "4040"; } catch { return "4040"; } };
  // The persistent status line, derived from the probed connection state (see inject.js `probe`).
  function idleStatus() {
    if (!cfg.configured) return "not configured";
    const st = cfg.conn && cfg.conn.state;
    if (st === "live" || (!st && cfg.meta)) return cfg.meta ? `wired to ${cfg.meta.project} @ ${cfg.meta.branch}` : "connected";
    if (st === "unauthorized") return "agent rejected the token — check Options";
    if (st === "unreachable") return `agent offline — can't reach ${shimHost()}`;
    return "not connected";
  }
  // Reflect the connection state in the status line + the diagnostics banner. Skipped mid-run (the
  // run owns the status line then); the banner still updates so a mid-run drop is visible.
  function renderConn() {
    if (!busy) setStatus(idleStatus());
    const st = cfg.conn && cfg.conn.state;
    const show = cfg.configured && st && st !== "live";
    diag.hidden = !show;
    if (!show) return;
    if (st === "unauthorized") {
      diagTitle.textContent = "Agent rejected the token";
      diagText.textContent = `The agent at ${shimHost()} is running but returned 401 Unauthorized. Open Options and set the token to match the shim's --token value.`;
      diagCodes.hidden = true;
      diagSettings.hidden = false;
    } else {
      diagTitle.textContent = "Can't reach the agent";
      diagText.textContent = `Slide Write couldn't connect to the agent at ${shimHost()}. Check that the shim is running on the code machine and — in remote dev — that the port is forwarded (VS Code → Ports). Start it with:`;
      const tail = `--repo <path> --port ${shimPort()} --origin ${location.origin} --token <secret>`;
      diagCodeNode.textContent = `node shim/slide-write.mjs ${tail}`;
      diagCodePy.textContent = `python3 shim/slide-write.py ${tail}`;
      diagCodes.hidden = false;
      diagSettings.hidden = true;
    }
  }
  // Re-check the connection on demand (panel open, poll tick, after a failed send) and update the UI.
  let probing = false;
  async function reprobe() {
    if (!cfg.configured || !onProbe || probing) return;
    probing = true;
    try {
      const p = await onProbe(cfg.shimUrl, cfg.token);
      if (!p) return;
      cfg.conn = { state: p.state, detail: p.detail };
      if (p.meta) {
        cfg.meta = p.meta;
        if (Array.isArray(p.meta.models) && p.meta.models.length) { models = p.meta.models; renderModels(); }
      }
      if (historyView.hidden) renderConn();
    } finally { probing = false; }
  }
  // Light liveness polling — only while the panel is OPEN, so closed tabs add no background churn.
  // A cheap GET /health + /meta flips the status as the shim goes up/down. Cadence is the global
  // Options setting (seconds; 0/unset → 5s default), floored at 1s.
  let pollTimer = null;
  const pollMs = () => Math.max(1, cfg.pollInterval || 5) * 1000;
  function startPolling() { if (pollTimer || !cfg.configured) return; pollTimer = setInterval(() => { if (!busy) reprobe(); }, pollMs()); }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  applyConfigured();
  // Stick-to-bottom: follow the stream only while the user is at (or within SCROLL_SLACK of) the
  // bottom. Scrolling up detaches; scrolling back down re-attaches. Pinned-ness is measured BEFORE
  // each append — measuring after would unpin on any row taller than the slack.
  const SCROLL_SLACK = 40;
  function atBottom() { return target.scrollHeight - target.scrollTop - target.clientHeight <= SCROLL_SLACK; }
  function scroll() { target.scrollTop = target.scrollHeight; }
  function addRow(node) {
    breakChain();
    const stick = atBottom();
    target.append(node);
    if (stick) scroll();
    return node;
  }
  function breakChain() { stream = { role: null, body: null }; }

  function appendDelta(role, text) {
    const md = role === "assistant" || role === "thinking";
    const stick = atBottom();
    if (stream.role !== role || !stream.body) {
      const body = el("div", { class: `dmsg-bubbletext${md ? " dmsg-md" : ""}` });
      const bubble = el("div", { class: `dmsg-bubble dmsg-${role}` }, [body]);
      target.append(bubble);
      stream = { role, body, raw: "" };
    }
    if (md) {
      // Re-render the full accumulated text each delta so markdown blocks (lists, fences) close
      // correctly as more text streams in. User input stays literal (plain text node).
      stream.raw += text;
      stream.body.innerHTML = renderMarkdown(stream.raw);
    } else {
      stream.body.append(document.createTextNode(text));
    }
    if (stick) scroll();
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
      case "start":
        runModel = ev.model || "";
        filesChangedThisRun = false;
        setPhase("running");
        // Adopt the session id so chained sends keep threading into the same conversation
        // (also tracks forks while resuming inside a history detail — replay routes here too).
        if (ev.sessionId && ev.sessionId !== resumeId) resumeId = ev.sessionId;
        break;
      case "image_status":
        runLabel = ev.state === "generating" ? "generating image…" : "image";
        renderRunStatus();
        break;
      case "usage":
        // Cumulative live counter — outputTokens is authoritative (per completed API call);
        // thinkingTokens is the shim's estimate for thinking still in flight. The authoritative
        // count includes everything streamed so far, so drop the client-side delta estimate.
        runTokens = (ev.outputTokens || 0) + (ev.thinkingTokens || 0);
        runTokensEst = 0;
        renderRunStatus();
        break;
      case "image_generated": toolRow("🖼️ image generated", ev.mimeType || ""); break;
      case "user":    appendDelta("user", ev.text); break;
      case "delta":   if (busy) setPhase("responding"); appendDelta("assistant", ev.text); estTokens(ev.text); break;
      case "thinking_delta": if (busy) setPhase("thinking"); appendDelta("thinking", ev.text); estTokens(ev.text); break;
      case "tool":    if (busy) setPhase("working"); toolRow(ev.tool, ev.detail); break;
      case "file_edit": if (busy) { setPhase("editing"); filesChangedThisRun = true; } toolRow(`✏️ ${ev.tool}`, ev.path, "dmsg-edit"); break;
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
        break;
      case "commit_error": addRow(el("div", { class: "dmsg-row dmsg-error", text: `commit error: ${ev.message}` })); break;
      case "error":   addRow(el("div", { class: "dmsg-row dmsg-error", text: ev.message })); break;
      case "aborted": addRow(el("div", { class: "dmsg-row dmsg-note", text: "stream ended" })); break;
      case "done":
        setBusy(false); setStatus(idleStatus());
        // Auto-reload-on-save: any file changed this run → reload once the run is done (reloading
        // mid-run would tear down the content-script SSE stream). Decoupled from `commit` so it
        // still fires when auto-commit is off.
        if (cfg.autoReload && filesChangedThisRun) { setStatus("reloading…"); setTimeout(() => location.reload(), 400); }
        break;
      default: break; // unknown types are ignored (forward-compatible, §6)
    }
  }

  // Tick the live counter between authoritative `usage` events: ~4 chars/token for streamed text.
  // No render call — the 120ms spinner tick picks it up, which throttles updates for free. Busy-
  // gated so history replay (which routes deltas through onEvent too) never touches the counter.
  function estTokens(text) {
    if (busy && text) runTokensEst += text.length / 4;
  }

  // The status verb tracks the live run phase, derived from the SSE stream: `start` → running,
  // then thinking_delta/delta/tool/file_edit flip it to thinking/responding/working/editing as
  // Claude moves through the turn. The model suffix stays stable across phase changes. Flips other
  // than `start` are busy-gated so history replay (which also routes through onEvent) doesn't churn.
  function setPhase(p) {
    runLabel = runModel ? `${p} · ${runModel}` : p;
    renderRunStatus();
  }

  // Compose the run-status line. Only spins while busy — history replay routes `start` through
  // onEvent too, and there it must render as plain text with no timer running.
  function renderRunStatus() {
    const n = (runTokens || 0) + Math.floor(runTokensEst);
    const toks = runTokens != null || runTokensEst ? ` · ${fmtTok(n)} tokens` : "";
    setStatus(busy ? `${SPIN[spinIdx]} ${runLabel || "starting…"}${toks}` : `${runLabel}${toks}`);
  }

  function setBusy(b) {
    busy = b;
    if (b && !spinTimer)
      spinTimer = setInterval(() => { spinIdx = (spinIdx + 1) % SPIN.length; renderRunStatus(); }, 120);
    if (!b) {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      runLabel = ""; runModel = ""; runTokens = null; runTokensEst = 0;
    }
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
    plusBtn.disabled = !ok;
    newChatBtn.disabled = !ok;
    historyBtn.disabled = !ok;
    textarea.disabled = busy || !ok;
    sendBtn.disabled = !ok;
    renderConn();
  }

  async function send() {
    if (busy) { controller && controller.abort(); return; }
    if (!cfg.configured) return;
    const prompt = textarea.value.trim();
    if (!prompt) return;
    // Capture image mode before clearElementContext() resets it.
    const image = imageMode;
    let payload, path;
    if (image) {
      payload = { imagePrompt: prompt, screen: location.pathname + location.search, model: selectedModel,
        geminiKey: cfg.geminiKey, imageInstructions: cfg.imageInstructions, autoCommit: cfg.autoCommit };
      // Strip the element screenshots — /generate-image uses imageDataUrl (the canvas-read source
      // pixels) for image-to-image; the screenshots would just bloat the payload.
      if (elementCtxs.length)
        payload.elements = elementCtxs.map(({ screenshotDataUrl, screenshotW, screenshotH, ...rest }) => rest);
      path = "/generate-image";
    } else {
      payload = { prompt, screen: location.pathname + location.search, model: selectedModel, autoCommit: cfg.autoCommit };
      // Drop imageDataUrl (only meaningful to /generate-image) and the UI-only screenshot dimensions,
      // but KEEP screenshotDataUrl — the shim writes each to a temp file for claude to Read.
      if (elementCtxs.length)
        payload.elements = elementCtxs.map(({ imageDataUrl, screenshotW, screenshotH, ...rest }) => rest);
      if (resumeId) payload.resume = resumeId;
      path = "/design";
    }
    addRow(el("div", { class: "dmsg-bubble dmsg-user" }, [el("div", { class: "dmsg-bubbletext", text: prompt })]));
    textarea.value = "";
    clearElementContext();
    setBusy(true);
    controller = new AbortController();
    try {
      await streamDesign(cfg.shimUrl, cfg.token, payload, onEvent, controller.signal, path);
    } catch (e) {
      // A network-level failure here ("Failed to fetch") usually means the shim went down mid-send —
      // re-probe so the diagnostics banner explains what's wrong instead of leaving a bare error row.
      if (e.name !== "AbortError") { onEvent({ type: "error", message: String(e.message || e) }); reprobe(); }
    } finally {
      setBusy(false);
      controller = null;
    }
  }

  const ctxLabel = (ctx) =>
    [ctx.tag, ctx.id ? `#${ctx.id}` : "", ctx.className ? `.${String(ctx.className).split(/\s+/).join(".")}` : ""].join("");
  // Re-render the whole element-chip stack: per picked element an identity chip (✕ removes that
  // element) and, when a capture was taken, a screenshot chip (thumbnail + dimensions + ✕; removing
  // it drops the pixels off that element so they're never sent). The icon reflects image mode
  // (🖼️ when image generation is on, else 🎯).
  function renderChips() {
    ctxChips.textContent = "";
    const icon = imageMode ? "🖼️" : "🎯";
    elementCtxs.forEach((ctx, i) => {
      ctxChips.append(el("div", { class: "dmsg-chip" }, [
        el("span", { class: "dmsg-chiptext", text: `${icon} ${ctxLabel(ctx) || "element"}${ctx.text ? ` — "${ctx.text.slice(0, 40)}"` : ""}` }),
        el("button", { class: "dmsg-iconbtn", text: "✕", title: "Remove element", onclick: () => removeElement(i) }),
      ]));
      if (ctx.screenshotDataUrl) ctxChips.append(el("div", { class: "dmsg-chip dmsg-shotchip" }, [
        el("img", { class: "dmsg-shotthumb", src: ctx.screenshotDataUrl, alt: "" }),
        el("span", { class: "dmsg-chiptext", text: `screenshot · ${ctx.screenshotW}×${ctx.screenshotH}` }),
        el("button", { class: "dmsg-iconbtn", text: "✕", title: "Remove screenshot — won’t be sent", onclick: () => clearScreenshot(i) }),
      ]));
    });
    ctxChips.hidden = !elementCtxs.length;
  }
  function removeElement(i) {
    elementCtxs.splice(i, 1);
    if (!elementCtxs.length) setImageMode(false);
    renderChips();
  }
  function clearScreenshot(i) {
    const ctx = elementCtxs[i];
    if (ctx) { delete ctx.screenshotDataUrl; delete ctx.screenshotW; delete ctx.screenshotH; }
    renderChips();
  }

  // Each pick STACKS onto the chat's targets (≤ MAX_ELEMENTS). Returns whether MORE picks are
  // allowed — false tells the caller (inject.js) to disarm the still-armed picker at the cap.
  // Keeps whatever image-mode toggle is currently set (the "+" menu), so picking-then-toggling and
  // toggling-then-picking both work.
  function addElementContext(ctx) {
    if (elementCtxs.length >= MAX_ELEMENTS) { setStatus(`element limit reached (${MAX_ELEMENTS} max)`); return false; }
    elementCtxs.push(ctx);
    renderChips();
    textarea.focus();
    if (elementCtxs.length >= MAX_ELEMENTS) { setStatus(`element limit reached (${MAX_ELEMENTS} max) — picker off`); return false; }
    return true;
  }
  function clearElementContext() {
    elementCtxs = [];
    setImageMode(false);
    renderChips();
  }

  // --- History & resume ----------------------------------------------------------------------
  function histBar(label, onBack, extra) {
    return el("div", { class: "dmsg-histbar" }, [
      el("button", { class: "dmsg-iconbtn", text: "←", title: "Back", onclick: onBack }),
      el("span", { class: "dmsg-histtitle", text: label }),
      extra || null,
    ]);
  }

  // Leaving a history detail: hand resumeId back to the live chat and re-point rendering at the
  // live transcript. No-op when no detail is open.
  function leaveHistoryDetail() {
    if (!inHistoryDetail) return;
    inHistoryDetail = false;
    resumeId = liveResumeId;
    liveResumeId = null;
    target = transcript;
    breakChain();
    renderPlaceholder();
  }

  // List this repo's past sessions in the history pane (hides the live transcript + composer).
  async function openHistory() {
    if (!cfg.configured) return;
    leaveHistoryDetail();
    transcript.hidden = true;
    composer.hidden = true;
    historyView.hidden = false;
    historyView.textContent = "";
    historyView.append(histBar("Chat history", () => showLive()));
    const note = el("div", { class: "dmsg-row dmsg-note", text: "Loading…" });
    historyView.append(note);
    try {
      const sessions = await fetchHistory(cfg.shimUrl, cfg.token);
      note.remove();
      if (!sessions.length) {
        historyView.append(el("div", { class: "dmsg-row dmsg-note", text: "No history for this repo yet." }));
        return;
      }
      const list = el("div", { class: "dmsg-histlist" });
      for (const s of sessions) {
        list.append(el("button", { class: "dmsg-histitem", onclick: () => openTranscript(s) }, [
          el("div", { class: "dmsg-histitem-top" }, [
            el("span", { class: "dmsg-histitem-title", text: s.title || "(untitled)" }),
            el("span", { class: "dmsg-histitem-time", text: relTime(s.endedAt) }),
          ]),
          s.firstPrompt ? el("div", { class: "dmsg-histitem-prompt", text: s.firstPrompt }) : null,
          el("div", { class: "dmsg-histitem-meta", text: [s.branch, `${s.messageCount} msg`].filter(Boolean).join(" · ") }),
        ]));
      }
      historyView.append(list);
    } catch (e) {
      note.remove();
      historyView.append(el("div", { class: "dmsg-row dmsg-error", text: String(e.message || e) }));
    }
  }

  // Replay one session through the live onEvent renderer into a history pane, with the composer
  // shown at the bottom — sends from here implicitly resume this conversation (rows keep rendering
  // into this pane; the live transcript and its session are stashed until you navigate back).
  async function openTranscript(s) {
    transcript.hidden = true;
    composer.hidden = false;
    historyView.hidden = false;
    historyView.textContent = "";
    historyView.append(histBar(s.title || "(untitled)", () => openHistory()));
    const body = el("div", { class: "dmsg-transcript dmsg-histbody" });
    historyView.append(body);
    const note = el("div", { class: "dmsg-row dmsg-note", text: "Loading…" });
    body.append(note);
    if (!inHistoryDetail) { liveResumeId = resumeId; inHistoryDetail = true; }
    resumeId = s.id;
    renderPlaceholder();
    target = body; breakChain();
    try {
      const events = await fetchHistoryDetail(cfg.shimUrl, cfg.token, s.id);
      note.remove();
      // Replayed `start` events advance resumeId to the session's latest fork.
      try { for (const ev of events) onEvent(ev); } finally { breakChain(); }
      if (!events.length) body.append(el("div", { class: "dmsg-row dmsg-note", text: "(empty transcript)" }));
      textarea.focus();
    } catch (e) {
      note.remove();
      body.append(el("div", { class: "dmsg-row dmsg-error", text: String(e.message || e) }));
    }
  }

  // Leave the history pane, back to the live transcript + composer.
  function showLive() {
    leaveHistoryDetail();
    historyView.hidden = true;
    historyView.textContent = "";
    transcript.hidden = !cfg.configured;
    composer.hidden = !cfg.configured;
    setStatus(idleStatus());
  }

  // Start a fresh conversation: drop the threaded session, clear the live transcript and any
  // pending element context, and return to the live composer.
  function newChat() {
    showLive();               // leave any history view first (restores the stashed live session…)
    resumeId = null;          // …then drop it — next send starts a fresh session
    clearElementContext();
    transcript.textContent = "";
    breakChain();
  }

  ensurePushStyle();

  const api = {
    el: panel,
    isOpen: () => panel.classList.contains("dmsg-open"),
    open() {
      panel.classList.add("dmsg-open");
      document.documentElement.toggleAttribute("data-slidewrite-open", true); // push the page left
      textarea.focus();
      reprobe();        // re-check on open so a stale "wired to" flips to offline immediately
      startPolling();   // keep it live while visible
    },
    close() {
      panel.classList.remove("dmsg-open");
      document.documentElement.toggleAttribute("data-slidewrite-open", false);
      stopPolling();
    },
    toggle() { api.isOpen() ? api.close() : api.open(); },
    addElementContext,
    // Reflect picker (markup) mode on the 🎯 button so it reads as toggled-on while picking.
    setMarkupActive(on) {
      markupBtn.classList.toggle("dmsg-iconbtn-active", on);
      markupBtn.title = on ? "Picking — click elements to stack; 🎯 or Esc to finish" : "Pick an element";
    },
    isBusy: () => busy,
    // Live-update config (e.g. after the origin is enabled in Options) without remounting. Also
    // refreshes the model list from a freshly-fetched /meta and keeps the selection valid.
    setConfig(next) {
      const intervalChanged = next.pollInterval != null && next.pollInterval !== cfg.pollInterval;
      cfg = { ...cfg, ...next, configured: !!next.configured };
      if (next.meta && Array.isArray(next.meta.models) && next.meta.models.length) models = next.meta.models;
      if (next.model && models.some((m) => m.id === next.model)) selectedModel = next.model;
      if (!models.some((m) => m.id === selectedModel)) selectedModel = (next.meta && next.meta.defaultModel) || models[0].id;
      renderModels();
      if (!historyView.hidden) showLive();  // don't strand the user in a stale history pane
      applyConfigured();
      // A just-enabled origin starts polling now; a changed cadence restarts the timer at the new rate.
      if (intervalChanged) stopPolling();
      if (api.isOpen() && cfg.configured) startPolling();
    },
  };
  return api;
}
