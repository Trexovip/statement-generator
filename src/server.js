const path = require('path');
const express = require('express');
const archiver = require('archiver');
const env = require('./config');
const { db, stmts, addWallets } = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const { toMinor, toMajor } = require('./money');
const { localDate, today, addDays } = require('./dates');
const { requestPage, normalize, getPath } = require('./apiAdapter');
const { buildStatement, refreshWalletSummary } = require('./statement');
const { startSync, stopSync, getStatus } = require('./sync');
const { toCsv, toExcel, toPdf, summaryExcel, safeName } = require('./exporters');

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

if (env.enableMockApi) app.use('/mock', require('./mockApi'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/auth', auth.router);
app.use('/api', auth.requireLogin);

const wrap = (fn) => (req, res) =>
  Promise.resolve().then(() => fn(req, res)).catch((err) => {
    console.error(err.message);
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message, errors: err.errors });
    else res.end();
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function periodFrom(q) {
  const from = DATE_RE.test(q.from || '') ? q.from : undefined;
  const to = DATE_RE.test(q.to || '') ? q.to : undefined;
  const category = ['credit', 'debit', 'failed', 'reverse'].includes(q.category) ? q.category : undefined;
  return { from, to, category };
}
const hasTransactions = () => !!db.prepare('SELECT 1 FROM transactions LIMIT 1').get();

// ================================================================ SETTINGS
function settingsResponse() {
  return {
    settings: settings.get(),
    defaults: settings.DEFAULTS,
    apiKey: settings.apiKeyInfo(),
    mockAvailable: env.enableMockApi,
    mockUrl: `http://localhost:${env.port}/mock`,
    hasTransactions: hasTransactions(),
    syncRunning: getStatus().running,
  };
}

app.get('/api/settings', (req, res) => res.json(settingsResponse()));

/** Re-assign each transaction to its calendar day after a timezone change (in batches). */
function recomputeLocalDates() {
  const select = db.prepare('SELECT rowid AS id, occurred_at FROM transactions WHERE rowid > ? ORDER BY rowid LIMIT 20000');
  const update = db.prepare('UPDATE transactions SET local_date = ? WHERE rowid = ?');
  let last = 0;
  for (;;) {
    const rows = select.all(last);
    if (!rows.length) break;
    db.transaction(() => rows.forEach((r) => update.run(localDate(r.occurred_at), r.id)))();
    last = rows[rows.length - 1].id;
  }
}

app.put('/api/settings', wrap((req, res) => {
  if (getStatus().running) {
    const e = new Error('Stop the download before changing settings.');
    e.status = 409;
    throw e;
  }
  const before = settings.get();
  const { settings: next, errors } = settings.prepare(req.body.settings || {});
  if (errors.length) {
    const e = new Error(errors.map((x) => x.replace(/\.$/, '')).join('. ') + '.');
    e.errors = errors;
    throw e;
  }
  if (next.statement.decimals !== before.statement.decimals && hasTransactions()) {
    throw new Error('Decimals can\'t be changed after transactions are downloaded. Clear downloaded transactions first (Settings › Data).');
  }
  settings.save(next);
  if (req.body.apiKey === null) settings.setApiKey('');
  else if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) settings.setApiKey(req.body.apiKey.trim());

  if (next.statement.timezone !== before.statement.timezone && hasTransactions()) recomputeLocalDates();
  res.json(settingsResponse());
}));

/** Shrink a JSON response for display: first 2 items of each list, long strings cut. */
function preview(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) {
    const out = value.slice(0, 2).map((v) => preview(v, depth + 1));
    if (value.length > 2) out.push(`… ${value.length - 2} more items`);
    return out;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 60).map(([k, v]) => [k, preview(v, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '…';
  return value;
}

/** All field paths in an object, e.g. ["id", "amount", "meta.channel"]. */
function fieldPaths(obj, prefix = '', depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) fieldPaths(v, p, depth + 1, out);
    else out.push({ path: p, sample: Array.isArray(v) ? `[${v.length} items]` : v });
  }
  return out;
}

/** Try the connection with the settings on screen (not yet saved) and show what comes back. */
app.post('/api/settings/test', wrap(async (req, res) => {
  const { settings: s, errors } = settings.prepare(req.body.settings || {});
  if (errors.length) return res.status(400).json({ error: errors.map((x) => x.replace(/\.$/, '')).join('. ') + '.', errors });
  const key = typeof req.body.apiKey === 'string' && req.body.apiKey.trim() ? req.body.apiKey.trim() : settings.getApiKey();
  const walletId = String(req.body.walletId || '').trim();
  if (!walletId) throw new Error('Enter a wallet ID to test with');

  const end = DATE_RE.test(req.body.to || '') ? req.body.to : today();
  let start = DATE_RE.test(req.body.from || '') ? req.body.from : addDays(end, -(s.statement.windowDays - 1));
  if (!req.body.from && start < s.statement.startDate) start = s.statement.startDate;

  const out = { walletId, from: start, to: end, keyUsed: key ? (req.body.apiKey ? 'the new key you typed' : 'the saved key') : 'no key' };
  let page;
  try {
    page = await requestPage({ walletId, fromDate: start, toDate: end, cursor: null }, s, key);
  } catch (err) {
    return res.json({ ...out, ok: false, error: err.message, status: err.status, request: err.request, response: err.body ? preview(err.body) : null });
  }

  const results = page.items.map((it) => {
    try {
      const { raw, ...n } = normalize(it, s);
      return { ok: true, ...n };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  const errorsFound = results.filter((r) => !r.ok);
  const distinct = (p) => (p ? [...new Set(page.items.map((it) => getPath(it, p)).filter((v) => v !== undefined && v !== null && v !== '').map(String))].slice(0, 30) : []);

  res.json({
    ...out,
    ok: true,
    status: page.status,
    durationMs: page.durationMs,
    request: page.request,
    itemCount: page.items.length,
    nextCursor: page.nextCursor,
    mapped: results.slice(0, 25),
    errorCount: errorsFound.length,
    errorSamples: [...new Set(errorsFound.map((e) => e.error))].slice(0, 5),
    fieldsFound: page.items.length ? fieldPaths(page.items[0]) : [],
    typeValues: distinct(s.fields.type),
    statusValues: distinct(s.fields.status),
    response: preview(page.body),
  });
}));

app.post('/api/data/reset', wrap((req, res) => {
  if (getStatus().running) throw new Error('Stop the download first.');
  if (req.body.confirm !== 'DELETE') throw new Error('Type DELETE to confirm.');
  const scope = req.body.scope === 'all' ? 'all' : 'transactions';
  db.transaction(() => {
    db.prepare('DELETE FROM transactions').run();
    if (scope === 'all') db.prepare('DELETE FROM wallets').run();
    else db.prepare(`UPDATE wallets SET sync_status = 'pending', synced_until = NULL, last_error = NULL, last_synced_at = NULL,
      txn_count = 0, total_credit = 0, total_debit = 0, total_reversed = 0, failed_count = 0, closing_balance = opening_balance, flag_count = 0`).run();
  })();
  res.json({ ok: true, scope });
}));

// ================================================================= WALLETS
const SORTS = { wallet: 'wallet_id', closing: 'closing_balance', txns: 'txn_count', flags: 'flag_count', status: 'sync_status' };

function walletOut(w) {
  return {
    walletId: w.wallet_id,
    name: w.name,
    openingBalance: toMajor(w.opening_balance),
    closingBalance: toMajor(w.closing_balance),
    totalCredit: toMajor(w.total_credit),
    totalDebit: toMajor(w.total_debit),
    totalReversed: toMajor(w.total_reversed),
    txnCount: w.txn_count,
    failedCount: w.failed_count,
    flagCount: w.flag_count,
    syncStatus: w.sync_status,
    syncedUntil: w.synced_until,
    lastSyncedAt: w.last_synced_at,
    lastError: w.last_error,
  };
}

app.get('/api/wallets', (req, res) => {
  const search = `%${(req.query.search || '').trim()}%`;
  const status = ['pending', 'syncing', 'done', 'error'].includes(req.query.status) ? req.query.status : null;
  const issuesOnly = req.query.issues === '1';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  const sort = SORTS[req.query.sort] || 'wallet_id';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const where = `WHERE (wallet_id LIKE @search OR IFNULL(name,'') LIKE @search)
    ${status ? 'AND sync_status = @status' : ''} ${issuesOnly ? 'AND flag_count > 0' : ''}`;
  const params = { search, status, limit: pageSize, offset: (page - 1) * pageSize };
  const total = db.prepare(`SELECT COUNT(*) AS n FROM wallets ${where}`).get(params).n;
  const rows = db.prepare(`SELECT * FROM wallets ${where} ORDER BY ${sort} ${dir}, wallet_id LIMIT @limit OFFSET @offset`).all(params);
  res.json({ total, page, pageSize, wallets: rows.map(walletOut) });
});

app.get('/api/overview', (req, res) => {
  const o = db.prepare(`
    SELECT COUNT(*) AS wallets,
      IFNULL(SUM(sync_status = 'done'),0) AS done, IFNULL(SUM(sync_status = 'error'),0) AS errors,
      IFNULL(SUM(sync_status = 'pending'),0) AS pending, IFNULL(SUM(sync_status = 'syncing'),0) AS syncing,
      IFNULL(SUM(flag_count > 0),0) AS withIssues, IFNULL(SUM(txn_count),0) AS txns,
      IFNULL(SUM(closing_balance),0) AS closing, IFNULL(SUM(total_credit),0) AS credit, IFNULL(SUM(total_debit),0) AS debit
    FROM wallets`).get();
  res.json({ ...o, closing: toMajor(o.closing), credit: toMajor(o.credit), debit: toMajor(o.debit) });
});

/** Import from pasted text / CSV. Each line: wallet_id[,opening_balance[,name]]. Header row skipped. */
app.post('/api/wallets/import', wrap((req, res) => {
  const text = String(req.body.text || '');
  const rows = [];
  const seen = new Set();
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const id = cells[0];
    if (!id) return;
    if (i === 0 && /wallet|account|id/i.test(id) && !/\d/.test(id)) return;
    if (id.length > 200) { problems.push(`Line ${i + 1}: wallet ID too long, skipped`); return; }
    if (seen.has(id)) return;
    seen.add(id);
    let opening = 0;
    let hasOpening = 0;
    if (cells[1] !== undefined && cells[1] !== '') {
      const n = Number(cells[1].replace(/,/g, ''));
      if (Number.isFinite(n)) { opening = toMinor(n); hasOpening = 1; }
      else problems.push(`Line ${i + 1}: opening balance "${cells[1]}" is not a number, used 0`);
    }
    rows.push({ wallet_id: id, name: cells[2] || null, opening_balance: opening, has_opening: hasOpening });
  });
  if (!rows.length) throw new Error('No wallet IDs found. Put one wallet ID per line.');
  addWallets(rows);
  for (const r of rows) refreshWalletSummary(r.wallet_id);
  res.json({ imported: rows.length, problems });
}));

app.patch('/api/wallets/:id', wrap((req, res) => {
  const w = stmts.getWallet.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wallet not found' });
  if (req.body.openingBalance !== undefined) {
    const n = Number(req.body.openingBalance);
    if (!Number.isFinite(n)) throw new Error('Opening balance must be a number');
    db.prepare('UPDATE wallets SET opening_balance = ? WHERE wallet_id = ?').run(toMinor(n), w.wallet_id);
  }
  if (req.body.name !== undefined) {
    db.prepare('UPDATE wallets SET name = ? WHERE wallet_id = ?').run(String(req.body.name).trim() || null, w.wallet_id);
  }
  refreshWalletSummary(w.wallet_id);
  res.json(walletOut(stmts.getWallet.get(w.wallet_id)));
}));

app.post('/api/wallets/delete', wrap((req, res) => {
  if (getStatus().running) throw new Error('Stop the download before deleting wallets.');
  const ids = Array.isArray(req.body.walletIds) ? req.body.walletIds.map(String) : [];
  if (!ids.length) throw new Error('No wallets selected');
  const delT = db.prepare('DELETE FROM transactions WHERE wallet_id = ?');
  const delW = db.prepare('DELETE FROM wallets WHERE wallet_id = ?');
  db.transaction(() => ids.forEach((id) => { delT.run(id); delW.run(id); }))();
  res.json({ deleted: ids.length });
}));

// =============================================================== STATEMENT
function statementJson(st) {
  const m = toMajor;
  const s = st.summary;
  return {
    wallet: { ...st.wallet, openingBalance: m(st.wallet.openingBalance) },
    period: st.period,
    summary: {
      opening: m(s.opening), closing: m(s.closing), count: s.count, flags: s.flags,
      credit: { count: s.credit.count, amount: m(s.credit.amount) },
      debit: { count: s.debit.count, amount: m(s.debit.amount) },
      failed: { count: s.failed.count, amount: m(s.failed.amount) },
      reverse: { count: s.reverse.count, amount: m(s.reverse.amount), net: m(s.reverse.net) },
    },
    rows: st.rows.map((r) => ({ ...r, amount: m(r.amount), effect: m(r.effect), balance: m(r.balance), apiBalance: m(r.apiBalance) })),
  };
}

app.get('/api/wallets/:id/statement', wrap((req, res) => {
  const st = buildStatement(req.params.id, periodFrom(req.query));
  if (!st) return res.status(404).json({ error: 'Wallet not found' });
  res.json(statementJson(st));
}));

app.get('/api/wallets/:id/transactions/:ref', wrap((req, res) => {
  const t = db.prepare('SELECT raw FROM transactions WHERE wallet_id = ? AND ref = ?').get(req.params.id, req.params.ref);
  if (!t) return res.status(404).json({ error: 'Transaction not found' });
  res.json(t.raw ? JSON.parse(t.raw) : {});
}));

async function render(st, fmt) {
  if (fmt === 'csv') return { body: Buffer.from(toCsv(st), 'utf8'), type: 'text/csv; charset=utf-8' };
  if (fmt === 'xlsx') return { body: await toExcel(st), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (fmt === 'pdf') return { body: await toPdf(st), type: 'application/pdf' };
  throw new Error('Format must be csv, xlsx or pdf');
}

app.get('/api/wallets/:id/export.:fmt', wrap(async (req, res) => {
  const st = buildStatement(req.params.id, periodFrom(req.query));
  if (!st) return res.status(404).json({ error: 'Wallet not found' });
  const { body, type } = await render(st, req.params.fmt);
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="statement_${safeName(req.params.id)}.${req.params.fmt}"`);
  res.send(body);
}));

app.get('/api/export/summary.xlsx', wrap(async (req, res) => {
  const wallets = db.prepare('SELECT * FROM wallets ORDER BY wallet_id').all();
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="all_wallets_summary.xlsx"');
  res.send(await summaryExcel(wallets));
}));

app.get('/api/export/all.zip', wrap(async (req, res) => {
  const fmt = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'xlsx';
  const period = periodFrom(req.query);
  const wallets = db.prepare('SELECT * FROM wallets ORDER BY wallet_id').all();

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="statements_${fmt}_${today()}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (e) => { console.error(e); res.end(); });
  zip.pipe(res);

  let aborted = false;
  req.on('close', () => { aborted = !res.writableFinished; });
  zip.append(await summaryExcel(wallets), { name: '_summary_all_wallets.xlsx' });
  for (const w of wallets) {
    if (aborted) break;
    const { body } = await render(buildStatement(w.wallet_id, period), fmt);
    zip.append(body, { name: `statement_${safeName(w.wallet_id)}.${fmt}` });
    await new Promise((r) => setImmediate(r));
  }
  await zip.finalize();
}));

// ==================================================================== SYNC
app.post('/api/sync', wrap((req, res) => {
  const { walletIds, onlyErrors, onlyPending, full } = req.body || {};
  const s = settings.get();
  if (!s.api.baseUrl) throw new Error('Set up your API on the Settings page first.');
  if (s.api.authType !== 'none' && !settings.getApiKey()) {
    throw new Error('Add your API key on the Settings page first.');
  }
  let ids;
  if (Array.isArray(walletIds) && walletIds.length) ids = walletIds.map(String);
  else if (onlyErrors) ids = db.prepare("SELECT wallet_id FROM wallets WHERE sync_status = 'error'").pluck().all();
  else if (onlyPending) ids = db.prepare("SELECT wallet_id FROM wallets WHERE sync_status = 'pending'").pluck().all();
  else ids = db.prepare('SELECT wallet_id FROM wallets ORDER BY wallet_id').pluck().all();
  startSync(ids, { full: !!full });
  res.json(getStatus());
}));

app.get('/api/sync/status', (req, res) => res.json(getStatus()));
app.post('/api/sync/stop', (req, res) => { stopSync(); res.json(getStatus()); });

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message });
});

// First run with the test API: store a dummy key so it works out of the box.
if (env.enableMockApi && !settings.apiKeyInfo().set && settings.get().api.baseUrl.includes('/mock')) settings.setApiKey('test-key');

app.listen(env.port, () => {
  console.log(`Wallet statements running at http://localhost:${env.port}`);
  if (env.enableMockApi) console.log(`Test API available at http://localhost:${env.port}/mock`);
});
