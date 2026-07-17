// Slide Write — side-panel host. The chat UI + the SSE stream live HERE now, not in the page: a
// side-panel document is an extension page that persists as long as it's open (unlike the MV3
// service worker, which dies ~30s idle mid-run), so the fetch+getReader loop survives a whole run.
// The element picker stays a content script in the page (content/inject.js) — only a content
// script can hit-test and overlay the app's DOM — and the two halves coordinate over runtime
// messaging. The side-panel document persists per window and caches one panel instance per tab:
// switching tabs swaps instances so each tab keeps its own transcript, draft, and resumed thread.
import { createPanel } from "./content/panel.js";

// --- Per-origin config + shim probe (mirrors content/inject.js, but origin varies per active tab) -
function resolve(c, origin) {
  return {
    configured: !!(c && c.enabled && c.token),
    shimUrl: ((c && c.shimUrl) || (origin ? origin + "/_slidewrite" : "")).replace(/\/$/, ""),
    token: (c && c.token) || "",
    autoReload: !!(c && c.autoReload),
    autoCommit: !(c && c.autoCommit === false),  // default ON — only an explicit false opts out
    provider: (c && c.provider) || "anthropic",  // chosen on the options page; scopes the model dropdown
    model: (c && c.model) || "",
    effort: (c && c.effort) || "",
    geminiKey: (c && c.geminiKey) || "",
    pollInterval: (c && c.pollInterval) || 0,
    imageInstructions: (c && c.imageInstructions) || "",
    debuggerPicker: !!(c && c.debuggerPicker),  // opt-in: route the picker through chrome.debugger
    copyPath: !(c && c.copyPath === false),     // global, default ON: Shift+click copies the element's selector
  };
}
// Health is polled while the panel is open; /meta (including model discovery) is requested only
// during panel/origin setup by passing includeMeta=true.
async function probe(shimUrl, token, includeMeta = false) {
  if (!token) return { state: null };
  try {
    const h = await fetch(`${shimUrl}/health`, { cache: "no-store" });
    if (!h.ok) return { state: "unreachable", detail: `health ${h.status}` };
  } catch { return { state: "unreachable" }; }
  if (!includeMeta) return { state: "live" };
  try {
    const r = await fetch(`${shimUrl}/meta`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (r.status === 401) return { state: "unauthorized" };
    if (r.ok) return { state: "live", meta: await r.json() };
    return { state: "unreachable", detail: `meta ${r.status}` };
  } catch { return { state: "unreachable" }; }
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const screenOf = (url) => { try { const u = new URL(url); return u.pathname + u.search + u.hash; } catch { return ""; } };

async function activeTab() {
  try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab || null; }
  catch { return null; }
}
async function getCfg(origin) {
  let raw = null;
  try { raw = origin ? await chrome.runtime.sendMessage({ type: "getOrigin", origin }) : null; } catch {}
  return resolve(raw, origin);
}

// --- State (one cached panel per browser tab) ------------------------------------------------------
let panel = null;
let activeTabId = null, currentOrigin = null;
let liveCfg = null;
let pickerArmed = false;
let syncing = false;
let syncPending = false;
const tabPanels = new Map();

// --- Element picker bridge -------------------------------------------------------------------------
// The 🎯 button calls onMarkup → we toggle the picker. Two backends coexist, selected per origin:
//   • content-script (default): toggle the active tab's content script (sw-arm/disarm-picker).
//   • chrome.debugger (opt-in `debuggerPicker`): toggle the CDP picker in the background worker
//     (sw-picker-start/stop). The background also surfaces attach failures via "sw-picker-error".
// Either backend reports armed/disarmed via "sw-picker-state" (covers Escape + the element-cap
// auto-disarm) and posts each pick back via "sw-element-picked", so the UI handling is shared.
async function togglePicker() {
  if (activeTabId == null) return;
  const tabId = activeTabId;
  // Debugger-picker mode: the worker owns the picker — no content script, no on-demand injection.
  const copyPath = !!(liveCfg && liveCfg.copyPath);   // global setting → both picker backends gate Shift+click copy on it
  if (liveCfg && liveCfg.debuggerPicker) {
    chrome.runtime.sendMessage({ type: pickerArmed ? "sw-picker-stop" : "sw-picker-start", tabId, copyPath })
      .catch(() => { pickerArmed = false; panel && panel.setMarkupActive(false); });
    return;
  }
  const type = pickerArmed ? "sw-disarm-picker" : "sw-arm-picker";
  try {
    await chrome.tabs.sendMessage(tabId, { type, copyPath });
  } catch {
    // No receiving end → the picker bridge isn't in this tab. When DISARMING there's nothing to do,
    // so just clear the button. When ARMING, the tab is likely STALE (loaded before the extension
    // was enabled, or a non-localhost origin whose dynamic script isn't registered) — inject the
    // bridge on demand, then retry once. The bridge guards against double-injection itself.
    if (pickerArmed) { pickerArmed = false; panel && panel.setMarkupActive(false); return; }
    if (!(await ensurePickerInjected(tabId))) { panel && panel.setMarkupActive(false); return; }
    try { await chrome.tabs.sendMessage(tabId, { type: "sw-arm-picker", copyPath }); }
    catch { panel && panel.setMarkupActive(false); }
  }
}

// Inject the picker bridge into a tab that has no content script yet (stale page / not-yet-registered
// origin). <all_urls> host permission covers executeScript on any normal page; it rejects on
// restricted pages (chrome://, the web store, view-source, …), where the picker simply can't run.
async function ensurePickerInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/inject.js"] });
    return true;
  } catch (e) {
    console.warn("[slide-write] could not inject picker into this tab:", e?.message || e);
    return false;
  }
}
// Disarm whichever picker backend is armed on a tab, clearing the 🎯 button optimistically. Sending
// to BOTH backends is safe — each is a no-op when its mode isn't the active one (no content script
// listening / no CDP attach on that tab) — so callers needn't know the current mode. The backend's
// authoritative "sw-picker-state(false)" follows and confirms it.
function disarmPicker(tabId = activeTabId) {
  pickerArmed = false;
  panel && panel.setMarkupActive(false);
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "sw-disarm-picker" }).catch(() => {});      // content-script
  chrome.runtime.sendMessage({ type: "sw-picker-stop", tabId }).catch(() => {});     // chrome.debugger
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !panel) return;
  // Only trust picker traffic from the tab we're currently bound to. CDP-picker messages come from
  // the background worker (no sender.tab), so they pass this guard — the worker is authoritative there.
  if (sender.tab && sender.tab.id !== activeTabId) return;
  if (msg.type === "sw-picker-state") {
    // The backend's reported state is authoritative — content-script echoes on every arm/disarm (even
    // no-ops) and on fresh load; the CDP picker reports on arm/stop/detach — so this keeps the 🎯
    // button in sync through drift, reloads, and the element-cap auto-disarm.
    pickerArmed = !!msg.active;
    panel.setMarkupActive(pickerArmed);
  } else if (msg.type === "sw-picker-error") {
    // CDP picker couldn't attach (DevTools open, a restricted page, or the debugger permission was
    // never granted) — surface it in the transcript; the backend also reports state false.
    panel.notify(msg.message, { error: true });
  } else if (msg.type === "sw-element-picked") {
    const more = panel.addElementContext(msg.ctx);
    panel.open();
    if (!more) disarmPicker();
  }
});

