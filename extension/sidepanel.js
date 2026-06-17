// Slide Write — side-panel host. The chat UI + the SSE stream live HERE now, not in the page: a
// side-panel document is an extension page that persists as long as it's open (unlike the MV3
// service worker, which dies ~30s idle mid-run), so the fetch+getReader loop survives a whole run.
// The element picker stays a content script in the page (content/inject.js) — only a content
// script can hit-test and overlay the app's DOM — and the two halves coordinate over runtime
// messaging. One panel persists per window and FOLLOWS the active tab: switching tabs/origins
// re-resolves that origin's config and resets the thread.
import { createPanel } from "./content/panel.js";

// --- Per-origin config + shim probe (mirrors content/inject.js, but origin varies per active tab) -
function resolve(c, origin) {
  return {
    configured: !!(c && c.enabled && c.token),
    shimUrl: ((c && c.shimUrl) || (origin ? origin + "/_slidewrite" : "")).replace(/\/$/, ""),
    token: (c && c.token) || "",
    autoReload: !!(c && c.autoReload),
    autoCommit: !(c && c.autoCommit === false),  // default ON — only an explicit false opts out
    model: (c && c.model) || "",
    geminiKey: (c && c.geminiKey) || "",
    pollInterval: (c && c.pollInterval) || 0,
    imageInstructions: (c && c.imageInstructions) || "",
  };
}
// Same contract as inject.js's probe: { state:"live", meta } · "unauthorized" · "unreachable" · null.
async function probe(shimUrl, token) {
  if (!token) return { state: null };
  try {
    const h = await fetch(`${shimUrl}/health`, { cache: "no-store" });
    if (!h.ok) return { state: "unreachable", detail: `health ${h.status}` };
  } catch { return { state: "unreachable" }; }
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

// --- State (one persistent panel, rebound to the active tab) ---------------------------------------
let panel = null;
let activeTabId = null, currentOrigin = null;
let liveCfg = null, lastMeta = null, lastConn = null;
let pickerArmed = false;
let syncing = false;

// --- Element picker bridge -------------------------------------------------------------------------
// The 🎯 button calls onMarkup → we toggle the picker in the active tab's content script. The content
// script reports armed/disarmed via "sw-picker-state" (covers Escape + the element-cap auto-disarm),
// and posts each pick back via "sw-element-picked".
function togglePicker() {
  if (activeTabId == null) return;
  const type = pickerArmed ? "sw-disarm-picker" : "sw-arm-picker";
  chrome.tabs.sendMessage(activeTabId, { type }).catch(() => {
    // No receiving end → no content script on this tab (origin not enabled, or the page predates it).
    pickerArmed = false;
    panel && panel.setMarkupActive(false);
  });
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !panel) return;
  // Only trust picker traffic from the tab we're currently bound to.
  if (sender.tab && sender.tab.id !== activeTabId) return;
  if (msg.type === "sw-picker-state") {
    pickerArmed = !!msg.active;
    panel.setMarkupActive(pickerArmed);
  } else if (msg.type === "sw-element-picked") {
    const more = panel.addElementContext(msg.ctx);
    panel.open();
    if (!more && activeTabId != null) chrome.tabs.sendMessage(activeTabId, { type: "sw-disarm-picker" }).catch(() => {});
  }
});

