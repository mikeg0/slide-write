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

// Downscale a pasted-from-clipboard image blob to a PNG data URL (max edge 1024, like the picker's
// captureImageData), returning a synthetic element context: no DOM fields, both screenshotDataUrl
// (→ /design temp file → Read) and imageDataUrl (→ /generate-image image-to-image source) set to
// the same URL, tagged `pasted` so the shim emits paste-specific wording. Null on any failure.
async function pastedImageCtx(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const max = 1024;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const url = canvas.toDataURL("image/png");
    return { pasted: true, screenshotDataUrl: url, imageDataUrl: url, screenshotW: w, screenshotH: h };
  } catch { return null; }
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

// Resolve which models the dropdown offers for the chosen provider. /meta advertises a per-provider
// `providers:[{id,models,defaultModel}]` array; when the selected provider is listed we use its
// models (even when empty — e.g. a disabled provider, or an OpenAI list the shim couldn't fetch).
// Against an old shim with no `providers`, use the legacy top-level `models`; without server
// metadata the selector stays empty rather than advertising a stale client-side model list.
function modelsFor(meta, provider) {
  const p = meta && Array.isArray(meta.providers) ? meta.providers.find((x) => x.id === provider) : null;
  if (p && Array.isArray(p.models))
    return { models: p.models, defaultModel: p.defaultModel || (p.models[0] && p.models[0].id) || "" };
  if (meta && Array.isArray(meta.models) && meta.models.length)
    return { models: meta.models, defaultModel: meta.defaultModel || meta.models[0].id };
  return { models: [], defaultModel: "" };
}

