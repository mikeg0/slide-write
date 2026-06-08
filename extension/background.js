// Slide Write — background service worker.
// Owns the per-origin config in chrome.storage and serves get/set to options, popup, and the
// content script. No network access here (§10.4: "background.js … No network.").

const KEY = "slidewrite";

async function load() {
  const o = await chrome.storage.local.get(KEY);
  return o[KEY] || { origins: {} };
}
async function save(cfg) {
  await chrome.storage.local.set({ [KEY]: cfg });
}

// Message API. Config shape: { origins: { "<origin>": { enabled, token, shimUrl? } } }.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const cfg = await load();
    switch (msg && msg.type) {
      case "getAll":
        return sendResponse(cfg);
      case "getOrigin":
        return sendResponse(cfg.origins[msg.origin] || null);
      case "setOrigin": {
        cfg.origins[msg.origin] = { ...(cfg.origins[msg.origin] || {}), ...msg.value };
        await save(cfg);
        return sendResponse({ ok: true, value: cfg.origins[msg.origin] });
      }
      case "deleteOrigin": {
        delete cfg.origins[msg.origin];
        await save(cfg);
        return sendResponse({ ok: true });
      }
      case "openOptions": {
        // Content scripts can't call openOptionsPage directly — relay through here (the gear button).
        chrome.runtime.openOptionsPage();
        return sendResponse({ ok: true });
      }
      default:
        return sendResponse(null);
    }
  })();
  return true; // keep the channel open for the async response
});

// Toggle the panel in a tab's content script. If the content script isn't mounted (origin not
// enabled, or the page was opened before it was enabled), the message has no receiver and rejects —
// guide the user to setup instead of failing silently (the symptom: "the icon does nothing").
async function togglePanel(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
  } catch {
    openSetup(tab); // no receiving end → not wired up on this origin yet
  }
}

// Open the options page with this tab's origin pre-filled in the "add origin" form, so the user
// lands ready to enable it. (openOptionsPage can't carry a query param, so create the tab directly.)
function openSetup(tab) {
  let origin = "";
  try { origin = tab && tab.url ? new URL(tab.url).origin : ""; } catch { /* chrome://, etc. */ }
  const url = chrome.runtime.getURL("options.html") + (origin ? `?origin=${encodeURIComponent(origin)}` : "");
  chrome.tabs.create({ url });
}

// Toolbar icon click → toggle (or, if not yet wired up, open setup). (No default_popup, so
// action.onClicked fires.)
chrome.action.onClicked.addListener((tab) => { togglePanel(tab); });

// Keyboard shortcut → same path against the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  togglePanel(tab);
});
