/* Shared helpers for all pages. */
window.App = (() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { settings: null, user: null };

  const decimals = () => state.settings?.settings?.statement?.decimals ?? 2;
  const currency = () => state.settings?.settings?.statement?.currency || '';
  const money = (n) =>
    n === null || n === undefined || n === ''
      ? ''
      : Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals(), maximumFractionDigits: decimals() });

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.loginRequired) {
      App.auth.show();
      throw new Error('Please sign in');
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.errors = data.errors;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
  }

  /** Confirmation dialog. Resolves true if confirmed. */
  function confirm({ title, text, ok = 'Confirm', typeDelete = false }) {
    return new Promise((resolve) => {
      const d = $('#confirmDialog');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#confirmOk').textContent = ok;
      $('#confirmTypeWrap').hidden = !typeDelete;
      $('#confirmType').value = '';
      const okBtn = $('#confirmOk');
      okBtn.disabled = typeDelete;
      const onType = () => { okBtn.disabled = $('#confirmType').value !== 'DELETE'; };
      $('#confirmType').oninput = onType;
      d.onclose = () => resolve(d.returnValue === 'ok');
      d.returnValue = '';
      d.showModal();
      if (typeDelete) $('#confirmType').focus();
    });
  }

  function showRaw(title, obj) {
    $('#rawTitle').textContent = title;
    $('#rawBody').textContent = JSON.stringify(obj, null, 2);
    $('#rawDialog').showModal();
  }

  function renderPager(el, total, st, reload, noun) {
    const pages = Math.max(1, Math.ceil(total / st.pageSize));
    if (st.page > pages) st.page = pages;
    const start = total ? (st.page - 1) * st.pageSize + 1 : 0;
    const end = Math.min(total, st.page * st.pageSize);
    el.innerHTML = `<span>${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} ${noun}</span>
      <div class="btn-row">
        <select data-p="size" aria-label="Rows per page">${[50, 100, 200, 500].map((n) => `<option ${n === st.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button class="btn" data-p="prev" ${st.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button class="btn" data-p="next" ${st.page >= pages ? 'disabled' : ''}>Next</button>
      </div>`;
    el.querySelector('[data-p="prev"]').onclick = () => { st.page -= 1; reload(); };
    el.querySelector('[data-p="next"]').onclick = () => { st.page += 1; reload(); };
    el.querySelector('[data-p="size"]').onchange = (e) => { st.pageSize = Number(e.target.value); st.page = 1; reload(); };
  }

  async function loadSettings() {
    state.settings = await api('/api/settings');
    renderBanner();
    return state.settings;
  }

  function renderBanner() {
    const s = state.settings;
    const b = $('#banner');
    if (!s) { b.hidden = true; return; }
    const api = s.settings.api;
    let html = '';
    if (!api.baseUrl) html = 'Your wallet API isn\'t connected yet. <a href="#/settings">Set it up in Settings</a>.';
    else if (s.apiKey.unreadable) html = 'The saved API key can\'t be read (the app secret changed). <a href="#/settings">Enter the API key again</a>.';
    else if (api.authType !== 'none' && !s.apiKey.set) html = 'No API key saved. <a href="#/settings">Add your API key in Settings</a>.';
    else if (api.baseUrl.includes('/mock')) html = 'You\'re using the built-in test API with sample data. <a href="#/settings">Connect your real API</a>.';
    b.innerHTML = html;
    b.hidden = !html;
  }

  const STATUS_LABEL = { done: 'Up to date', pending: 'Not downloaded', syncing: 'Downloading', error: 'Failed' };
  const TYPE_LABEL = { credit: 'Credit', debit: 'Debit', reverse: 'Reversal', failed: 'Failed' };

  return { $, $$, esc, state, money, currency, api, toast, confirm, showRaw, renderPager, loadSettings, renderBanner, STATUS_LABEL, TYPE_LABEL };
})();