// Esc disarms the picker even when keyboard focus is in the side panel. The page-side Escape handler
// (picker.js / the CDP binding) only fires when the app tab itself has focus, but the picker is armed
// by clicking the 🎯 button HERE, so focus usually stays in the panel until the user clicks into the
// page. This covers that gap. Only acts while armed, so it never steals Esc from menus/other panel UI.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !pickerArmed || activeTabId == null) return;
  disarmPicker();
});

// Build a panel whose callbacks stay bound to its owning browser tab. The origin is read from the
// cache record at callback time so same-tab navigation cannot accidentally persist a selection
// against whichever other tab happens to be active then.
function createTabPanel(tabId, origin, screen, init, conn) {
  const ownedPanel = createPanel({
    root: document.getElementById("root"),
    shimUrl: init.shimUrl, token: init.token, meta: conn.meta || null,
    conn: { state: conn.state, detail: conn.detail }, screen, origin: origin || "",
    configured: init.configured, autoReload: init.autoReload, autoCommit: init.autoCommit,
    provider: init.provider, model: init.model, effort: init.effort,
    geminiKey: init.geminiKey, pollInterval: init.pollInterval,
    imageInstructions: init.imageInstructions,
    onProbe: probe,
    onMarkup: togglePicker,
    onOpenOptions: () => chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {}),
    onSelectModel: (id) => {
      const record = tabPanels.get(tabId);
      if (record && record.origin)
        chrome.runtime.sendMessage({ type: "setOrigin", origin: record.origin, value: { model: id } }).catch(() => {});
    },
    onSelectEffort: (id) => {
      const record = tabPanels.get(tabId);
      if (record && record.origin)
        chrome.runtime.sendMessage({ type: "setOrigin", origin: record.origin, value: { effort: id } }).catch(() => {});
    },
    // Auto-reload-on-save reloads the panel's owning app tab, even if another tab is active by then.
    onReload: () => chrome.tabs.reload(tabId).catch(() => {}),
  });
  ownedPanel.deactivate();
  const record = { panel: ownedPanel, origin, cfg: init };
  tabPanels.set(tabId, record);
  return record;
}

async function mount() {
  const tab = await activeTab();
  if (!tab || tab.id == null) return;
  activeTabId = tab.id;
  currentOrigin = originOf(tab.url);
  const screen = screenOf(tab.url);
  const init = await getCfg(currentOrigin);
  const conn = init.configured ? await probe(init.shimUrl, init.token, true) : { state: null };
  const record = createTabPanel(activeTabId, currentOrigin, screen, init, conn);
  panel = record.panel;
  liveCfg = init;
  panel.open();
  // The active tab may have changed while the async config/probe above was in flight. Any
  // activation received before `panel` existed was marked pending; always reconcile once mounted.
  syncActiveTab();
}

