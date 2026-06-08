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

// Toolbar icon click → toggle the slide-out panel in the active tab's content script.
// (No default_popup, so action.onClicked fires.) Inert if the origin isn't enabled — the content
// script only registers the listener once configured; open the options page to enable a new origin.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }).catch(() => {});
  }
});

// Keyboard shortcut → tell the active tab's content script to toggle the panel.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }).catch(() => {});
  }
});
