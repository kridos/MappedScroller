// MappedScroller background service worker.
// Keeps track of which two tabs are linked and relays messages between them.
//
// The content script runs in every frame of a linked tab, because file viewers and
// graders usually show the document inside an embedded frame. For each tab we pick
// one "active" frame: the one whose scrollable area is biggest, or the one the user
// last scrolled. Only active frames exchange anchors and scroll positions.

const DEFAULTS = { a: null, b: null, paused: false, mode: 'headings', numbered: true };
let cache = null;
// frames[tabId][frameId] = { score, anchors, contentHeight, url }
// claimed[tabId] = frameId the user last scrolled (overrides score)
let frameState = null;

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

async function getFrames() {
  if (!frameState) {
    const { frames } = await chrome.storage.session.get('frames');
    frameState = frames || { frames: {}, claimed: {} };
  }
  return frameState;
}

const saveFrames = () => chrome.storage.session.set({ frames: frameState }).catch(() => {});

async function resetFrames(tabId) {
  const f = await getFrames();
  delete f.frames[tabId];
  delete f.claimed[tabId];
  await saveFrames();
}

const isLinked = (s) => s.a != null && s.b != null;
const partnerOf = (s, tabId) => (tabId === s.a ? s.b : tabId === s.b ? s.a : null);

function activeFrame(f, tabId) {
  const frames = f.frames[tabId] || {};
  const claimed = f.claimed[tabId];
  if (claimed != null && frames[claimed] && frames[claimed].score > 0) return Number(claimed);
  let best = 0;
  let bestScore = 0;
  for (const [id, info] of Object.entries(frames)) {
    if (info.score > bestScore) { best = Number(id); bestScore = info.score; }
  }
  return best;
}

function tabConfig(s, lead = false) {
  const linked = isLinked(s);
  return { linked, enabled: linked && !s.paused, mode: s.mode, numbered: s.numbered, lead };
}

const sendToTab = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => {});

// Send to one frame. If that frame is gone, forget it and report failure.
async function sendToFrame(tabId, frameId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId });
    return true;
  } catch (_) {
    const f = await getFrames();
    if (f.frames[tabId] && f.frames[tabId][frameId]) {
      delete f.frames[tabId][frameId];
      if (Number(f.claimed[tabId]) === frameId) delete f.claimed[tabId];
      await saveFrames();
    }
    return false;
  }
}

// Give the partner tab's active frame the anchors of this tab's active frame.
async function deliverAnchors(fromTab, toTab) {
  const f = await getFrames();
  const src = (f.frames[fromTab] || {})[activeFrame(f, fromTab)];
  if (!src) return;
  const target = activeFrame(f, toTab);
  const ok = await sendToFrame(toTab, target, { type: 'anchors', anchors: src.anchors, contentHeight: src.contentHeight });
  if (!ok && activeFrame(f, toTab) !== target) await deliverAnchors(fromTab, toTab);
}

async function inject(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
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
      else if (url.startsWith('file:')) why = 'file access is off. Turn on "Allow access to file URLs" for MappedScroller on the extensions page';
      throw new Error(`Can't sync the ${label} tab: ${why}.`);
    }
  }

  for (const id of [old.a, old.b]) {
    if (id != null && id !== a && id !== b) {
      await sendToTab(id, { type: 'config', config: { linked: false, enabled: false } });
      await setBadge(id, '');
      await resetFrames(id);
    }
  }
  await resetFrames(a);
  await resetFrames(b);

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
      await resetFrames(id);
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
  const winA = ta.windowId;
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