export function createPanel({ root, shimUrl, token, meta, conn, provider, model, effort, screen, origin, onMarkup, onOpenOptions, onProbe, onSelectModel, onSelectEffort, onReload, onClose, autoReload, autoCommit, configured, geminiKey, pollInterval, imageInstructions }) {
  // Live config — reassignable via api.setConfig so enabling the origin in Options flips the panel
  // from its disabled "set up" state to live, with no reload. `screen` is the active tab's route
  // (sidepanel.js keeps it current as the tab navigates/switches), sent with each run. `provider`
  // is chosen on the options page and scopes which models the dropdown offers + the run backend.
  let cfg = { shimUrl, token, meta, conn: conn || { state: null }, autoReload: !!autoReload,
    autoCommit: autoCommit !== false, configured: !!configured, screen: screen || "", origin: origin || "",
    provider: provider || "anthropic", effort: effort || "",
    geminiKey: geminiKey || "", pollInterval: pollInterval || 0, imageInstructions: imageInstructions || "" };
  // Model selection state. `models` is the menu list (server-driven via /meta for the active
  // provider); `selectedModel` is the chosen id sent with each /design request and
  // persisted per-origin. recomputeModels() rebuilds both when the provider or /meta changes.
  const _init = modelsFor(meta, cfg.provider);
  let models = _init.models;
  let selectedModel = (model && _init.models.some((m) => m.id === model)) ? model
    : (_init.defaultModel || (_init.models[0] && _init.models[0].id) || "");
  const _initModel = models.find((m) => m.id === selectedModel);
  let efforts = _initModel && Array.isArray(_initModel.efforts) ? _initModel.efforts : [];
  let selectedEffort = (effort && efforts.some((e) => e.id === effort)) ? effort
    : ((_initModel && _initModel.defaultEffort) || (efforts[0] && efforts[0].id) || "");
  let busy = false;
  let active = false;                 // only the active browser tab's cached panel is visible/polling
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
  let queue = [];                   // follow-up intents typed while a run is in flight; drained at run end
  let resumeId = null;              // when set, each send continues this past session
  let liveResumeId = null;          // live chat's session, stashed while a history detail owns resumeId
  let threadTokens = 0;             // cumulative output tokens across the active thread's runs (shown in liveStats)
  let liveThreadTokens = 0;         // live thread's cumulative tokens, stashed while a history detail is open
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
  // Title block — the title with a muted status line stacked directly beneath it. The status line
  // normally shows the "wired to <project>" connection state; while a header button is hovered it
  // borrows that button's tooltip text, then reverts on mouse-out. Hover is handled by delegation
  // (below) so it tracks dynamic titles (e.g. the 🎯 button's "Picking…" label) at the moment of hover.
  const titleblock = el("div", { class: "dmsg-headerleft" }, [
    status,
  ]);
  const header = el("div", { class: "dmsg-header" }, [
    titleblock,
    markupBtn,
    newChatBtn,
    historyBtn,
    settingsBtn,
  ]);
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
  // Persistent stats line directly below the chips: hosts the live run status (spinner · phase ·
  // model · tokens) while a run streams, then the latest run's final stats (turns · time · cost).
  const liveStats = el("div", { class: "dmsg-stats dmsg-livestats", hidden: "" });
  const textarea = el("textarea", {
    class: "dmsg-input", rows: "3",
    placeholder: "Describe what you want to create…",
    // Enter sends; ⌘/Ctrl+Enter (and Shift+Enter) insert a newline. Skip while an IME is composing so
    // Enter commits the candidate instead of sending. The default textarea newline only happens for
    // keys we don't preventDefault, so ⌘/Ctrl+Enter must splice the "\n" in by hand.
    onkeydown: (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const t = e.target, s = t.selectionStart, end = t.selectionEnd;
        t.value = t.value.slice(0, s) + "\n" + t.value.slice(end);
        t.selectionStart = t.selectionEnd = s + 1;
        t.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      if (e.shiftKey) return;   // Shift+Enter keeps the default newline
      e.preventDefault();
      send();
    },
    // While a run is in flight the send button toggles between Cancel (empty box) and Queue (typed
    // text); keep it in sync as the user types.
    oninput: () => { if (busy) updateSendBtn(); },
    // Ctrl/Cmd+V of a copied image: stack it as a synthetic pasted-image context. Only an image item
    // is intercepted — text paste falls through untouched (no preventDefault). preventDefault must
    // run synchronously, before the async decode, so detect the image up front.
    onpaste: (e) => {
      const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
      let blob = null;
      for (const it of items) if (it.kind === "file" && /^image\//.test(it.type)) { blob = it.getAsFile(); break; }
      if (!blob) for (const f of (e.clipboardData ? e.clipboardData.files || [] : [])) if (/^image\//.test(f.type)) { blob = f; break; }
      if (!blob) return;   // not an image — let normal text paste through
      e.preventDefault();
      if (elementCtxs.length >= MAX_ELEMENTS) { setStatus(`element limit reached (${MAX_ELEMENTS} max)`); return; }
      pastedImageCtx(blob).then((ctx) => { if (ctx) addElementContext(ctx); });
    },
  });

  // Model selector — a text button (current model + chevron) over a menu that opens upward.
  const modelLabel = el("span", { class: "dmsg-modellabel" });
  const modelBtn = el("button", { class: "dmsg-model", title: "Choose model" }, [
    modelLabel, el("span", { class: "dmsg-chevron", text: "▾" }),
  ]);
  modelBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleModelMenu(); });
  const modelMenu = el("div", { class: "dmsg-modelmenu", hidden: "" });

  // Reasoning-effort selector — populated from the selected model's /meta effort metadata. It sits
  // immediately to the right of the model and disappears for providers/models with no effort levels.
  const effortLabel = el("span", { class: "dmsg-effortlabel" });
  const effortBtn = el("button", { class: "dmsg-model dmsg-effort", title: "Choose reasoning effort" }, [
    effortLabel, el("span", { class: "dmsg-chevron", text: "▾" }),
  ]);
  effortBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleEffortMenu(); });
  const effortMenu = el("div", { class: "dmsg-modelmenu dmsg-effortmenu", hidden: "" });
  const effortWrap = el("div", { class: "dmsg-modelwrap dmsg-effortwrap" }, [effortMenu, effortBtn]);

  const sendIcon = el("span", { class: "dmsg-sendicon", text: "➤" });
  const sendLabel = el("span", { class: "dmsg-sendlabel", text: "Send" });
  const sendBtn = el("button", { class: "dmsg-send", title: "Send (Enter)", onclick: () => send() }, [sendIcon, sendLabel]);

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
      effortWrap,
    ]),
    sendBtn,
  ]);
  // Queued follow-ups: messages typed while a run streams, shown as removable pending rows directly
  // above the stats line. Drained one-at-a-time as each run finishes (renderQueue rebuilds it).
  const queuedList = el("div", { class: "dmsg-queued", hidden: "" });
  const inputCard = el("div", { class: "dmsg-inputcard" }, [textarea, toolbar]);
  const composer = el("div", { class: "dmsg-composer" }, [ctxChips, queuedList, liveStats, inputCard]);

  // Render the model button label + menu items to reflect `models` / `selectedModel`.
  function renderModels() {
    const cur = models.find((m) => m.id === selectedModel);
    modelLabel.textContent = cur ? cur.label : (selectedModel || "Model");
    modelBtn.disabled = !cfg.configured || models.length < 2;
    modelMenu.textContent = "";
    for (const m of models) {
      const active = m.id === selectedModel;
      modelMenu.append(el("button", {
        class: `dmsg-modelitem${active ? " dmsg-modelitem-active" : ""}`,
        title: m.description || "",
        onclick: (e) => { e.stopPropagation(); selectModel(m.id); },
      }, [
        el("span", { class: "dmsg-modelitem-label", text: m.label }),
        active ? el("span", { class: "dmsg-modelitem-check", text: "✓" }) : null,
      ]));
    }
  }
  function toggleModelMenu(force) {
    const open = force != null ? force : modelMenu.hidden;
    if (open) { toggleEffortMenu(false); togglePlusMenu(false); }
    modelMenu.hidden = !open;
    modelBtn.classList.toggle("dmsg-model-open", open);
  }
  function renderEfforts() {
    const cur = efforts.find((e) => e.id === selectedEffort);
    effortLabel.textContent = cur ? cur.label : "Effort";
    effortWrap.hidden = efforts.length === 0;
    effortBtn.disabled = !cfg.configured || efforts.length < 2;
    effortMenu.textContent = "";
    for (const e of efforts) {
      const active = e.id === selectedEffort;
      effortMenu.append(el("button", {
        class: `dmsg-modelitem${active ? " dmsg-modelitem-active" : ""}`,
        title: e.description || "",
        onclick: (ev) => { ev.stopPropagation(); selectEffort(e.id); },
      }, [
        el("span", { class: "dmsg-modelitem-label", text: e.label }),
        active ? el("span", { class: "dmsg-modelitem-check", text: "✓" }) : null,
      ]));
    }
  }
  function toggleEffortMenu(force) {
    const open = !effortBtn.disabled && (force != null ? force : effortMenu.hidden);
    if (open) { toggleModelMenu(false); togglePlusMenu(false); }
    effortMenu.hidden = !open;
    effortBtn.classList.toggle("dmsg-model-open", open);
  }
  function recomputeEfforts(preferEffort) {
    const selected = models.find((m) => m.id === selectedModel);
    efforts = selected && Array.isArray(selected.efforts) ? selected.efforts : [];
    const advertisedDefault = selected && selected.defaultEffort;
    const defaultEffort = (efforts.some((e) => e.id === advertisedDefault) && advertisedDefault)
      || (efforts[0] && efforts[0].id) || "";
    const want = preferEffort
      || (efforts.some((e) => e.id === selectedEffort) ? selectedEffort : null)
      || cfg.effort || defaultEffort;
    selectedEffort = (efforts.some((e) => e.id === want) ? want : defaultEffort) || "";
    renderEfforts();
  }
  // Rebuild `models` for the active provider (cfg.provider + cfg.meta) and keep a valid selection:
  // prefer an explicitly requested id, else the current pick if still offered, else the persisted
  // cfg.model, else the provider's default. Called whenever the provider or /meta changes.
  function recomputeModels(preferModel, preferEffort) {
    const { models: ms, defaultModel } = modelsFor(cfg.meta, cfg.provider);
    models = ms;
    const want = preferModel
      || (models.some((m) => m.id === selectedModel) ? selectedModel : null)
      || cfg.model || defaultModel;
    selectedModel = (models.some((m) => m.id === want) ? want : defaultModel) || (models[0] && models[0].id) || "";
    renderModels();
    recomputeEfforts(preferEffort);
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
    if (open) { renderPlusMenu(); toggleModelMenu(false); toggleEffortMenu(false); }
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
    recomputeEfforts();
    toggleModelMenu(false);
    onSelectModel && onSelectModel(id);   // persist per-origin (inject.js → background store)
  }
  function selectEffort(id) {
    selectedEffort = id;
    renderEfforts();
    toggleEffortMenu(false);
    onSelectEffort && onSelectEffort(id);
  }
  // Close the menu on any click elsewhere (composed clicks from inside the shadow root that should
  // keep it open call stopPropagation, so they never reach here) and on Esc before it closes the
  // whole panel.
  const closeMenus = () => { toggleModelMenu(false); toggleEffortMenu(false); togglePlusMenu(false); };
  document.addEventListener("click", closeMenus);
  composer.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!modelMenu.hidden) { e.stopPropagation(); toggleModelMenu(false); }
    else if (!effortMenu.hidden) { e.stopPropagation(); toggleEffortMenu(false); }
    else if (!plusMenu.hidden) { e.stopPropagation(); togglePlusMenu(false); }
  });
  renderModels();
  renderEfforts();
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
  const diagRetry = el("button", { class: "dmsg-diag-btn", text: "↻ Retry", onclick: () => reprobe(true) });
  const diagSettings = el("button", { class: "dmsg-diag-btn dmsg-diag-btn-ghost", text: "⚙️ Options", onclick: () => onOpenOptions && onOpenOptions() });
  const diag = el("div", { class: "dmsg-diag", hidden: "" }, [
    diagTitle, diagText, diagCodes,
    el("div", { class: "dmsg-diag-actions" }, [diagRetry, diagSettings]),
  ]);

  const panel = el("div", { class: "dmsg-panel", "data-slidewrite-ui": "" }, [header, diag, setup, transcript, historyView, composer]);
  root.append(panel);

  // Status text is two layers: `baseStatus` is the persistent connection/run state (set via
  // setStatus); `hoverHelp`, when non-null, temporarily overrides it with a hovered button's tooltip.
  let baseStatus = "";
  let hoverHelp = null;
  function renderStatus() { status.textContent = hoverHelp != null ? hoverHelp : baseStatus; }
  function setStatus(t) { baseStatus = t; renderStatus(); }
  function setHoverHelp(t) { hoverHelp = t; renderStatus(); }
  // Persistent stats line below the chips: live run status while busy, latest final stats after.
  function setLiveStats(t) { liveStats.textContent = t || ""; liveStats.hidden = !t; }

  const shimHost = () => { try { return new URL(cfg.shimUrl).host; } catch { return cfg.shimUrl; } };
  const shimPort = () => { try { return new URL(cfg.shimUrl).port || "4040"; } catch { return "4040"; } };
  // Detect the README §13 reverse-proxy (Traefik) topology from the configured shimUrl alone — we
  // can't query /meta here since this fires precisely when the shim is unreachable. The default
  // shimUrl is `location.origin + "/_slidewrite"` (a same-origin path prefix); the direct/loopback
  // setup overrides it to `http://localhost:<port>` (root path). So a non-root pathname ⇒ behind a
  // proxy, where the shim must bind the docker bridge gateway (`--bind`) instead of pure loopback.
  const isReverseProxy = () => { try { return new URL(cfg.shimUrl).pathname.replace(/\/+$/, "") !== ""; } catch { return false; } };
  // The persistent status line, derived from the probed connection state (see inject.js `probe`).
  function idleStatus() {
    if (!cfg.configured) return "not configured";
    const st = cfg.conn && cfg.conn.state;
    if (st === "live" || (!st && cfg.meta)) return cfg.meta ? `wired to ${cfg.meta.project}${cfg.meta.branch ? ` @ ${cfg.meta.branch}` : " (no git)"}` : "connected";
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
      const proxied = isReverseProxy();
      diagText.textContent = proxied
        ? `Slide Write couldn't connect to the agent at ${shimHost()} (via the ${new URL(cfg.shimUrl).pathname.replace(/\/+$/, "")} reverse-proxy route). Check that the shim is running on the code machine, bound to the proxy network, and that the proxy is up. Start it with:`
        : `Slide Write couldn't connect to the agent at ${shimHost()}. Check that the shim is running on the code machine and — in remote dev — that the port is forwarded (VS Code → Ports). Start it with:`;
      // Behind a reverse proxy the shim must bind the docker bridge gateway, not pure loopback (§13).
      const bind = proxied ? " --bind <docker bridge gateway>" : "";
      const tail = `--repo <path> --port ${shimPort()} --origin ${cfg.origin || "<app origin>"} --token <secret>${bind}`;
      diagCodeNode.textContent = `node shim/slide-write.mjs ${tail}`;
      diagCodePy.textContent = `python3 shim/slide-write.py ${tail}`;
      diagCodes.hidden = false;
      diagSettings.hidden = true;
    }
  }
  // Re-check the connection on demand (panel open, poll tick, after a failed send) and update the UI.
  let probing = false;
  async function reprobe(includeMeta = false) {
    if (!cfg.configured || !onProbe || probing) return;
    probing = true;
    try {
      const previousState = cfg.conn && cfg.conn.state;
      let p = await onProbe(cfg.shimUrl, cfg.token, includeMeta);
      if (!p) return;
      // Polling normally uses the cheap /health check. When that check is the one that discovers
      // the shim has come back, immediately finish the normal startup probe with /meta before
      // exposing the live state. That refreshes the discovered model list and the repo/branch shown
      // in the header, leaving the composer ready for its first message without a panel reload.
      if (!includeMeta && previousState !== "live" && p.state === "live") {
        const refreshed = await onProbe(cfg.shimUrl, cfg.token, true);
        if (refreshed) p = refreshed;
      }
      cfg.conn = { state: p.state, detail: p.detail };
      if (p.meta) {
        cfg.meta = p.meta;
        recomputeModels();  // provider-scoped: pulls from cfg.meta.providers for cfg.provider, not the legacy top-level list
      }
      if (historyView.hidden) renderConn();
    } finally { probing = false; }
  }
  // Light liveness polling — only while the panel is OPEN, so closed tabs add no background churn.
  // A cheap GET /health tracks the shim; the first successful check after an outage also loads
  // /meta so reconnect has the same model/repo state as initial setup. Cadence is the global
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
        // End-of-turn: roll this run's output tokens into the thread total and show the cumulative
        // figure in the persistent line below the chips (history replay re-sums the viewed session).
        threadTokens += (ev.usage && ev.usage.output_tokens) || 0;
        setLiveStats(`${bits} · Σ ${fmtTok(threadTokens)} tokens`);
        break;
      }
      case "commit":
        addRow(el("div", { class: "dmsg-row dmsg-commit", text: `✓ Committed ${ev.sha} · ${ev.count} file${ev.count === 1 ? "" : "s"}` }));
        break;
      case "commit_error": addRow(el("div", { class: "dmsg-row dmsg-error", text: `commit error: ${ev.message}` })); break;
      case "error":   addRow(el("div", { class: "dmsg-row dmsg-error", text: ev.message })); break;
      case "aborted": addRow(el("div", { class: "dmsg-row dmsg-note", text: "stream ended" })); break;
      case "done": {
        // Settle the live verb to "finished" (capture model/tokens before setBusy clears them) so
        // the run-status line stops reading "responding" once the turn is complete.
        const finModel = runModel, finToks = (runTokens || 0) + Math.floor(runTokensEst);
        setBusy(false); setStatus(idleStatus());
        const finLabel = finModel ? `finished · ${finModel}` : "finished";
        setLiveStats(`${finLabel}${finToks ? ` · ${fmtTok(finToks)} tokens` : ""}`);
        // Auto-reload-on-save: any file changed this run → reload once the run is done (reloading
        // mid-run would tear down the content-script SSE stream). Decoupled from `commit` so it
        // still fires when auto-commit is off. Deferred while a queue is pending — reloading now
        // would drop the queued follow-ups; the final run in the queue triggers the reload instead.
        if (cfg.autoReload && filesChangedThisRun && !queue.length) { setLiveStats("reloading…"); setTimeout(() => onReload && onReload(), 400); }
        break;
      }
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
    setLiveStats(busy ? `${SPIN[spinIdx]} ${runLabel || "starting…"}${toks}` : `${runLabel}${toks}`);
  }

  function setBusy(b) {
    busy = b;
    if (b && !spinTimer)
      spinTimer = setInterval(() => { spinIdx = (spinIdx + 1) % SPIN.length; renderRunStatus(); }, 120);
    if (!b) {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      runLabel = ""; runModel = ""; runTokens = null; runTokensEst = 0;
    }
    // Textarea stays live while busy so the user can type a follow-up to queue (only its own
    // availability gates on configured).
    textarea.disabled = !cfg.configured;
    updateSendBtn();
  }

  // The send button is context-sensitive: idle → Send; busy with a typed follow-up → Queue (it gets
  // enqueued and dispatched when the current run ends); busy with an empty box → Cancel the run.
  function updateSendBtn() {
    if (!busy) {
      sendLabel.textContent = "Send";
      sendIcon.textContent = "➤";
      sendBtn.title = "Send (Enter)";
      sendBtn.classList.remove("dmsg-busy");
      return;
    }
    sendBtn.classList.add("dmsg-busy");
    if (textarea.value.trim()) {
      sendLabel.textContent = "Queue";
      sendIcon.textContent = "＋";
      sendBtn.title = "Queue this message to run when the current one finishes (Enter)";
    } else {
      sendLabel.textContent = "Cancel";
      sendIcon.textContent = "■";
      sendBtn.title = "Cancel run";
    }
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
    textarea.disabled = !ok;
    sendBtn.disabled = !ok;
    modelBtn.disabled = !ok || models.length < 2;
    effortBtn.disabled = !ok || efforts.length < 2;
    renderConn();
  }

  // Press Send / Enter. Idle → dispatch immediately. Busy → if there's a typed follow-up, queue
  // it (drained when the current run finishes); otherwise cancel the run (and drop any queue).
  function send() {
    if (!cfg.configured) return;
    if (busy) {
      const intent = readComposer();
      if (intent) { enqueue(intent); updateSendBtn(); }
      else { clearQueue(); controller && controller.abort(); }
      return;
    }
    const intent = readComposer();
    if (intent) dispatch(intent);
  }

  // Snapshot the composer into a send intent and reset it for the next message. The element/image
  // state is captured here (before clearElementContext resets it) so a queued follow-up carries the
  // context the user had when they typed it. Returns null when the box is empty.
  function readComposer() {
    const prompt = textarea.value.trim();
    if (!prompt) return null;
    const intent = { prompt, image: imageMode, elements: elementCtxs.slice(), model: selectedModel, effort: selectedEffort };
    textarea.value = "";
    clearElementContext();
    return intent;
  }

  // Run one intent: build the §7 payload (resolving resumeId LIVE so a queued follow-up threads into
  // whatever session the prior run settled on), stream it, then drain the next queued intent.
  function dispatch(intent) {
    const { prompt, image, elements, model, effort } = intent;
    let payload, path;
    if (image) {
      payload = { imagePrompt: prompt, screen: cfg.screen || "", model, effort, provider: cfg.provider,
        geminiKey: cfg.geminiKey, imageInstructions: cfg.imageInstructions, autoCommit: cfg.autoCommit };
      // Strip the element screenshots — /generate-image uses imageDataUrl (the canvas-read source
      // pixels) for image-to-image; the screenshots would just bloat the payload.
      if (elements.length)
        payload.elements = elements.map(({ screenshotDataUrl, screenshotW, screenshotH, ...rest }) => rest);
      path = "/generate-image";
    } else {
      payload = { prompt, screen: cfg.screen || "", model, effort, provider: cfg.provider, autoCommit: cfg.autoCommit };
      // Drop imageDataUrl (only meaningful to /generate-image) and the UI-only screenshot dimensions,
      // but KEEP screenshotDataUrl — the shim writes each to a temp file for claude to Read.
      if (elements.length)
        payload.elements = elements.map(({ imageDataUrl, screenshotW, screenshotH, ...rest }) => rest);
      if (resumeId) payload.resume = resumeId;
      path = "/design";
    }
    addRow(el("div", { class: "dmsg-bubble dmsg-user" }, [el("div", { class: "dmsg-bubbletext", text: prompt })]));
    setBusy(true);
    controller = new AbortController();
    return streamDesign(cfg.shimUrl, cfg.token, payload, onEvent, controller.signal, path)
      .catch((e) => {
        // A network-level failure here ("Failed to fetch") usually means the shim went down mid-send —
        // re-probe so the diagnostics banner explains what's wrong instead of leaving a bare error row.
        if (e.name !== "AbortError") { onEvent({ type: "error", message: String(e.message || e) }); reprobe(); }
      })
      .finally(() => {
        setBusy(false);
        controller = null;
        // Drain the next queued follow-up (an explicit cancel already emptied the queue).
        if (queue.length) { const next = queue.shift(); renderQueue(); dispatch(next); }
      });
  }

  // --- Queued follow-ups ---------------------------------------------------------------------
  function enqueue(intent) {
    queue.push(intent);
    renderQueue();
    setStatus(`queued ${queue.length} message${queue.length === 1 ? "" : "s"} — running after the current one`);
  }
  function renderQueue() {
    queuedList.textContent = "";
    queue.forEach((it, i) => {
      const label = `${it.image ? "🖼️ " : ""}${it.prompt}`;
      queuedList.append(el("div", { class: "dmsg-queueitem" }, [
        el("span", { class: "dmsg-queueitem-badge", text: `⏳ ${i + 1}` }),
        el("span", { class: "dmsg-queueitem-text", text: label, title: label }),
        el("button", { class: "dmsg-iconbtn", text: "✕", title: "Remove from queue", onclick: () => removeQueued(i) }),
      ]));
    });
    queuedList.hidden = !queue.length;
  }
  function removeQueued(i) { queue.splice(i, 1); renderQueue(); }
  function clearQueue() { queue = []; renderQueue(); }

  // Prefer the full DOM path (§7 domPath) so the chip shows where the element lives; fall back to a
  // bare tag#id.class identity when no path was captured. Overflow is truncated with an ellipsis by
  // CSS (.dmsg-chiptext), and the full string is exposed via the chip's title on hover.
  const ctxLabel = (ctx) =>
    ctx.domPath || [ctx.tag, ctx.id ? `#${ctx.id}` : "", ctx.className ? `.${String(ctx.className).split(/\s+/).join(".")}` : ""].join("");
  // Re-render the whole element-chip stack: per picked element an identity chip (✕ removes that
  // element) and, when a capture was taken, a screenshot chip (thumbnail + dimensions + ✕; removing
  // it drops the pixels off that element so they're never sent). The icon reflects image mode
  // (🖼️ when image generation is on, else 🎯).
  function renderChips() {
    ctxChips.textContent = "";
    const icon = imageMode ? "🖼️" : "🎯";
    elementCtxs.forEach((ctx, i) => {
      // Pasted images have no DOM — render a single thumbnail chip (no identity chip), whose ✕
      // removes the whole entry (clearScreenshot would strand an invisible entry that still counts
      // against the cap and still sends imageDataUrl).
      if (ctx.pasted) {
        ctxChips.append(el("div", { class: "dmsg-chip dmsg-shotchip" }, [
          el("img", { class: "dmsg-shotthumb", src: ctx.screenshotDataUrl, alt: "" }),
          el("span", { class: "dmsg-chiptext", text: `📋 pasted image · ${ctx.screenshotW}×${ctx.screenshotH}` }),
          el("button", { class: "dmsg-iconbtn", text: "✕", title: "Remove pasted image", onclick: () => removeElement(i) }),
        ]));
        return;
      }
      const chipText = `${icon} ${ctxLabel(ctx) || "element"}${ctx.text ? ` — "${ctx.text.slice(0, 40)}"` : ""}`;
      ctxChips.append(el("div", { class: "dmsg-chip" }, [
        el("span", { class: "dmsg-chiptext", text: chipText, title: chipText }),
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
    threadTokens = liveThreadTokens;  // restore the live thread's running total
    liveThreadTokens = 0;
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
      const sessions = await fetchHistory(cfg.shimUrl, cfg.token, cfg.provider);
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
    if (!inHistoryDetail) { liveResumeId = resumeId; liveThreadTokens = threadTokens; inHistoryDetail = true; }
    resumeId = s.id;
    threadTokens = 0;   // replay re-accumulates the viewed session's tokens from its result events
    renderPlaceholder();
    target = body; breakChain();
    try {
      const events = await fetchHistoryDetail(cfg.shimUrl, cfg.token, s.id, cfg.provider);
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
    threadTokens = 0;         // fresh thread → zero the cumulative token total
    setLiveStats("");         // clear the persistent stats line
    clearQueue();             // drop any pending follow-ups bound to the old thread
    clearElementContext();
    transcript.textContent = "";
    breakChain();
  }

  const api = {
    el: panel,
    // sidepanel.js keeps one panel instance per browser tab. Activating/deactivating only swaps
    // visibility + liveness polling; the transcript, draft, picks and resume id stay on this
    // instance so returning to the tab restores the conversation exactly where it was.
    isOpen: () => active,
    open() {
      active = true;
      panel.hidden = false;
      textarea.focus();
      startPolling();   // keep it live while visible
    },
    deactivate() {
      active = false;
      panel.hidden = true;
      stopPolling();
      toggleModelMenu(false);
      toggleEffortMenu(false);
      togglePlusMenu(false);
    },
    close() {
      stopPolling();
      onClose && onClose();
    },
    destroy() {
      active = false;
      stopPolling();
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      if (controller) controller.abort();
      document.removeEventListener("click", closeMenus);
      panel.remove();
    },
    toggle() { onClose && onClose(); },
    // Reset to a fresh thread (sidepanel.js calls this on a same-tab origin change).
    resetThread: () => newChat(),
    // Abort an in-flight run (e.g. when this tab navigates to another origin mid-run).
    cancel: () => { if (controller) controller.abort(); },
    addElementContext,
    // Surface an out-of-band message (e.g. the CDP picker failing to attach) as a transcript row +
    // status line. `error` styles it red. Used by sidepanel.js for "sw-picker-error".
    notify(message, { error = false } = {}) {
      addRow(el("div", { class: `dmsg-row ${error ? "dmsg-error" : ""}`, text: message }));
      setStatus(message);
    },
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
      const historyInvalidated =
        (next.shimUrl !== undefined && next.shimUrl !== cfg.shimUrl) ||
        (next.token !== undefined && next.token !== cfg.token) ||
        (next.provider !== undefined && next.provider !== cfg.provider) ||
        (next.configured !== undefined && !!next.configured !== cfg.configured);
      // Only flip `configured` when the caller actually supplied it — a screen-only update
      // (same-origin navigation) must not knock a live panel back into its "set up" state.
      cfg = { ...cfg, ...next, configured: next.configured != null ? !!next.configured : cfg.configured };
      // A fresh /meta, a provider switch (options page), or an explicit model all change which models
      // are offered / selected — rebuild from the active provider and keep the selection valid.
      if (next.meta !== undefined || next.provider !== undefined || next.model !== undefined)
        recomputeModels(next.model, next.effort);
      else if (next.effort !== undefined) recomputeEfforts(next.effort);
      // Route-only updates are common while following a tab and must preserve an open history
      // transcript. Only connection/provider changes make that replay stale.
      if (historyInvalidated && !historyView.hidden) showLive();
      applyConfigured();
      // A just-enabled origin starts polling now; a changed cadence restarts the timer at the new rate.
      if (intervalChanged) stopPolling();
      if (api.isOpen() && cfg.configured) startPolling();
    },
  };
  return api;
}
