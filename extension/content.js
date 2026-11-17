// MappedScroller content script.
// Injected into every frame of both linked tabs. (File viewers / graders usually show
// the document inside an embedded frame; background.js works out which frame in each
// tab holds the document and only talks to that one.) The active frame in each tab:
//   1. finds "anchors" on its page (headings + numbered question labels),
//   2. shares them with its partner tab (relayed by background.js),
//   3. when the user scrolls, maps its scroll position onto the partner's page
//      using the anchors both pages have in common, and tells the partner where to go.
(() => {
  // If an earlier copy of this script is on the page (e.g. left behind after the
  // extension was reloaded/updated, so it can no longer talk to the extension),
  // tell it to shut down and take over.
  const REPLACE_EVENT = 'mappedscroller:replace';
  document.dispatchEvent(new CustomEvent(REPLACE_EVENT));

  // Where in the viewport headings are lined up (0 = top, 1 = bottom).
  const REF_FRACTION = 0.3;
  // After applying a remote scroll, ignore our own scroll events for this long
  // (unless the user is touching this tab) so the two tabs don't echo each other.
  const ECHO_WINDOW_MS = 250;
  // A tab the user interacted with this recently is "driving" and ignores remote scrolls.
  const INPUT_WINDOW_MS = 300;
  const RESCAN_DEBOUNCE_MS = 400;

  let config = { enabled: false, mode: 'headings', numbered: true, lead: false };
  let scroller = null;
  let anchors = [];          // [{ key, y }] sorted by y
  let contentHeight = 0;
  let partner = null;        // { anchors, contentHeight }
  let mapPoints = [];        // [[localY, partnerY], ...] strictly increasing, incl. endpoints
  let matchCount = 0;
  let lastSentSignature = '';
  let lastRemoteApply = 0;
  let lastLocalInput = 0;
  let pointerDown = false;
  let rafPending = false;
  let rescanTimer = null;
  let observersOn = false;

  // ---------------------------------------------------------------- scroller

  const docScroller = () => document.scrollingElement || document.documentElement;
  const isDoc = (el) => el === docScroller();

  const scrollRange = (el) => el.scrollHeight - el.clientHeight;

  function canScroll(el) {
    if (isDoc(el)) {
      const oy = getComputedStyle(document.documentElement).overflowY;
      const by = document.body ? getComputedStyle(document.body).overflowY : '';
      return oy !== 'hidden' && oy !== 'clip' && by !== 'hidden' && by !== 'clip';
    }
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }

  // Is this box big enough to be "the page" (vs. a small scrolling widget)?
  function isMajor(el) {
    if (isDoc(el)) return true;
    const r = el.getBoundingClientRect();
    const vw = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const vh = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return vw > 0 && vh > 0 && vw * vh >= 0.25 * window.innerWidth * window.innerHeight;
  }

  // Pick the scroll container holding the page's content: of the big scrollable
  // boxes (including the document itself), the one with the most to scroll.
  // Handles normal pages, <body>-scrolling pages and app layouts with an inner scroller.
  function findScroller() {
    const se = docScroller();
    let best = canScroll(se) && scrollRange(se) > 0 ? se : null;
    let bestRange = best ? scrollRange(se) : 0;
    for (const el of document.body ? [document.body, ...document.body.querySelectorAll('*')] : []) {
      const range = scrollRange(el);
      if (range <= Math.max(50, bestRange)) continue;
      if (!canScroll(el) || !isMajor(el)) continue;
      best = el;
      bestRange = range;
    }
    return best || se;
  }

  const getTop = () => (isDoc(scroller) ? window.scrollY : scroller.scrollTop);
  const viewH = () => (isDoc(scroller) ? window.innerHeight : scroller.clientHeight);
  const fullH = () => (isDoc(scroller) ? docScroller().scrollHeight : scroller.scrollHeight);
  const maxTop = () => Math.max(0, fullH() - viewH());

  function setTop(y) {
    const opts = { top: y, behavior: 'instant' };
    if (isDoc(scroller)) window.scrollTo(opts); else scroller.scrollTo(opts);
  }

  // Y coordinate of an element within the scroller's content.
  function contentY(el) {
    const r = el.getBoundingClientRect();
    if (isDoc(scroller)) return r.top + window.scrollY;
    return r.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  // ----------------------------------------------------------------- anchors

  // Words that differ between e.g. "Practice Test 3" and "Practice Test 3 – Answers".
  const STRIP_WORDS = /\b(answers?|answer key|solutions?|key|explanations?|worked|suggested|marking scheme|mark scheme)\b/g;

  function normalize(text) {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(STRIP_WORDS, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 80);
  }

  const SECTION_RE = /^(?:section|part|chapter|unit)\s*#?\s*(\d{1,3}|[ivx]{1,5}|[a-h])\b/i;
  const QUESTION_RE = /^(?:question|problem|exercise|task|item|q|no\.?|#)\s*#?\s*(\d{1,3})([a-z])?\b/i;
  const BARE_NUM_RE = /^\(?(\d{1,3})([a-z])?[.):](?=\s|$)/i;
  // Cheap pre-filter for text nodes worth looking at.
  const MAYBE_LABEL_RE = /^\s*(?:\(?\d{1,3}[a-z]?[.):]|(?:question|problem|exercise|task|item|q|no\.?|#|section|part|chapter|unit)\s*#?\s*[\divx])/i;

  // Canonical key for "Question 3", "Q3", "3.", "(3)" -> "q:3"; "Part II" -> "s:ii".
  function labelKey(text) {
    const t = text.trim().slice(0, 60);
    let m = SECTION_RE.exec(t);
    if (m) return 's:' + m[1].toLowerCase();
    m = QUESTION_RE.exec(t) || BARE_NUM_RE.exec(t);
    if (m) return 'q:' + m[1] + (m[2] || '').toLowerCase();
    return null;
  }

  const isInlineish = (el) => {
    const d = getComputedStyle(el).display;
    return d.startsWith('inline') || d === 'contents';
  };

  function blockAncestor(el) {
    while (el && el !== document.body && isInlineish(el)) el = el.parentElement;
    return el;
  }

  function firstTextNode(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    return w.nextNode();
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'NAV', 'TEMPLATE']);

  function collectAnchors() {
    const found = new Map(); // element -> key

    // 1. Real headings.
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
      if (h.closest('nav')) continue;
      const text = h.textContent || '';
      const key = labelKey(text) || (normalize(text) ? 'h:' + normalize(text) : null);
      if (key) found.set(h, key);
    }

    if (config.numbered && document.body) {
      // 2. Blocks that *start* with a question/section label ("1.", "Q3", "Question 4:", "Part B").
      const seenBlocks = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          return MAYBE_LABEL_RE.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const block = blockAncestor(n.parentElement);
        if (!block || block === document.body || seenBlocks.has(block)) continue;
        seenBlocks.add(block);
        if (found.has(block) || block.closest('nav,h1,h2,h3,h4,h5,h6')) continue;
        if (firstTextNode(block) !== n) continue; // label must be at the start of its block
        let key = labelKey(n.data);
        if (!key && n.data.trim().length < 12) key = labelKey(block.textContent || '');
        if (key) found.set(block, key);
      }

      // 3. Auto-numbered <ol> items (number comes from CSS, not text).
      for (const ol of document.querySelectorAll('ol')) {
        if (ol.parentElement && ol.parentElement.closest('ol,ul,nav')) continue; // top-level lists only
        const start = ol.hasAttribute('start') ? ol.start : 1;
        let i = 0;
        for (const li of ol.children) {
          if (li.tagName !== 'LI') continue;
          const num = li.hasAttribute('value') ? li.value : start + i;
          i++;
          if (!found.has(li)) found.set(li, 'q:' + num);
        }
      }
    }

    const list = [];
    for (const [el, key] of found) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // hidden
      list.push({ key, y: Math.round(contentY(el)) });
    }
    list.sort((a, b) => a.y - b.y);

    // Disambiguate repeats ("Solution", or Q1..Q10 restarting in each section).
    const counts = new Map();
    for (const a of list) {
      const c = counts.get(a.key) || 0;
      counts.set(a.key, c + 1);
      a.key += '#' + c;
    }
    return list;
  }

  // -------------------------------------------------------------- mapping

  // Longest chain of matches that is increasing on both pages (drops out-of-order matches).
  function increasingChain(pts) {
    const tails = [], tailIdx = [], prev = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const y = pts[i][1];
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < y) lo = m + 1; else hi = m; }
      tails[lo] = y; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const out = [];
    for (let k = tails.length ? tailIdx[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pts[k]);
    return out.reverse();
  }

  function computeMap() {
    if (!partner) { mapPoints = []; matchCount = 0; return; }
    const theirs = new Map(partner.anchors.map((a) => [a.key, a.y]));
    const cand = [];
    let lastX = -Infinity;
    for (const a of anchors) {
      if (!theirs.has(a.key) || a.y <= lastX) continue;
      cand.push([a.y, theirs.get(a.key)]);
      lastX = a.y;
    }
    const chain = increasingChain(cand);
    matchCount = chain.length;
    const pts = [[0, 0]];
    for (const p of chain) {
      const last = pts[pts.length - 1];
      if (p[0] > last[0] && p[1] > last[1] && p[0] < contentHeight && p[1] < partner.contentHeight) pts.push(p);
    }
    pts.push([Math.max(contentHeight, pts[pts.length - 1][0] + 1), Math.max(partner.contentHeight, pts[pts.length - 1][1] + 1)]);
    mapPoints = pts;
  }

  // Piecewise-linear map from a Y on this page to the matching Y on the partner page.
  function mapY(y) {
    const pts = mapPoints;
    if (y <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (y <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + ((y - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return pts[pts.length - 1][1];
  }

  // ------------------------------------------------------------- messaging

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {
      // Extension was reloaded; this script is orphaned.
      teardown();
    }
  }

  // How much this frame looks like "the document": visible area of its main
  // scroller, or 0 if it has nothing to scroll. Used to pick a frame per tab.
  function frameScore() {
    if (!scroller || scrollRange(scroller) < 50) return 0;
    if (isDoc(scroller)) return window.innerWidth * window.innerHeight;
    const r = scroller.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? Math.round(w * h) : 0;
  }

  function sendAnchors(force) {
    const score = frameScore();
    const sig = score + '|' + contentHeight + '|' + anchors.map((a) => a.key + '@' + a.y).join(',');
    if (!force && sig === lastSentSignature) return;
    lastSentSignature = sig;
    send({ type: 'anchors', anchors, contentHeight, score });
  }

  function broadcastPosition() {
    if (!config.enabled || !scroller) return;
    const top = getTop(), vh = viewH(), max = maxTop();
    if (config.mode === 'percent' || !partner) {
      send({ type: 'scrollTo', frac: max > 0 ? top / max : 0, user: userIsDriving() });
      return;
    }
    // Reference line sits 30% down the viewport, but slides to the very top/bottom
    // near the ends so "top of page" maps to "top of page" and likewise for the bottom.
    let ref = vh * REF_FRACTION;
    if (top < ref) ref = top;
    else if (max - top < vh - ref) ref = vh - (max - top);
    send({ type: 'scrollTo', y: mapY(top + ref), refFrac: vh > 0 ? ref / vh : 0, user: userIsDriving() });
  }

  const userIsDriving = () => pointerDown || Date.now() - lastLocalInput < INPUT_WINDOW_MS;

  function applyRemote(msg) {
    if (!config.enabled || !scroller || userIsDriving()) return;
    const max = maxTop();
    let target = msg.frac != null ? msg.frac * max : msg.y - msg.refFrac * viewH();
    target = Math.min(max, Math.max(0, target));
    lastRemoteApply = Date.now();
    if (Math.abs(target - getTop()) >= 1) setTop(target);
  }

  // ------------------------------------------------------------- scanning

  function rescan() {
    rescanTimer = null;
    if (!config.enabled && !config.linked) return;
    if (!scroller || !scroller.isConnected || maxTop() <= 0) scroller = findScroller();
    contentHeight = fullH();
    anchors = collectAnchors();
    computeMap();
    sendAnchors(false);
  }

  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(rescan, RESCAN_DEBOUNCE_MS);
  }

  const mutationObs = new MutationObserver(scheduleRescan);
  const resizeObs = new ResizeObserver(scheduleRescan);

  function onScroll(e) {
    if (!config.enabled) return;
    const t = e.target === document ? docScroller() : e.target;
    if (!(t instanceof Element)) return;
    if (t !== scroller) {
      // The user is scrolling a different box than we picked. If it's a big,
      // page-sized one, it's the real content scroller: switch to it.
      if (!userIsDriving() || scrollRange(t) < 50 || !isMajor(t)) return;
      scroller = t;
      contentHeight = fullH();
      anchors = collectAnchors();
      computeMap();
      sendAnchors(false);
    }
    const now = Date.now();
    // Scroll caused by us applying the partner's position: don't echo it back.
    if (now - lastRemoteApply < ECHO_WINDOW_MS && !userIsDriving()) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; broadcastPosition(); });
  }

  const markInput = () => { lastLocalInput = Date.now(); };
  const onPointerDown = () => { pointerDown = true; markInput(); };
  const onPointerUp = () => { pointerDown = false; markInput(); };
  const onMouseMove = (e) => { if (pointerDown && e.buttons === 0) pointerDown = false; };

  function startObservers() {
    if (observersOn) return;
    observersOn = true;
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    for (const ev of ['wheel', 'keydown', 'touchstart', 'touchmove']) {
      window.addEventListener(ev, markInput, { capture: true, passive: true });
    }
    window.addEventListener('mousedown', onPointerDown, { capture: true, passive: true });
    window.addEventListener('mouseup', onPointerUp, { capture: true, passive: true });
    window.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    window.addEventListener('blur', onPointerUp);
    window.addEventListener('resize', scheduleRescan);
    window.addEventListener('load', scheduleRescan);
    mutationObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    resizeObs.observe(document.documentElement);
    if (document.body) resizeObs.observe(document.body);
  }

  function stopObservers() {
    if (!observersOn) return;
    observersOn = false;
    window.removeEventListener('scroll', onScroll, { capture: true });
    for (const ev of ['wheel', 'keydown', 'touchstart', 'touchmove']) {
      window.removeEventListener(ev, markInput, { capture: true });
    }
    window.removeEventListener('mousedown', onPointerDown, { capture: true });
    window.removeEventListener('mouseup', onPointerUp, { capture: true });
    window.removeEventListener('mousemove', onMouseMove, { capture: true });
    window.removeEventListener('blur', onPointerUp);
    window.removeEventListener('resize', scheduleRescan);
    window.removeEventListener('load', scheduleRescan);
    mutationObs.disconnect();
    resizeObs.disconnect();
  }

  function teardown() {
    clearTimeout(rescanTimer);
    stopObservers();
    config = { enabled: false, linked: false };
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) {}
  }

  // ------------------------------------------------------------ messages in

  function onMessage(msg, _sender, sendResponse) {
    switch (msg.type) {
      case 'config': {
        const wasLinked = config.linked;
        config = { ...config, ...msg.config };
        if (config.linked) {
          startObservers();
          if (!wasLinked) partner = null;
          clearTimeout(rescanTimer);
          rescan();
          sendAnchors(true);
        } else {
          stopObservers();
          partner = null;
          mapPoints = [];
        }
        break;
      }
      case 'anchors':
        partner = { anchors: msg.anchors, contentHeight: msg.contentHeight };
        computeMap();
        if (config.lead) { config.lead = false; broadcastPosition(); }
        break;
      case 'requestAnchors':
        sendAnchors(true);
        break;
      case 'scrollTo':
        applyRemote(msg);
        break;
      case 'status':
        sendResponse({ anchors: anchors.length, matches: matchCount, partnerKnown: !!partner, score: frameScore() });
        return;
      case 'resync':
        broadcastPosition();
        break;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener(REPLACE_EVENT, teardown, { once: true });
})();
