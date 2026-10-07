/* Wallets page: overview, import, download control, wallet list with bulk actions. */
App.wallets = (() => {
  const { $, $$, esc, api, toast, money, confirm, renderPager, STATUS_LABEL } = App;
  const st = { page: 1, pageSize: 50, sort: 'wallet', dir: 'asc', search: '', status: '', issues: false };
  const selected = new Set();
  let pageIds = [];

  async function loadOverview() {
    const o = await api('/api/overview');
    const cur = App.currency();
    $('#overview').innerHTML = `
      <div><strong>${o.wallets}</strong><span>Wallets</span></div>
      <div><strong>${o.done}</strong><span>Up to date</span></div>
      <div><strong>${o.pending}</strong><span>Not downloaded yet</span></div>
      <div><strong class="${o.errors ? 'issues' : ''}">${o.errors}</strong><span>Failed to download</span></div>
      <div><strong class="${o.withIssues ? 'issues' : ''}">${o.withIssues}</strong><span>Wallets with issues</span></div>
      <div><strong>${Number(o.txns).toLocaleString()}</strong><span>Transactions</span></div>
      <div class="big"><strong>${money(o.closing)}</strong><span>Total balance, all wallets${cur ? ' (' + esc(cur) + ')' : ''}</span></div>`;
  }

  async function loadList() {
    const q = new URLSearchParams({
      page: st.page, pageSize: st.pageSize, sort: st.sort, dir: st.dir,
      search: st.search, status: st.status, issues: st.issues ? '1' : '',
    });
    const data = await api('/api/wallets?' + q);
    pageIds = data.wallets.map((w) => w.walletId);
    const tbody = $('#walletTable tbody');
    if (!data.wallets.length) {
      const fresh = data.total === 0 && !st.search && !st.status && !st.issues;
      tbody.innerHTML = `<tr><td colspan="9" class="empty">${fresh
        ? 'No wallets yet. Add your wallet IDs above, then choose “Update all wallets”.'
        : 'No wallets match these filters.'}</td></tr>`;
    } else {
      tbody.innerHTML = data.wallets.map((w) => `
        <tr>
          <td class="sel"><input type="checkbox" data-id="${esc(w.walletId)}" ${selected.has(w.walletId) ? 'checked' : ''} aria-label="Select ${esc(w.walletId)}" /></td>
          <td><a class="wallet-link" href="#/wallet/${encodeURIComponent(w.walletId)}">${esc(w.walletId)}</a>
              ${w.name ? `<span class="sub">${esc(w.name)}</span>` : ''}</td>
          <td class="num">${money(w.openingBalance)}</td>
          <td class="num">${money(w.totalCredit)}</td>
          <td class="num">${money(w.totalDebit)}</td>
          <td class="num"><strong>${money(w.closingBalance)}</strong></td>
          <td class="num">${w.txnCount.toLocaleString()}${w.failedCount ? `<span class="sub">${w.failedCount} failed</span>` : ''}</td>
          <td class="num">${w.flagCount ? `<span class="issues">${w.flagCount}</span>` : '–'}</td>
          <td><span class="status ${w.syncStatus}">${STATUS_LABEL[w.syncStatus] || w.syncStatus}</span>
              ${w.syncedUntil ? `<span class="sub">to ${w.syncedUntil}</span>` : ''}
              ${w.lastError ? `<span class="sub issues" title="${esc(w.lastError)}">${esc(w.lastError.slice(0, 90))}</span>` : ''}</td>
        </tr>`).join('');
    }
    $$('#walletTable th button').forEach((b) => b.classList.toggle('active', b.dataset.sort === st.sort));
    renderPager($('#walletPager'), data.total, st, loadList, 'wallets');
    syncSelectionUi();
  }

  function syncSelectionUi() {
    $('#bulkBar').hidden = selected.size === 0;
    $('#bulkCount').textContent = `${selected.size} selected`;
    const onPage = pageIds.filter((id) => selected.has(id)).length;
    $('#selectPage').checked = pageIds.length > 0 && onPage === pageIds.length;
    $('#selectPage').indeterminate = onPage > 0 && onPage < pageIds.length;
  }

  function refresh() {
    loadOverview().catch((e) => toast(e.message));
    loadList().catch((e) => toast(e.message));
  }

  // ---- table interactions
  $('#walletTable tbody').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id);
    syncSelectionUi();
  });
  $('#selectPage').addEventListener('change', (e) => {
    pageIds.forEach((id) => (e.target.checked ? selected.add(id) : selected.delete(id)));
    $$('#walletTable tbody input[data-id]').forEach((c) => (c.checked = e.target.checked));
    syncSelectionUi();
  });
  $$('#walletTable th button').forEach((b) => b.addEventListener('click', () => {
    if (st.sort === b.dataset.sort) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else { st.sort = b.dataset.sort; st.dir = b.dataset.sort === 'wallet' ? 'asc' : 'desc'; }
    st.page = 1;
    loadList();
  }));
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { st.search = e.target.value; st.page = 1; loadList(); }, 250);
  });
  $('#statusFilter').addEventListener('change', (e) => { st.status = e.target.value; st.page = 1; loadList(); });
  $('#issuesOnly').addEventListener('change', (e) => { st.issues = e.target.checked; st.page = 1; loadList(); });
  $('#btnZip').addEventListener('click', () => {
    toast('Preparing ZIP. With many wallets this can take a few minutes.');
    window.location.href = `/api/export/all.zip?format=${$('#zipFormat').value}`;
  });

  // ---- bulk actions
  $('#bulkClear').onclick = () => { selected.clear(); loadList(); };
  $('#bulkSync').onclick = () => App.sync.start({ walletIds: [...selected] });
  $('#bulkFull').onclick = async () => {
    if (await confirm({ title: 'Re-download selected wallets?', text: `All transactions for ${selected.size} wallets will be fetched again from day 1. Existing data is kept and updated.`, ok: 'Re-download' })) {
      App.sync.start({ walletIds: [...selected], full: true });
    }
  };
  $('#bulkDelete').onclick = async () => {
    const n = selected.size;
    if (!(await confirm({ title: `Delete ${n} wallets?`, text: 'Their downloaded transactions are deleted too. You can add and download them again later.', ok: 'Delete wallets', typeDelete: true }))) return;
    try {
      await api('/api/wallets/delete', { method: 'POST', body: { walletIds: [...selected] } });
      selected.clear();
      toast(`Deleted ${n} wallets`);
      refresh();
    } catch (e) { toast(e.message); }
  };

  // ---- import
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#importText').value = await file.text();
    $('#importMsg').className = 'msg';
    $('#importMsg').textContent = `Loaded ${file.name}. Choose “Add wallets” to import.`;
    e.target.value = '';
  });
  $('#btnImport').addEventListener('click', async () => {
    const msg = $('#importMsg');
    try {
      const r = await api('/api/wallets/import', { method: 'POST', body: { text: $('#importText').value } });
      msg.className = 'msg';
      msg.textContent = `Added or updated ${r.imported} wallets.` + (r.problems.length ? ' ' + r.problems.join(' ') : '');
      $('#importText').value = '';
      refresh();
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message;
    }
  });

  // ---- sync buttons
  $('#btnSyncAll').onclick = () => App.sync.start({});
  $('#btnSyncPending').onclick = () => App.sync.start({ onlyPending: true });
  $('#btnSyncErrors').onclick = () => App.sync.start({ onlyErrors: true });
  $('#btnStop').onclick = async () => { await api('/api/sync/stop', { method: 'POST' }); toast('Stopping after the current requests finish'); };

  function show() {
    const s = App.state.settings?.settings;
    if (s) {
      $('#syncHint').textContent = `Downloads every transaction from ${s.statement.startDate} to today, ${s.sync.concurrency} wallets at a time. Progress is saved, so a stopped download continues where it left off.`;
    }
    refresh();
  }

  return { show, refresh };
})();