// Apply one snapshot of the currently active tab. The public syncActiveTab wrapper below serializes
// these runs and queues another snapshot whenever Chrome reports a tab change mid-sync.
async function syncActiveTabOnce() {
  const tab = await activeTab();
  const newId = tab ? tab.id : null;
  const newOrigin = tab ? originOf(tab.url) : null;
  const newScreen = tab ? screenOf(tab.url) : "";
  // Leaving a tab where the picker is still armed → disarm it there (either backend), and clear our
  // local state so the 🎯 button doesn't carry the old tab's armed state onto the new tab.
  if (newId !== activeTabId) {
    if (pickerArmed) disarmPicker(activeTabId);
    pickerArmed = false;
    panel.setMarkupActive(false);
    // Ask the tab we just bound to for its authoritative content-script picker state (it echoes via
    // sw-picker-state); harmless no-op if it has no content script. The CDP picker reports its own
    // state on arm, so it needs no query here.
    if (newId != null) chrome.tabs.sendMessage(newId, { type: "sw-query-picker" }).catch(() => {});
  }
  // Same tab + same origin is only a route update; keep the current instance untouched.
  if (newId === activeTabId && newOrigin === currentOrigin) {
    panel.setConfig({ screen: newScreen });
    return;
  }

  panel.deactivate();
  activeTabId = newId;
  currentOrigin = newOrigin;
  // Keep the last panel reference while Chrome momentarily reports no active tab (for example,
  // during window teardown/focus transitions) so a later activation can still run the reconciler.
  if (newId == null) { liveCfg = null; return; }

  let record = tabPanels.get(newId);
  // A tab that navigated to another origin gets a fresh conversation for that new app. Ordinary
  // tab switching reuses the existing instance and therefore preserves its complete chat state.
  if (record && record.origin !== newOrigin) {
    record.panel.destroy();
    tabPanels.delete(newId);
    record = null;
  }

  const next = await getCfg(newOrigin);
  const conn = next.configured ? await probe(next.shimUrl, next.token, true) : { state: null };
  if (!record) record = createTabPanel(newId, newOrigin, newScreen, next, conn);
  else record.panel.setConfig({
    shimUrl: next.shimUrl, token: next.token, meta: conn.meta || null,
    conn: { state: conn.state, detail: conn.detail }, screen: newScreen, origin: newOrigin || "",
    configured: next.configured, autoReload: next.autoReload, autoCommit: next.autoCommit,
    provider: next.provider, model: next.model, effort: next.effort,
    geminiKey: next.geminiKey, pollInterval: next.pollInterval,
    imageInstructions: next.imageInstructions,
  });
  record.cfg = next;
  panel = record.panel;
  liveCfg = next;
  panel.open();
}

// Tab activation/update events can arrive while getCfg()/probe() is still resolving. Never discard
// those events: mark the synchronizer dirty and keep sampling until no newer event arrived during
// the preceding pass. This is what makes a quick A → unwired B → A switch reliably restore A.
async function syncActiveTab() {
  syncPending = true;
  if (!panel || syncing) return;
  syncing = true;
  try {
    while (syncPending) {
      syncPending = false;
      await syncActiveTabOnce();
    }
  } finally {
    syncing = false;
    // Defensive against a future change adding an await between the loop condition and finally.
    if (syncPending) syncActiveTab();
  }
}
chrome.tabs.onActivated.addListener(syncActiveTab);
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === activeTabId && (info.status === "complete" || info.url)) syncActiveTab(); });
chrome.tabs.onRemoved.addListener((tabId) => {
  const record = tabPanels.get(tabId);
  if (!record) return;
  record.panel.destroy();
  tabPanels.delete(tabId);
});
chrome.windows.onFocusChanged.addListener((wid) => { if (wid !== chrome.windows.WINDOW_ID_NONE) syncActiveTab(); });

// Live config: an edit in Options for the current origin re-resolves and pushes to the panel, exactly
// like content/inject.js did, so enabling/changing this origin goes live with no panel reload.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.slidewrite || !panel) return;
  const nv = changes.slidewrite.newValue || {};
  const next = resolve({ ...((nv.origins || {})[currentOrigin] || null), geminiKey: nv.geminiKey || "", pollInterval: nv.pollInterval || 0 }, currentOrigin);
  const connChanged = next.shimUrl !== liveCfg.shimUrl || next.token !== liveCfg.token || next.configured !== liveCfg.configured;
  const update = { shimUrl: next.shimUrl, token: next.token,
    autoReload: next.autoReload, autoCommit: next.autoCommit, configured: next.configured,
    provider: next.provider, model: next.model, effort: next.effort,
    geminiKey: next.geminiKey, pollInterval: next.pollInterval, imageInstructions: next.imageInstructions };
  if (connChanged) {
    const c = next.configured ? await probe(next.shimUrl, next.token, true) : { state: null };
    const m = c.meta || null;
    update.meta = m;
    update.conn = { state: c.state, detail: c.detail };
  }
  liveCfg = next;
  panel.setConfig(update);
});

mount();
