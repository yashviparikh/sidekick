const ADD_ID = "sidekick-add-site";
const REMOVE_ID = "sidekick-remove-site";
const SITES_KEY = "sidekick_enabled_sites";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: ADD_ID, title: "Add Sidekick to this website", contexts: ["page", "action"] });
  chrome.contextMenus.create({ id: REMOVE_ID, title: "Remove Sidekick from this website", contexts: ["page", "action"] });
});

function originPatternFor(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.url) return;
  const pattern = originPatternFor(tab.url);
  if (!pattern) return;

  if (info.menuItemId === ADD_ID) await enableOnSite(pattern, tab);
  else if (info.menuItemId === REMOVE_ID) await disableOnSite(pattern, tab.id);
});

async function enableOnSite(pattern, tab) {
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) return;

  await chrome.scripting.registerContentScripts([{
    id: "sidekick-" + pattern,
    matches: [pattern],
    js: ["content-worker.js"],
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-worker.js"] });

  const { [SITES_KEY]: sites = [] } = await chrome.storage.local.get(SITES_KEY);
  if (!sites.includes(pattern)) {
    await chrome.storage.local.set({ [SITES_KEY]: [...sites, pattern] });
  }
}

async function disableOnSite(pattern, tabId) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["sidekick-" + pattern] });
  } catch (err) {
    console.warn("[Sidekick] no registered script found for", pattern, err);
  }

  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch (err) {
    console.warn("[Sidekick] permission removal failed for", pattern, err);
  }

  const { [SITES_KEY]: sites = [] } = await chrome.storage.local.get(SITES_KEY);
  await chrome.storage.local.set({ [SITES_KEY]: sites.filter(s => s !== pattern) });

  chrome.tabs.sendMessage(tabId, { type: "SIDEKICK_DISABLE" }).catch(() => {});
}