// --- Mount + tab-follow ----------------------------------------------------------------------------
async function mount() {
  const tab = await activeTab();
  activeTabId = tab ? tab.id : null;
  currentOrigin = tab ? originOf(tab.url) : null;
  const screen = tab ? screenOf(tab.url) : "";
  const init = await getCfg(currentOrigin);
  const conn = init.configured ? await probe(init.shimUrl, init.token) : { state: null };
  liveCfg = init; lastMeta = conn.meta || null; lastConn = conn;

  panel = createPanel({
    root: document.getElementById("root"),
    shimUrl: init.shimUrl, token: init.token, meta: conn.meta || null,
    conn: { state: conn.state, detail: conn.detail }, screen, origin: currentOrigin || "",
    configured: init.configured, autoReload: init.autoReload, autoCommit: init.autoCommit,
    model: init.model, geminiKey: init.geminiKey, pollInterval: init.pollInterval,
    imageInstructions: init.imageInstructions,
    onProbe: probe,
    onMarkup: togglePicker,
    onOpenOptions: () => chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {}),
    onSelectModel: (id) => currentOrigin &&
      chrome.runtime.sendMessage({ type: "setOrigin", origin: currentOrigin, value: { model: id } }).catch(() => {}),
    // Auto-reload-on-save now reloads the APP tab (the side panel isn't the page).
    onReload: () => { if (activeTabId != null) chrome.tabs.reload(activeTabId).catch(() => {}); },
    // The ✕ closes the side panel document itself.
    onClose: () => window.close(),
  });
  panel.open();
}

async function syncActiveTab() {
  if (!panel || syncing) return;
  syncing = true;
  try {
    const tab = await activeTab();
    const newId = tab ? tab.id : null;
    const newOrigin = tab ? originOf(tab.url) : null;
    const newScreen = tab ? screenOf(tab.url) : "";
    // Leaving a tab where the picker is still armed → disarm it there.
    if (newId !== activeTabId && pickerArmed && activeTabId != null)
      chrome.tabs.sendMessage(activeTabId, { type: "sw-disarm-picker" }).catch(() => {});
    activeTabId = newId;
    if (newOrigin === currentOrigin) { panel.setConfig({ screen: newScreen }); return; }  // same origin, new route
    currentOrigin = newOrigin;
    const next = await getCfg(newOrigin);
    const conn = next.configured ? await probe(next.shimUrl, next.token) : { state: null };
    liveCfg = next; lastMeta = conn.meta || null; lastConn = conn;
    panel.cancel();        // abort any in-flight run bound to the old origin
    panel.resetThread();   // fresh thread + cleared picks for the new origin
    panel.setConfig({
      shimUrl: next.shimUrl, token: next.token, meta: conn.meta || null,
      conn: { state: conn.state, detail: conn.detail }, screen: newScreen, origin: newOrigin || "",
      configured: next.configured, autoReload: next.autoReload, autoCommit: next.autoCommit,
      model: next.model, geminiKey: next.geminiKey, pollInterval: next.pollInterval,
      imageInstructions: next.imageInstructions,
    });
  } finally { syncing = false; }
}
chrome.tabs.onActivated.addListener(syncActiveTab);
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === activeTabId && (info.status === "complete" || info.url)) syncActiveTab(); });
chrome.windows.onFocusChanged.addListener((wid) => { if (wid !== chrome.windows.WINDOW_ID_NONE) syncActiveTab(); });

// Live config: an edit in Options for the current origin re-resolves and pushes to the panel, exactly
// like content/inject.js did, so enabling/changing this origin goes live with no panel reload.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.slidewrite || !panel) return;
  const nv = changes.slidewrite.newValue || {};
  const next = resolve({ ...((nv.origins || {})[currentOrigin] || null), geminiKey: nv.geminiKey || "", pollInterval: nv.pollInterval || 0 }, currentOrigin);
  const connChanged = next.shimUrl !== liveCfg.shimUrl || next.token !== liveCfg.token || next.configured !== liveCfg.configured;
  const c = connChanged ? (next.configured ? await probe(next.shimUrl, next.token) : { state: null }) : lastConn;
  const m = c.meta || (connChanged ? null : lastMeta);
  liveCfg = next; lastMeta = m; lastConn = c;
  panel.setConfig({ shimUrl: next.shimUrl, token: next.token, meta: m, conn: { state: c.state, detail: c.detail },
    autoReload: next.autoReload, autoCommit: next.autoCommit, configured: next.configured, model: next.model,
    geminiKey: next.geminiKey, pollInterval: next.pollInterval, imageInstructions: next.imageInstructions });
});

mount();