// What the popup shows: which frame each tab is synced through, and match counts.
async function status() {
  const s = await getState();
  if (!isLinked(s)) return { state: s };
  const f = await getFrames();
  const out = { state: s };
  for (const key of ['a', 'b']) {
    const tabId = s[key];
    const frameId = activeFrame(f, tabId);
    const info = (f.frames[tabId] || {})[frameId];
    const res = await chrome.tabs.sendMessage(tabId, { type: 'status' }, { frameId }).catch(() => null);
    out[key] = res && {
      ...res,
      url: info ? info.url : '',
      inFrame: frameId !== 0,
      frames: Object.keys(f.frames[tabId] || {}).length,
    };
  }
  return out;
}

// --------------------------------------------------------- content messages

async function onAnchors(msg, tabId, frameId, url) {
  const s = await getState();
  const partner = partnerOf(s, tabId);
  if (partner == null) return;
  const f = await getFrames();
  const before = activeFrame(f, tabId);
  (f.frames[tabId] ||= {})[frameId] = {
    score: msg.score || 0,
    anchors: msg.anchors,
    contentHeight: msg.contentHeight,
    url,
  };
  await saveFrames();
  const after = activeFrame(f, tabId);
  if (after === frameId || after !== before) await deliverAnchors(tabId, partner);
  // A different frame took over here: it needs the partner's anchors too.
  if (after !== before) await deliverAnchors(partner, tabId);
}

async function onScrollTo(msg, tabId, frameId) {
  const s = await getState();
  const partner = partnerOf(s, tabId);
  if (partner == null || s.paused) return;
  const f = await getFrames();
  const current = activeFrame(f, tabId);
  if (frameId !== current) {
    // The user is scrolling a different frame. Switch to it if it's a big one
    // (not, say, a comments sidebar next to the document).
    const frames = f.frames[tabId] || {};
    const mine = frames[frameId] ? frames[frameId].score : 0;
    const theirs = frames[current] ? frames[current].score : 0;
    if (!msg.user || mine <= 0 || mine < 0.5 * theirs) return;
    f.claimed[tabId] = frameId;
    await saveFrames();
    await deliverAnchors(tabId, partner);
    await deliverAnchors(partner, tabId);
  }
  await sendToFrame(partner, activeFrame(f, partner), msg);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromExtensionPage = (sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (sender.tab && !fromExtensionPage) {
    const tabId = sender.tab.id;
    const frameId = sender.frameId || 0;
    if (msg.type === 'anchors') onAnchors(msg, tabId, frameId, sender.url || '');
    else if (msg.type === 'scrollTo') onScrollTo(msg, tabId, frameId);
    return false;
  }

  // From the popup.
  const handlers = {
    getState: async () => ({ state: await getState() }),
    status: () => status(),
    link: async () => ({ state: await link(msg) }),
    unlink: async () => ({ state: await unlink() }),
    setOptions: async () => ({ state: await setOptions(msg) }),
    togglePause: async () => ({ state: await togglePause() }),
    arrange: async () => ({ state: await arrange(msg) }),
  };
  const h = handlers[msg.type];
  if (!h) return false;
  h().then(
    (res) => sendResponse({ ok: true, ...res }),
    (e) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-sync') togglePause();
});

// A new document loaded in a linked tab: the tab itself, or a frame inside it
// (e.g. the viewer loading the file, or the grader switching to another student).
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  const s = await getState();
  if (partnerOf(s, tabId) == null) return;
  const f = await getFrames();
  if (frameId === 0) {
    await resetFrames(tabId);
  } else if (f.frames[tabId] && f.frames[tabId][frameId]) {
    delete f.frames[tabId][frameId];
    await saveFrames();
  }
});

chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId }) => {
  const s = await getState();
  if (partnerOf(s, tabId) == null) return;
  try {
    await inject(tabId, [frameId]);
  } catch (_) {
    return; // somewhere we can't run (e.g. chrome:// page)
  }
  await chrome.tabs.sendMessage(tabId, { type: 'config', config: tabConfig(s, tabId === s.a) }, { frameId }).catch(() => {});
  if (frameId === 0) await refreshBadges(s);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (partnerOf(s, tabId) != null) await unlink();
});
