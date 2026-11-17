// MappedScroller background service worker.
// Keeps track of which two tabs are linked and relays messages between them.

const DEFAULTS = { a: null, b: null, paused: false, mode: 'headings', numbered: true };
let cache = null;

async function getState() {
  if (!cache) {
    const { state } = await chrome.storage.session.get('state');
    cache = { ...DEFAULTS, ...(state || {}) };
  }
  return cache;
}

async function setState(patch) {
  cache = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state: cache });
  return cache;
}

const isLinked = (s) => s.a != null && s.b != null;
const partnerOf = (s, tabId) => (tabId === s.a ? s.b : tabId === s.b ? s.a : null);

function tabConfig(s, lead = false) {
  const linked = isLinked(s);
  return { linked, enabled: linked && !s.paused, mode: s.mode, numbered: s.numbered, lead };
}

const sendToTab = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => {});

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: text === 'ON' ? '#2563eb' : '#6b7280' });
  } catch (_) { /* tab gone */ }
}

async function refreshBadges(s) {
  const text = isLinked(s) ? (s.paused ? '||' : 'ON') : '';
  for (const id of [s.a, s.b]) if (id != null) await setBadge(id, text);
}

async function pushConfig(s, leadTab = null) {
  for (const id of [s.a, s.b]) {
    if (id != null) await sendToTab(id, { type: 'config', config: tabConfig(s, id === leadTab) });
  }
  await refreshBadges(s);
}

// ------------------------------------------------------------------ actions

async function link({ a, b, mode, numbered }) {
  if (a == null || b == null || a === b) throw new Error('Pick two different tabs.');
  const old = await getState();

  for (const [id, label] of [[a, 'first'], [b, 'second']]) {
    try {
      await inject(id);
    } catch (e) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      const url = tab && tab.url ? tab.url : '';
      let why = "the browser doesn't allow extensions on that page";
      if (/\.pdf($|[?#])/i.test(url)) why = "it's a PDF in the browser's built-in viewer, which extensions can't read";
      else if (url.startsWith('file:')) why = 'file access is off — enable "Allow access to file URLs" for MappedScroller in the extensions page';
      throw new Error(`Can't sync the ${label} tab: ${why}.`);
    }
  }

  // Release tabs from a previous link that aren't part of the new one.
  for (const id of [old.a, old.b]) {
    if (id != null && id !== a && id !== b) {
      await sendToTab(id, { type: 'config', config: { linked: false, enabled: false } });
      await setBadge(id, '');
    }
  }

  const s = await setState({
    a, b, paused: false,
    mode: mode || old.mode,
    numbered: numbered ?? old.numbered,
  });
  // Tab A leads: once it has B's anchors, it pulls B into alignment.
  await pushConfig(s, a);
  return s;
}

async function unlink() {
  const s = await getState();
  for (const id of [s.a, s.b]) {
    if (id != null) {
      await sendToTab(id, { type: 'config', config: { linked: false, enabled: false } });
      await setBadge(id, '');
    }
  }
  return setState({ a: null, b: null, paused: false });
}

async function setOptions({ mode, numbered }) {
  const patch = {};
  if (mode) patch.mode = mode;
  if (numbered != null) patch.numbered = numbered;
  const s = await setState(patch);
  if (isLinked(s)) await pushConfig(s, s.a);
  return s;
}

async function togglePause() {
  const s0 = await getState();
  if (!isLinked(s0)) return s0;
  const s = await setState({ paused: !s0.paused });
  await pushConfig(s, s.paused ? null : s.a);
  return s;
}

// Put the two tabs in side-by-side windows filling the given screen area.
async function arrange({ left, top, width, height }) {
  const s = await getState();
  if (!isLinked(s)) throw new Error('Link two tabs first.');
  const ta = await chrome.tabs.get(s.a);
  const tb = await chrome.tabs.get(s.b);
  let winA = ta.windowId;
  let winB = tb.windowId;
  if (winA === winB) {
    const w = await chrome.windows.create({ tabId: s.b, focused: false });
    winB = w.id;
  }
  const half = Math.floor(width / 2);
  await chrome.windows.update(winA, { state: 'normal', left, top, width: half, height });
  await chrome.windows.update(winB, { state: 'normal', left: left + half, top, width: width - half, height });
  await chrome.tabs.update(s.a, { active: true });
  await chrome.tabs.update(s.b, { active: true });
  await chrome.windows.update(winA, { focused: true });
  return s;
}

// ----------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From a content script: relay to the partner tab.
  const fromExtensionPage = (sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (sender.tab && !fromExtensionPage) {
    (async () => {
      const s = await getState();
      const partner = partnerOf(s, sender.tab.id);
      if (partner == null) return;
      if (msg.type === 'scrollTo' && s.paused) return;
      if (msg.type === 'scrollTo' || msg.type === 'anchors') await sendToTab(partner, msg);
    })();
    return false;
  }

  // From the popup.
  const handlers = {
    getState: () => getState(),
    link: () => link(msg),
    unlink: () => unlink(),
    setOptions: () => setOptions(msg),
    togglePause: () => togglePause(),
    arrange: () => arrange(msg),
  };
  const h = handlers[msg.type];
  if (!h) return false;
  h().then(
    (state) => sendResponse({ ok: true, state }),
    (e) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-sync') togglePause();
});

// A linked tab navigated or reloaded: re-inject and re-exchange anchors.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const s = await getState();
  const partner = partnerOf(s, tabId);
  if (partner == null) return;
  try {
    await inject(tabId);
  } catch (_) {
    return; // navigated somewhere we can't run (e.g. chrome:// page)
  }
  await sendToTab(tabId, { type: 'config', config: tabConfig(s, tabId === s.a) });
  await sendToTab(partner, { type: 'requestAnchors' });
  await refreshBadges(s);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (partnerOf(s, tabId) != null) await unlink();
});
