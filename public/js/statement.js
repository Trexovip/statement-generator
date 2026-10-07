/* Statement page for one wallet. */
App.statement = (() => {
  const { $, esc, api, toast, money, confirm, showRaw, renderPager, STATUS_LABEL, TYPE_LABEL } = App;
  const st = { walletId: null, rows: [], page: 1, pageSize: 100 };
  const realFlags = (r) => r.flags.filter((f) => f !== 'Balance matches API again');

  function query() {
    const q = new URLSearchParams();
    if ($('#fFrom').value) q.set('from', $('#fFrom').value);
    if ($('#fTo').value) q.set('to', $('#fTo').value);
    if ($('#fType').value) q.set('category', $('#fType').value);
    return q.toString();
  }

  async function load() {
    const id = st.walletId;
    const qs = query();
    const data = await api(`/api/wallets/${encodeURIComponent(id)}/statement?${qs}`);
    const w = data.wallet;
    $('#stTitle').textContent = w.name ? `${w.walletId} · ${w.name}` : w.walletId;
    $('#stSub').innerHTML =
      `${STATUS_LABEL[w.syncStatus] || w.syncStatus}${w.syncedUntil ? ', downloaded up to ' + w.syncedUntil : ''}. ` +
      `Showing ${data.period.from} to ${data.period.to || 'today'}.` +
      (w.lastError ? `<span class="error-box">Last download failed: ${esc(w.lastError)}</span>` : '');
    if (document.activeElement !== $('#openingInput')) $('#openingInput').value = w.openingBalance;
    if (document.activeElement !== $('#nameInput')) $('#nameInput').value = w.name || '';

    const s = data.summary;
    const flagsText = s.flags ? `<span class="flag-note">${s.flags} ${s.flags === 1 ? 'row needs' : 'rows need'} checking</span>` : 'No issues found';
    $('#stFigures').innerHTML = `
      <div class="endpoint"><span>Opening balance</span><strong>${money(s.opening)}</strong><small>${esc(data.period.from)}</small></div>
      <div class="credit"><span>Credits</span><strong>+${money(s.credit.amount)}</strong><small>${s.credit.count} transactions</small></div>
      <div class="debit"><span>Debits</span><strong>−${money(s.debit.amount)}</strong><small>${s.debit.count} transactions</small></div>
      <div class="reverse"><span>Reversals (net)</span><strong>${s.reverse.net >= 0 ? '+' : '−'}${money(Math.abs(s.reverse.net))}</strong><small>${s.reverse.count} transactions</small></div>
      <div class="failed"><span>Failed, not applied</span><strong>${money(s.failed.amount)}</strong><small>${s.failed.count} transactions</small></div>
      <div class="endpoint"><span>Closing balance</span><strong>${money(s.closing)}</strong><small>${flagsText}</small></div>`;

    ['pdf', 'xlsx', 'csv'].forEach((f) => {
      $('#exp' + f[0].toUpperCase() + f.slice(1)).href = `/api/wallets/${encodeURIComponent(id)}/export.${f}?${qs}`;
    });
    st.rows = $('#fIssues').checked ? data.rows.filter((r) => realFlags(r).length) : data.rows;
    st.page = 1;
    renderRows();
  }

  function renderRows() {
    const tbody = $('#ledger tbody');
    if (!st.rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">No transactions here. If this wallet hasn't been downloaded yet, choose “Update this wallet”.</td></tr>`;
    } else {
      const start = (st.page - 1) * st.pageSize;
      tbody.innerHTML = st.rows.slice(start, start + st.pageSize).map((r) => {
        const flags = realFlags(r);
        const notes = [];
        if (r.category === 'failed') notes.push(`${money(r.amount)} not applied`);
        if (r.reverseOf) notes.push(`Reverses ${esc(r.reverseOf)}`);
        if (flags.length && r.apiBalance !== null) notes.push(`API balance: ${money(r.apiBalance)}`);
        return `<tr class="${r.category}${flags.length ? ' flagged' : ''}">
          <td>${r.date}<span class="time">${r.occurredAt.slice(11, 16)} UTC</span></td>
          <td class="ref"><button class="link-btn" data-ref="${esc(r.ref)}" title="Show what the API returned">${esc(r.ref)}</button></td>
          <td class="type">${TYPE_LABEL[r.category] || esc(r.category)}</td>
          <td>${esc(r.description)}</td>
          <td class="num credit-amt">${r.effect > 0 ? money(r.effect) : ''}</td>
          <td class="num debit-amt">${r.effect < 0 ? money(-r.effect) : ''}</td>
          <td class="num bal">${money(r.balance)}</td>
          <td class="notes">${notes.join('<br>')}${flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</td>
        </tr>`;
      }).join('');
    }
    renderPager($('#ledgerPager'), st.rows.length, st, () => { renderRows(); $('#ledger').scrollIntoView({ block: 'start' }); }, 'transactions');
  }

  $('#ledger tbody').addEventListener('click', async (e) => {
    const ref = e.target.dataset?.ref;
    if (!ref) return;
    try {
      const raw = await api(`/api/wallets/${encodeURIComponent(st.walletId)}/transactions/${encodeURIComponent(ref)}`);
      showRaw(`Transaction ${ref} as returned by the API`, raw);
    } catch (err) { toast(err.message); }
  });

  $('#btnApply').onclick = () => load().catch((e) => toast(e.message));
  $('#fIssues').onchange = () => load().catch((e) => toast(e.message));

  $('#btnSaveWallet').onclick = async () => {
    try {
      await api(`/api/wallets/${encodeURIComponent(st.walletId)}`, {
        method: 'PATCH', body: { openingBalance: $('#openingInput').value || 0, name: $('#nameInput').value },
      });
      toast('Wallet saved');
      load();
    } catch (e) { toast(e.message); }
  };

  $('#btnSyncOne').onclick = () => App.sync.start({ walletIds: [st.walletId] });
  $('#btnFullOne').onclick = async () => {
    if (await confirm({ title: 'Re-download this wallet?', text: 'All transactions are fetched again from day 1. Existing data is kept and updated.', ok: 'Re-download' })) {
      App.sync.start({ walletIds: [st.walletId], full: true });
    }
  };
  $('#btnDeleteOne').onclick = async () => {
    if (!(await confirm({ title: `Delete wallet ${st.walletId}?`, text: 'Its downloaded transactions are deleted too.', ok: 'Delete wallet', typeDelete: true }))) return;
    try {
      await api('/api/wallets/delete', { method: 'POST', body: { walletIds: [st.walletId] } });
      toast('Wallet deleted');
      location.hash = '#/';
    } catch (e) { toast(e.message); }
  };

  App.sync.onChange((s) => {
    if (!$('#viewStatement').hidden && !s.running && st.walletId) load().catch(() => {});
  });

  function show(id) {
    if (st.walletId !== id) {
      st.walletId = id;
      $('#fFrom').value = ''; $('#fTo').value = ''; $('#fType').value = ''; $('#fIssues').checked = false;
      $('#nameInput').value = ''; $('#openingInput').value = '';
    }
    load().catch((e) => {
      $('#stTitle').textContent = id;
      $('#stSub').innerHTML = `<span class="error-box">${esc(e.message)}</span>`;
      $('#stFigures').innerHTML = '';
      $('#ledger tbody').innerHTML = '';
    });
  }

  return { show };
})();
