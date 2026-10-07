/* Settings page: API connection + key, field mapping, statement options, test, data. */
App.settingsPage = (() => {
  const { $, $$, esc, api, toast, confirm, money } = App;

  let saved = null;     // settings as stored on the server
  let draft = null;     // settings being edited
  let key = { action: 'keep', value: '' }; // keep | replace | clear
  let lastMappingInput = null;

  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const set = (obj, path, v) => {
    const ks = path.split('.');
    let o = obj;
    ks.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
    o[ks[ks.length - 1]] = v;
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const timezones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } })();

  // ------------------------------------------------------------------ schema
  const SECTIONS = [
    {
      id: 'connection', title: 'API connection',
      intro: 'Where the app gets transactions for one wallet. Use {walletId} in the path where the wallet ID goes.',
      fields: [
        { key: 'api.baseUrl', label: 'API base URL', type: 'text', placeholder: 'https://api.yourprovider.com/v1', wide: true },
        { key: 'api.path', label: 'Transactions endpoint path', type: 'text', placeholder: '/wallets/{walletId}/transactions', wide: true,
          help: 'Appended to the base URL. Leave {walletId} out if the wallet ID is sent as a parameter instead.' },
        { key: 'api.method', label: 'Request method', type: 'select', options: [['GET', 'GET (parameters in the URL)'], ['POST', 'POST (parameters as JSON body)']] },
        { key: 'api.authType', label: 'Authentication', type: 'select', options: [
          ['bearer', 'Authorization header (Bearer token)'], ['header', 'Custom header (e.g. x-api-key)'],
          ['query', 'Key in the URL (query parameter)'], ['basic', 'Basic auth (username:password)'], ['none', 'No authentication'] ] },
        { key: '_apiKey', label: 'API key', type: 'apikey', showIf: (d) => d.api.authType !== 'none', wide: true },
        { key: 'api.authPrefix', label: 'Header prefix', type: 'text', placeholder: 'Bearer', showIf: (d) => d.api.authType === 'bearer',
          help: 'Sent as "Authorization: <prefix> <key>". Some APIs use Token or nothing.' },
        { key: 'api.authHeaderName', label: 'Header name', type: 'text', placeholder: 'x-api-key', showIf: (d) => d.api.authType === 'header' },
        { key: 'api.authQueryName', label: 'Parameter name', type: 'text', placeholder: 'api_key', showIf: (d) => d.api.authType === 'query' },
        { key: 'api.extraHeaders', label: 'Extra headers (optional)', type: 'textarea', placeholder: '{"x-merchant-id": "12345"}', wide: true,
          help: 'JSON object with any other headers your API needs.' },
      ],
    },
    {
      id: 'request', title: 'Request parameters',
      intro: 'Names of the parameters your API expects. Leave a name empty if the API doesn\'t use it.',
      fields: [
        { key: 'api.walletIdParam', label: 'Wallet ID parameter', type: 'text', placeholder: 'Empty = wallet ID is in the path',
          help: 'Only if the wallet ID is sent as a parameter, e.g. wallet_id.' },
        { key: 'api.fromParam', label: '"From date" parameter', type: 'text', placeholder: 'from_date' },
        { key: 'api.toParam', label: '"To date" parameter', type: 'text', placeholder: 'to_date' },
        { key: 'api.dateFormat', label: 'Date format sent to the API', type: 'select', options: [
          ['YYYY-MM-DD', '2025-03-31'], ['DD-MM-YYYY', '31-03-2025'], ['DD/MM/YYYY', '31/03/2025'], ['MM/DD/YYYY', '03/31/2025'],
          ['YYYYMMDD', '20250331'], ['ISO', '2025-03-31T00:00:00 / T23:59:59'], ['unix', 'Unix seconds'], ['unixms', 'Unix milliseconds'] ] },
      ],
    },
    {
      id: 'paging', title: 'Paging',
      intro: 'How the API splits long lists into pages.',
      fields: [
        { key: 'api.pagination', label: 'Paging type', type: 'select', options: [
          ['page', 'Page numbers (page=1, 2, 3…)'], ['offset', 'Offset (offset=0, 100, 200…)'],
          ['cursor', 'Cursor / next token'], ['none', 'No paging (everything in one response)'] ] },
        { key: 'api.pageParam', label: 'Page parameter', type: 'text', placeholder: 'page', showIf: (d) => d.api.pagination === 'page' },
        { key: 'api.pageParam', id: 'offsetParam', label: 'Offset parameter', type: 'text', placeholder: 'offset', showIf: (d) => d.api.pagination === 'offset' },
        { key: 'api.pageStart', label: 'First page number', type: 'select', options: [[1, '1'], [0, '0']], number: true, showIf: (d) => d.api.pagination === 'page' },
        { key: 'api.limitParam', label: 'Page size parameter', type: 'text', placeholder: 'limit', showIf: (d) => d.api.pagination !== 'none' },
        { key: 'api.pageSize', label: 'Transactions per page', type: 'number', min: 1, showIf: (d) => d.api.pagination !== 'none',
          help: 'Use the maximum your API allows; fewer requests means faster downloads.' },
        { key: 'response.totalPagesPath', label: 'Where the total page count is', type: 'text', placeholder: 'pagination.total_pages', showIf: (d) => d.api.pagination === 'page',
          help: 'Path in the response. Leave empty to keep going until a page comes back with fewer items.' },
        { key: 'api.cursorParam', label: 'Cursor parameter', type: 'text', placeholder: 'cursor', showIf: (d) => d.api.pagination === 'cursor' },
        { key: 'response.nextCursorPath', label: 'Where the next cursor is', type: 'text', placeholder: 'next_cursor', showIf: (d) => d.api.pagination === 'cursor' },
      ],
    },
    {
      id: 'mapping', title: 'Response fields',
      intro: 'Where each value is in the API response. Use dots for nested fields, e.g. data.items or meta.balance. After testing, click a field box here and then a field name in the test results to fill it in.',
      fields: [
        { key: 'response.listPath', label: 'List of transactions', type: 'text', placeholder: 'data', mapping: true,
          help: 'Leave empty if the response itself is the list.' },
        { key: 'fields.id', label: 'Transaction ID', type: 'text', mapping: true, required: true },
        { key: 'fields.date', label: 'Date / time', type: 'text', mapping: true, required: true },
        { key: 'fields.amount', label: 'Amount', type: 'text', mapping: true, required: true },
        { key: 'fields.type', label: 'Type (credit / debit / reversal)', type: 'text', mapping: true },
        { key: 'fields.status', label: 'Status (success / failed)', type: 'text', mapping: true },
        { key: 'fields.description', label: 'Description', type: 'text', mapping: true },
        { key: 'fields.originalId', label: 'Original transaction ID (for reversals)', type: 'text', mapping: true },
        { key: 'fields.balanceAfter', label: 'Balance after transaction', type: 'text', mapping: true,
          help: 'Optional. Used to check the calculated balance.' },
        { key: 'fields.dateDayFirst', label: 'Dates like 05/03/2025 mean', type: 'select', options: [[true, '5 March (day first)'], [false, 'May 3 (month first)']], bool: true },
        { key: 'fields.apiDatesTimezone', label: 'API times without a timezone are in', type: 'select', options: [['utc', 'UTC'], ['local', 'The statement timezone']] },
      ],
    },
    {
      id: 'types', title: 'Transaction types',
      intro: 'Which values in the type and status fields mean what. Separate values with commas; capital letters don\'t matter. The test shows the values your API uses.',
      fields: [
        { key: 'values.credit', label: 'Credit values', type: 'text', placeholder: 'CREDIT, CR, TOPUP', wide: true },
        { key: 'values.debit', label: 'Debit values', type: 'text', placeholder: 'DEBIT, DR, PAYMENT', wide: true },
        { key: 'values.reverse', label: 'Reversal values', type: 'text', placeholder: 'REVERSAL, REFUND', wide: true },
        { key: 'values.failedStatus', label: 'Failed status values', type: 'text', placeholder: 'FAILED, DECLINED', wide: true,
          help: 'Transactions with these statuses are listed but don\'t change the balance.' },
        { key: 'values.signFallback', label: 'If the type is unknown', type: 'select', bool: true,
          options: [[false, 'Stop and report an error (safest)'], [true, 'Use the amount sign: negative = debit, positive = credit']] },
        { key: 'values.amountDivisor', label: 'Amounts are sent as', type: 'select', number: true,
          options: [[1, 'Normal amounts (12.50)'], [100, 'Smallest unit, divide by 100 (1250 = 12.50)'], [1000, 'Divide by 1000 (12500 = 12.500)']] },
      ],
    },
    {
      id: 'statement', title: 'Statements',
      fields: [
        { key: 'statement.startDate', label: 'Day 1 of the statements', type: 'date',
          help: 'Moving this earlier? Re-download wallets from day 1 to fetch the older history.' },
        { key: 'statement.timezone', label: 'Timezone', type: 'timezone', help: 'Decides which calendar day each transaction belongs to.' },
        { key: 'statement.currency', label: 'Currency label', type: 'text', placeholder: 'e.g. AED, INR, USD' },
        { key: 'statement.decimals', label: 'Decimal places', type: 'number', min: 0, max: 6, lockedWhenData: true },
        { key: 'statement.reversalDefaultSign', label: 'Reversal without a matching original', type: 'select', number: true,
          options: [[1, 'Treat as money coming back (credit)'], [-1, 'Treat as money going out (debit)']] },
      ],
    },
    {
      id: 'speed', title: 'Download speed',
      intro: 'Lower these if your API returns "too many requests" often.',
      fields: [
        { key: 'sync.concurrency', label: 'Wallets at a time', type: 'number', min: 1, max: 50 },
        { key: 'statement.windowDays', label: 'Days per request', type: 'number', min: 1, help: 'Use your API\'s maximum date range, e.g. 30 or 90.' },
        { key: 'sync.maxRetries', label: 'Retries per failed request', type: 'number', min: 0, max: 20 },
        { key: 'api.timeoutMs', label: 'Request timeout (milliseconds)', type: 'number', min: 1000 },
      ],
    },
  ];

  // ------------------------------------------------------------------ render
  function fieldHtml(f) {
    const id = 'set_' + (f.id || f.key.replace(/\./g, '_'));
    const v = get(draft, f.key);
    const help = f.help ? `<small class="help">${esc(f.help)}</small>` : '';
    const locked = f.lockedWhenData && App.state.settings.hasTransactions;
    let input;
    switch (f.type) {
      case 'apikey':
        return `<div class="field wide" data-field="${f.key}" data-id="${id}">${apiKeyHtml()}</div>`;
      case 'select':
        input = `<select id="${id}" data-key="${f.key}" ${f.bool ? 'data-bool' : ''} ${f.number ? 'data-number' : ''}>
          ${f.options.map(([val, text]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
        break;
      case 'textarea':
        input = `<textarea id="${id}" data-key="${f.key}" rows="2" placeholder="${esc(f.placeholder || '')}">${esc(v ?? '')}</textarea>`;
        break;
      case 'timezone':
        input = `<input id="${id}" data-key="${f.key}" list="tzList" value="${esc(v ?? '')}" autocomplete="off" />
          <datalist id="tzList">${timezones.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`;
        break;
      default:
        input = `<input id="${id}" data-key="${f.key}" type="${f.type}" ${f.type === 'number' ? 'data-number' : ''}
          ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}
          ${f.mapping ? 'data-mapping' : ''} ${locked ? 'disabled' : ''}
          value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}" spellcheck="false" />`;
    }
    const lockNote = locked ? '<small class="help">Locked because transactions are downloaded. Clear them under Data to change.</small>' : '';
    return `<div class="field ${f.wide ? 'wide' : ''}" data-field="${f.key}" data-id="${id}">
      <label for="${id}">${esc(f.label)}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>${input}${help}${lockNote}</div>`;
  }

  function apiKeyHtml() {
    const info = App.state.settings.apiKey;
    let status;
    if (key.action === 'replace') status = '<span class="key-state new">New key will be saved</span>';
    else if (key.action === 'clear') status = '<span class="key-state warn">Key will be removed</span>';
    else if (info.set) status = `<span class="key-state ok">Saved key ${esc(info.hint)}</span>`;
    else if (info.unreadable) status = '<span class="key-state warn">Saved key can\'t be read; enter it again</span>';
    else status = '<span class="key-state warn">No key saved</span>';

    const showInput = key.action === 'replace' || (!info.set && key.action !== 'clear');
    return `<label for="apiKeyInput">API key</label>
      <div class="key-row">
        ${status}
        ${info.set && key.action === 'keep' ? '<button type="button" class="btn small" data-keyact="replace">Replace key</button><button type="button" class="btn small danger" data-keyact="clear">Remove key</button>' : ''}
        ${key.action !== 'keep' ? '<button type="button" class="btn small" data-keyact="keep">Cancel</button>' : ''}
      </div>
      ${showInput ? `<div class="key-input">
        <input id="apiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your API key or token" value="${esc(key.value)}" />
        <button type="button" class="btn small" data-keyact="toggle">Show</button>
      </div>` : ''}
      <small class="help">Stored encrypted on this server and never shown again in full. For basic auth, enter username:password.</small>`;
  }

  function render() {
    const html = SECTIONS.map((sec) => `
      <section class="panel set-section" id="sec_${sec.id}">
        <h2>${esc(sec.title)}</h2>
        ${sec.intro ? `<p class="hint">${esc(sec.intro)}</p>` : ''}
        <div class="field-grid">${sec.fields.map(fieldHtml).join('')}</div>
      </section>`).join('') + dataSectionHtml();
    $('#settingsForm').innerHTML = html;
    applyVisibility();
    updateDirty();
  }

  function dataSectionHtml() {
    return `<section class="panel set-section danger-zone" id="sec_data">
      <h2>Data</h2>
      <p class="hint">Settings, the API key and your login are kept in both cases.</p>
      <div class="btn-row">
        <button type="button" class="btn danger" id="btnClearTxns">Clear downloaded transactions</button>
        <button type="button" class="btn danger" id="btnClearAll">Delete all wallets and transactions</button>
      </div>
    </section>`;
  }

  function applyVisibility() {
    SECTIONS.forEach((sec) => sec.fields.forEach((f) => {
      if (!f.showIf) return;
      const id = 'set_' + (f.id || f.key.replace(/\./g, '_'));
      const el = $(`.field[data-id="${id}"]`);
      if (el) el.hidden = !f.showIf(draft);
    }));
  }

  function isDirty() {
    return JSON.stringify(draft) !== JSON.stringify(saved) || key.action !== 'keep';
  }
  function updateDirty() {
    const dirty = isDirty();
    $('#saveState').textContent = dirty ? 'You have unsaved changes' : 'All changes saved';
    $('#btnSaveSettings').disabled = !dirty;
    $('#btnRevert').disabled = !dirty;
  }

  function readInput(el) {
    let v = el.value;
    if (el.hasAttribute('data-bool')) v = v === 'true';
    else if (el.hasAttribute('data-number')) v = v === '' ? '' : Number(v);
    set(draft, el.dataset.key, v);
  }

  // ------------------------------------------------------------------ events
  $('#settingsForm').addEventListener('input', (e) => {
    if (e.target.id === 'apiKeyInput') {
      key.value = e.target.value;
      if (key.value) key.action = 'replace';
      else if (!App.state.settings.apiKey.set) key.action = 'keep';
      updateDirty();
      return;
    }
    if (!e.target.dataset.key) return;
    readInput(e.target);
    // two inputs share api.pageParam (page/offset): keep them in sync
    $$(`[data-key="${e.target.dataset.key}"]`).forEach((el) => { if (el !== e.target) el.value = e.target.value; });
    applyVisibility();
    updateDirty();
  });
  $('#settingsForm').addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' && e.target.dataset.key) { readInput(e.target); applyVisibility(); updateDirty(); }
  });
  $('#settingsForm').addEventListener('focusin', (e) => {
    if (e.target.hasAttribute('data-mapping')) {
      lastMappingInput = e.target;
      $$('.field.picking').forEach((x) => x.classList.remove('picking'));
      e.target.closest('.field').classList.add('picking');
    }
  });
  $('#settingsForm').addEventListener('click', async (e) => {
    const act = e.target.dataset?.keyact;
    if (act) {
      if (act === 'toggle') {
        const inp = $('#apiKeyInput');
        inp.type = inp.type === 'password' ? 'text' : 'password';
        e.target.textContent = inp.type === 'password' ? 'Show' : 'Hide';
        return;
      }
      key = act === 'keep' ? { action: 'keep', value: '' } : { action: act, value: '' };
      $('.field[data-field="_apiKey"]').innerHTML = apiKeyHtml();
      if (act === 'replace') $('#apiKeyInput')?.focus();
      updateDirty();
      return;
    }
    if (e.target.id === 'btnClearTxns' || e.target.id === 'btnClearAll') {
      const all = e.target.id === 'btnClearAll';
      const ok = await confirm({
        title: all ? 'Delete all wallets and transactions?' : 'Clear downloaded transactions?',
        text: all ? 'Every wallet and every downloaded transaction is deleted.' : 'All downloaded transactions are deleted. Your wallet list and opening balances are kept, and you can download again.',
        ok: all ? 'Delete everything' : 'Clear transactions', typeDelete: true,
      });
      if (!ok) return;
      try {
        await api('/api/data/reset', { method: 'POST', body: { scope: all ? 'all' : 'transactions', confirm: 'DELETE' } });
        toast(all ? 'All wallets and transactions deleted' : 'Downloaded transactions cleared');
        await load();
      } catch (err) { toast(err.message); }
    }
  });

  $('#btnRevert').onclick = () => { draft = clone(saved); key = { action: 'keep', value: '' }; render(); };

  $('#btnSaveSettings').onclick = async () => {
    const body = { settings: draft };
    if (key.action === 'replace') {
      if (!key.value.trim()) { toast('Enter the new API key, or cancel replacing it'); return; }
      body.apiKey = key.value.trim();
    }
    if (key.action === 'clear') body.apiKey = null;
    try {
      App.state.settings = await api('/api/settings', { method: 'PUT', body });
      App.renderBanner();
      saved = clone(App.state.settings.settings);
      draft = clone(saved);
      key = { action: 'keep', value: '' };
      render();
      toast('Settings saved');
    } catch (err) {
      toast(err.message);
    }
  };

  $('#btnUseMock').onclick = () => {
    const d = clone(App.state.settings.defaults);
    d.api.baseUrl = App.state.settings.mockUrl;
    d.statement = { ...d.statement, ...draft.statement };
    d.sync = draft.sync;
    draft = d;
    key = { action: 'replace', value: 'test-key' };
    render();
    toast('Test API filled in. Test it, then save.');
  };

  // -------------------------------------------------------------------- test
  $('#btnTest').onclick = async () => {
    const out = $('#testResult');
    const body = { settings: draft, walletId: $('#testWallet').value, from: $('#testFrom').value, to: $('#testTo').value };
    if (key.action === 'replace' && key.value.trim()) body.apiKey = key.value.trim();
    out.innerHTML = '<p class="hint">Contacting the API…</p>';
    $('#btnTest').disabled = true;
    try {
      const r = await api('/api/settings/test', { method: 'POST', body });
      out.innerHTML = r.ok ? successHtml(r) : failureHtml(r);
    } catch (err) {
      out.innerHTML = `<div class="result bad"><strong>Can't test yet</strong><p>${esc(err.message)}</p></div>`;
    } finally {
      $('#btnTest').disabled = false;
    }
  };

  function requestHtml(req) {
    if (!req) return '';
    return `<details><summary>Request sent</summary><pre class="json">${esc(`${req.method} ${req.url}\n` +
      Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') + (req.body ? `\n\n${req.body}` : ''))}</pre></details>`;
  }
  const responseHtml = (resp, open) => resp === null || resp === undefined ? '' :
    `<details ${open ? 'open' : ''}><summary>Response from the API</summary><pre class="json">${esc(typeof resp === 'string' ? resp : JSON.stringify(resp, null, 2))}</pre></details>`;

  function failureHtml(r) {
    return `<div class="result bad"><strong>Connection failed${r.status ? ` (HTTP ${r.status})` : ''}</strong><p>${esc(r.error)}</p>
      <small>Wallet ${esc(r.walletId)}, ${esc(r.from)} to ${esc(r.to)}, using ${esc(r.keyUsed)}.</small></div>
      ${requestHtml(r.request)}${responseHtml(r.response, true)}`;
  }

  function successHtml(r) {
    const good = r.itemCount > 0 && r.errorCount === 0;
    const head = r.itemCount === 0
      ? `<div class="result warn"><strong>Connected, but no transactions came back</strong>
          <p>Try a wallet and date range that has transactions, or check the "List of transactions" location against the response below.</p></div>`
      : r.errorCount
        ? `<div class="result warn"><strong>Connected. ${r.errorCount} of ${r.itemCount} transactions couldn't be read</strong>
            <ul>${r.errorSamples.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
        : `<div class="result ok"><strong>Connected. All ${r.itemCount} transactions on the first page were read correctly</strong></div>`;

    const meta = `<p class="test-meta">HTTP ${r.status} in ${r.durationMs} ms · wallet ${esc(r.walletId)}, ${esc(r.from)} to ${esc(r.to)} · ${
      r.nextCursor !== null && r.nextCursor !== undefined ? `more pages: yes (next ${esc(String(r.nextCursor).slice(0, 30))})` : 'no more pages'} · ${esc(r.keyUsed)}</p>`;

    const values = (r.typeValues.length || r.statusValues.length) ? `<div class="values">
      ${r.typeValues.length ? `<p><span>Type values found:</span> ${r.typeValues.map((v) => `<code>${esc(v)}</code>`).join(' ')}</p>` : ''}
      ${r.statusValues.length ? `<p><span>Status values found:</span> ${r.statusValues.map((v) => `<code>${esc(v)}</code>`).join(' ')}</p>` : ''}
      <small class="help">Make sure each of these is listed under Transaction types.</small></div>` : '';

    const fields = r.fieldsFound.length ? `<div class="fields-found"><p><span>Fields in each transaction</span> <small class="help">Click a box under Response fields, then a name here.</small></p>
      <div class="chips">${r.fieldsFound.map((f) => `<button type="button" class="chip" data-path="${esc(f.path)}" title="${esc(String(f.sample).slice(0, 80))}">${esc(f.path)}</button>`).join('')}</div></div>` : '';

    const rows = r.mapped.map((m) => m.ok
      ? `<tr class="${m.category}"><td>${esc(m.ref)}</td><td>${esc(m.occurredAt.slice(0, 16).replace('T', ' '))}</td><td class="type">${App.TYPE_LABEL[m.category]}</td>
          <td class="num">${money(m.amount)}</td><td>${esc(m.reverseOf || '')}</td><td class="num">${m.apiBalance === null ? '' : money(m.apiBalance)}</td></tr>`
      : `<tr class="bad-row"><td colspan="6">${esc(m.error)}</td></tr>`).join('');
    const table = r.mapped.length ? `<div class="table-wrap"><table class="grid mini"><thead><tr><th>ID</th><th>Date (UTC)</th><th>Type</th><th class="num">Amount</th><th>Reverses</th><th class="num">API balance</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '';

    return head + meta + table + values + fields + requestHtml(r.request) + responseHtml(r.response, !good);
  }

  $('#testResult').addEventListener('click', (e) => {
    const p = e.target.dataset?.path;
    if (!p) return;
    if (!lastMappingInput) { toast('First click a box under Response fields'); return; }
    lastMappingInput.value = p;
    readInput(lastMappingInput);
    updateDirty();
    toast(`Set to ${p}`);
  });

  window.addEventListener('beforeunload', (e) => { if (draft && isDirty() && !$('#viewSettings').hidden) { e.preventDefault(); e.returnValue = ''; } });

  // -------------------------------------------------------------------- load
  async function load() {
    const s = await App.loadSettings();
    saved = clone(s.settings);
    draft = clone(s.settings);
    key = { action: 'keep', value: '' };
    $('#btnUseMock').hidden = !s.mockAvailable;
    render();
    if (!$('#testWallet').value) {
      try {
        const w = await api('/api/wallets?pageSize=1');
        if (w.wallets[0]) $('#testWallet').value = w.wallets[0].walletId;
      } catch { /* ignore */ }
    }
  }

  function show() {
    load().catch((e) => toast(e.message));
  }

  const hasUnsaved = () => !!draft && isDirty();
  return { show, hasUnsaved };
})();
