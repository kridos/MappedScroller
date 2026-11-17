const $ = (id) => document.getElementById(id);
const call = (msg) => chrome.runtime.sendMessage(msg);

let state = null;

function tabLabel(t) {
  let host = '';
  try { host = new URL(t.url).hostname; } catch (_) {}
  const title = t.title || t.url || 'Untitled';
  return (title.length > 48 ? title.slice(0, 47) + '…' : title) + (host ? ' — ' + host : '');
}

function showError(text) {
  $('error').textContent = text || '';
  $('error').hidden = !text;
}

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

async function loadTabs() {
  const [tabs, [active]] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  for (const sel of [$('tabA'), $('tabB')]) {
    sel.innerHTML = '';
    for (const t of tabs) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = tabLabel(t);
      sel.appendChild(o);
    }
  }

  let a, b;
  if (state.a != null && state.b != null) {
    a = state.a; b = state.b;
  } else {
    a = active ? active.id : tabs[0] && tabs[0].id;
    // Default partner: neighbouring tab in the same window, else any other tab.
    const same = tabs.filter((t) => active && t.windowId === active.windowId && t.id !== a);
    const next = same.find((t) => t.index === active.index + 1) || same.find((t) => t.index === active.index - 1) || same[0];
    b = next ? next.id : (tabs.find((t) => t.id !== a) || {}).id;
  }
  if (a != null) $('tabA').value = a;
  if (b != null) $('tabB').value = b;
}

async function render() {
  const linked = state.a != null && state.b != null;
  document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;
  $('numbered').checked = state.numbered;

  $('pauseBtn').hidden = !linked;
  $('unlinkBtn').hidden = !linked;
  $('arrangeBtn').hidden = !linked;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  $('linkBtn').textContent = linked ? 'Re-link' : 'Link & sync';
  $('linkBtn').classList.toggle('primary', !linked);

  const st = $('status');
  if (!linked) {
    st.className = 'status off';
    st.textContent = 'Not linked';
    return;
  }
  st.className = 'status ' + (state.paused ? 'paused' : 'on');
  let text = state.paused ? 'Paused' : 'Synced';
  if (state.mode === 'headings') {
    const info = await chrome.tabs.sendMessage(state.a, { type: 'status' }).catch(() => null);
    if (info && info.partnerKnown) {
      text += info.matches
        ? ` · ${info.matches} matching heading${info.matches === 1 ? '' : 's'}`
        : ' · no matching headings found (using % instead)';
    }
  } else {
    text += ' · by % of page';
  }
  st.textContent = text;
}

async function act(msg) {
  showError('');
  const res = await call(msg);
  if (!res || !res.ok) {
    showError((res && res.error) || 'Something went wrong.');
    return false;
  }
  state = res.state;
  await render();
  return true;
}

$('swap').addEventListener('click', () => {
  const a = $('tabA').value;
  $('tabA').value = $('tabB').value;
  $('tabB').value = a;
});

$('linkBtn').addEventListener('click', async () => {
  const ok = await act({
    type: 'link',
    a: Number($('tabA').value),
    b: Number($('tabB').value),
    mode: selectedMode(),
    numbered: $('numbered').checked,
  });
  // Give the tabs a moment to exchange headings, then show the match count.
  if (ok) setTimeout(render, 600);
});

$('unlinkBtn').addEventListener('click', () => act({ type: 'unlink' }));
$('pauseBtn').addEventListener('click', () => act({ type: 'togglePause' }));

$('arrangeBtn').addEventListener('click', () => {
  const s = window.screen;
  act({
    type: 'arrange',
    left: s.availLeft || 0,
    top: s.availTop || 0,
    width: s.availWidth,
    height: s.availHeight,
  });
});

for (const el of document.querySelectorAll('input[name="mode"], #numbered')) {
  el.addEventListener('change', async () => {
    const msg = { type: 'setOptions', mode: selectedMode(), numbered: $('numbered').checked };
    if (state.a != null) {
      await act(msg);
      setTimeout(render, 600);
    } else {
      // Not linked yet: just remember the choice.
      state = { ...state, mode: msg.mode, numbered: msg.numbered };
    }
  });
}

(async () => {
  const res = await call({ type: 'getState' });
  state = res.state;
  await loadTabs();
  await render();
})();