/* Download progress, shared by all pages. */
App.sync = (() => {
  const { $, esc, api, toast } = App;
  let timer = null;
  let lastDone = -1;
  const listeners = new Set();

  async function start(body) {
    try {
      await api('/api/sync', { method: 'POST', body });
      toast('Download started');
      poll();
    } catch (err) {
      toast(err.message);
    }
  }

  async function poll() {
    clearTimeout(timer);
    let s;
    try { s = await api('/api/sync/status'); } catch { timer = setTimeout(poll, 4000); return; }
    render(s);
    if (s.done !== lastDone || !s.running) {
      lastDone = s.done;
      listeners.forEach((fn) => fn(s));
    }
    if (s.running) timer = setTimeout(poll, 1500);
  }

  function render(s) {
    $('#btnStop').hidden = !s.running;
    ['#btnSyncAll', '#btnSyncPending', '#btnSyncErrors', '#btnSyncOne', '#btnFullOne', '#bulkSync', '#bulkFull'].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = s.running;
    });
    if (!s.startedAt) return;
    $('#syncProgress').hidden = false;
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    $('#syncBar').style.width = pct + '%';
    const parts = [`${s.done} of ${s.total} wallets processed (${pct}%)`, `${s.fetchedTxns.toLocaleString()} transactions downloaded`];
    if (s.failed.length) parts.push(`${s.failed.length} failed`);
    if (s.retries) parts.push(`${s.retries} retries`);
    if (s.running && s.active.length) parts.push(`now: ${s.active.slice(0, 5).join(', ')}`);
    if (!s.running) parts.unshift(s.stopRequested ? 'Stopped.' : 'Finished.');
    $('#syncText').textContent = parts.join(' · ');
    $('#syncFailures').hidden = !s.failed.length;
    $('#syncFailList').innerHTML = s.failed.slice(0, 200).map((f) => `<li><strong>${esc(f.walletId)}</strong>: ${esc(f.error)}</li>`).join('');
  }

  return { start, poll, onChange: (fn) => listeners.add(fn) };
})();
