const settings = require('./settings');
const { db, stmts } = require('./db');

/**
 * Rebuilds the full ledger for a wallet from day 1 and applies the balance rules:
 *   credit  -> +amount
 *   debit   -> -amount
 *   failed  ->  0 (listed, but no money moved)
 *   reverse -> undoes the original: reversal of a debit adds back, of a credit takes back.
 *              If the original can't be found, REVERSAL_DEFAULT_SIGN decides, and it's flagged.
 *
 * Every row also carries "flags": problems worth checking (balance mismatch with API,
 * reversal without original, double reversal, reversal larger than original...).
 */
function buildLedger(walletId) {
  const wallet = stmts.getWallet.get(walletId);
  if (!wallet) return null;

  const txns = stmts.txnsForWallet.all(walletId);
  const byRef = new Map(txns.map((t) => [t.ref, t]));
  const reversedSoFar = new Map(); // original ref -> amount reversed so far

  let balance = wallet.opening_balance;
  let lastDiff = 0;

  const rows = txns.map((t) => {
    const flags = [];
    let effect = 0;

    switch (t.category) {
      case 'credit':
        effect = t.amount;
        break;
      case 'debit':
        effect = -t.amount;
        break;
      case 'failed':
        effect = 0;
        break;
      case 'reverse': {
        const orig = t.reverse_of ? byRef.get(t.reverse_of) : null;
        if (!orig) {
          effect = settings.get().statement.reversalDefaultSign * t.amount;
          flags.push(
            t.reverse_of
              ? `Original transaction ${t.reverse_of} not found`
              : 'Reversal has no original transaction id'
          );
        } else if (orig.category === 'debit') {
          effect = t.amount;
        } else if (orig.category === 'credit') {
          effect = -t.amount;
        } else if (orig.category === 'failed') {
          effect = 0;
          flags.push(`Reverses a failed transaction (${orig.ref}); not applied to balance`);
        } else {
          effect = settings.get().statement.reversalDefaultSign * t.amount;
          flags.push(`Reverses another reversal (${orig.ref})`);
        }
        if (orig && (orig.category === 'debit' || orig.category === 'credit')) {
          const total = (reversedSoFar.get(orig.ref) || 0) + t.amount;
          reversedSoFar.set(orig.ref, total);
          if (total > orig.amount) flags.push(`Total reversed exceeds original amount of ${orig.ref}`);
          if (orig.occurred_at > t.occurred_at) flags.push(`Reversal is dated before its original ${orig.ref}`);
        }
        break;
      }
      default:
        flags.push(`Unknown category "${t.category}"`);
    }

    balance += effect;

    if (t.api_balance !== null && t.api_balance !== undefined) {
      const diff = t.api_balance - balance;
      if (diff !== lastDiff) {
        flags.push(diff === 0 ? 'Balance matches API again' : 'Balance differs from API balance');
        lastDiff = diff;
      }
    }

    return {
      ref: t.ref,
      occurredAt: t.occurred_at,
      date: t.local_date,
      category: t.category,
      description: t.description || '',
      amount: t.amount,
      effect,
      balance,
      apiBalance: t.api_balance,
      reverseOf: t.reverse_of,
      flags,
    };
  });

  return { wallet, rows };
}

function summarize(rows, openingBalance) {
  const s = {
    opening: openingBalance,
    closing: rows.length ? rows[rows.length - 1].balance : openingBalance,
    count: rows.length,
    credit: { count: 0, amount: 0 },
    debit: { count: 0, amount: 0 },
    failed: { count: 0, amount: 0 },
    reverse: { count: 0, amount: 0, net: 0 },
    flags: 0,
  };
  for (const r of rows) {
    const bucket = s[r.category];
    if (bucket) {
      bucket.count += 1;
      bucket.amount += r.amount;
    }
    if (r.category === 'reverse') s.reverse.net += r.effect;
    if (r.flags.length && !(r.flags.length === 1 && r.flags[0] === 'Balance matches API again')) s.flags += 1;
  }
  return s;
}

/**
 * Statement for a date range. Opening balance of the period = balance just before `from`.
 * `category` only filters the rows shown; totals always cover the whole period.
 */
function buildStatement(walletId, { from, to, category } = {}) {
  const ledger = buildLedger(walletId);
  if (!ledger) return null;
  const { wallet, rows } = ledger;

  let opening = wallet.opening_balance;
  const inPeriod = [];
  for (const r of rows) {
    if (from && r.date < from) {
      opening = r.balance;
      continue;
    }
    if (to && r.date > to) break;
    inPeriod.push(r);
  }

  const summary = summarize(inPeriod, opening);
  const shown = category ? inPeriod.filter((r) => r.category === category) : inPeriod;

  return {
    wallet: {
      walletId: wallet.wallet_id,
      name: wallet.name,
      openingBalance: wallet.opening_balance,
      syncStatus: wallet.sync_status,
      syncedUntil: wallet.synced_until,
      lastError: wallet.last_error,
    },
    period: { from: from || settings.get().statement.startDate, to: to || wallet.synced_until || null },
    summary,
    rows: shown,
  };
}

const updateSummaryStmt = db.prepare(`
  UPDATE wallets SET
    txn_count = @count, total_credit = @credit, total_debit = @debit,
    total_reversed = @reversed, failed_count = @failed, closing_balance = @closing, flag_count = @flags
  WHERE wallet_id = @wallet_id
`);

/** Recalculate and cache the dashboard numbers for a wallet. */
function refreshWalletSummary(walletId) {
  const ledger = buildLedger(walletId);
  if (!ledger) return;
  const s = summarize(ledger.rows, ledger.wallet.opening_balance);
  updateSummaryStmt.run({
    wallet_id: walletId,
    count: s.count,
    credit: s.credit.amount,
    debit: s.debit.amount,
    reversed: s.reverse.net,
    failed: s.failed.count,
    closing: s.closing,
    flags: s.flags,
  });
}

module.exports = { buildLedger, buildStatement, refreshWalletSummary };
