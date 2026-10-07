const settings = require('./settings');
const { db, stmts, upsertTransactions } = require('./db');
const { fetchPage } = require('./apiAdapter');
const { localDate, today, addDays, minDate } = require('./dates');
const { toMinor } = require('./money');
const { refreshWalletSummary } = require('./statement');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  running: false,
  stopRequested: false,
  total: 0,
  done: 0,
  succeeded: 0,
  failed: [], // { walletId, error }
  active: new Set(),
  startedAt: null,
  finishedAt: null,
  fetchedTxns: 0,
  retries: 0,
};

const setStatus = db.prepare(
  'UPDATE wallets SET sync_status = ?, last_error = ? WHERE wallet_id = ?'
);
const setProgress = db.prepare('UPDATE wallets SET synced_until = ? WHERE wallet_id = ?');
const setFinished = db.prepare(
  "UPDATE wallets SET sync_status = 'done', last_error = NULL, last_synced_at = datetime('now') WHERE wallet_id = ?"
);

/** Retry rate-limit, timeout, network and 5xx errors with exponential backoff. */
async function withRetry(fn, label) {
  const maxRetries = settings.get().sync.maxRetries;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable || attempt >= maxRetries || state.stopRequested) throw err;
      const backoff = err.retryAfterMs ?? Math.min(60000, 1000 * 2 ** attempt) + Math.random() * 500;
      state.retries += 1;
      console.warn(`[retry ${attempt + 1}/${maxRetries}] ${label}: ${err.message} — waiting ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
}

function toRow(walletId, t) {
  if (!t.ref) throw new Error('Transaction without id (ref) returned by API');
  const when = new Date(t.occurredAt);
  if (isNaN(when)) throw new Error(`Invalid date "${t.occurredAt}" on transaction ${t.ref}`);
  if (!Number.isFinite(t.amount)) throw new Error(`Invalid amount on transaction ${t.ref}`);
  return {
    wallet_id: walletId,
    ref: t.ref,
    occurred_at: when.toISOString(),
    local_date: localDate(when),
    category: t.category,
    amount: toMinor(t.amount),
    description: t.description || null,
    reverse_of: t.reverseOf || null,
    api_balance: t.apiBalance === null || t.apiBalance === undefined ? null : toMinor(t.apiBalance),
    raw: t.raw ? JSON.stringify(t.raw) : null,
  };
}

/**
 * Fetch one wallet from where it left off (or day 1) to today, window by window.
 * Progress is saved after each window, so a stopped sync resumes, not restarts.
 * The last saved day is fetched again on resume; duplicates are merged by transaction id.
 */
async function syncWallet(walletId) {
  const wallet = stmts.getWallet.get(walletId);
  const { startDate, windowDays } = settings.get().statement;
  let from = wallet.synced_until && wallet.synced_until > startDate ? wallet.synced_until : startDate;
  const end = today();

  setStatus.run('syncing', null, walletId);

  while (from <= end) {
    if (state.stopRequested) throw new Error('Stopped by user');
    const to = minDate(addDays(from, windowDays - 1), end);

    let cursor = null;
    let pages = 0;
    do {
      if (++pages > 100000) throw new Error(`Too many pages for ${from}..${to}; check the paging settings`);
      const page = await withRetry(
        () => fetchPage({ walletId, fromDate: from, toDate: to, cursor }),
        `${walletId} ${from}..${to}`
      );
      const rows = page.transactions.map((t) => toRow(walletId, t));
      upsertTransactions(rows);
      state.fetchedTxns += rows.length;
      cursor = page.nextCursor;
      if (state.stopRequested && cursor) throw new Error('Stopped by user');
    } while (cursor);

    setProgress.run(to, walletId);
    from = addDays(to, 1);
  }

  refreshWalletSummary(walletId);
  setFinished.run(walletId);
}

/**
 * Start syncing a list of wallets in the background with limited concurrency.
 * @param {string[]} walletIds
 * @param {{full?: boolean}} opts  full = forget progress and re-download from day 1
 */
function startSync(walletIds, { full = false } = {}) {
  if (state.running) throw new Error('A sync is already running');
  if (!walletIds.length) throw new Error('No wallets to sync');

  if (full) {
    const reset = db.prepare('UPDATE wallets SET synced_until = NULL WHERE wallet_id = ?');
    db.transaction(() => walletIds.forEach((id) => reset.run(id)))();
  }

  Object.assign(state, {
    running: true,
    stopRequested: false,
    total: walletIds.length,
    done: 0,
    succeeded: 0,
    failed: [],
    active: new Set(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    fetchedTxns: 0,
    retries: 0,
  });

  const queue = [...walletIds];

  const worker = async () => {
    while (queue.length && !state.stopRequested) {
      const id = queue.shift();
      state.active.add(id);
      try {
        await syncWallet(id);
        state.succeeded += 1;
      } catch (err) {
        const message = err.message || String(err);
        setStatus.run('error', message, id);
        state.failed.push({ walletId: id, error: message });
        try { refreshWalletSummary(id); } catch (_) { /* keep going */ }
        console.error(`[sync] ${id} failed: ${message}`);
      } finally {
        state.active.delete(id);
        state.done += 1;
      }
    }
  };

  const workers = Array.from({ length: Math.min(settings.get().sync.concurrency, queue.length) }, worker);
  Promise.all(workers).finally(() => {
    // wallets never started because of a stop go back to their previous state
    if (queue.length) {
      const back = db.prepare(
        "UPDATE wallets SET sync_status = CASE WHEN synced_until IS NULL THEN 'pending' ELSE 'done' END WHERE wallet_id = ? AND sync_status = 'syncing'"
      );
      queue.forEach((id) => back.run(id));
    }
    state.running = false;
    state.finishedAt = new Date().toISOString();
    console.log(`[sync] finished: ${state.succeeded} ok, ${state.failed.length} failed`);
  });
}

function stopSync() {
  if (state.running) state.stopRequested = true;
}

function getStatus() {
  return {
    running: state.running,
    stopRequested: state.stopRequested,
    total: state.total,
    done: state.done,
    succeeded: state.succeeded,
    failed: state.failed,
    active: [...state.active],
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    fetchedTxns: state.fetchedTxns,
    retries: state.retries,
  };
}

// If the server was stopped mid-sync, those wallets are no longer syncing.
db.prepare("UPDATE wallets SET sync_status = 'error', last_error = 'Sync interrupted (server restarted). Run sync again to resume.' WHERE sync_status = 'syncing'").run();

module.exports = { startSync, stopSync, getStatus };
