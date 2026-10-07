/**
 * A fake wallet API so the app can be tried before connecting the real one.
 * Generates a stable random history per wallet (credits, debits, failed, reversals).
 * Disable with ENABLE_MOCK_API=false.
 */
const express = require('express');
const { addDays, today } = require('./dates');

const router = express.Router();
const cache = new Map();
const MOCK_START = '2024-01-01'; // test data begins here

function seededRandom(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function history(walletId) {
  if (cache.has(walletId)) return cache.get(walletId);
  const rnd = seededRandom(walletId);
  const txns = [];
  let balance = 0;
  let n = 0;
  const end = today();
  for (let d = MOCK_START; d <= end; d = addDays(d, 1)) {
    const perDay = Math.floor(rnd() * 3); // 0-2 transactions per day
    const times = Array.from({ length: perDay }, () =>
      `${String(8 + Math.floor(rnd() * 12)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`
    ).sort();
    for (let i = 0; i < perDay; i++) {
      n += 1;
      const time = times[i];
      const id = `${walletId}-${String(n).padStart(6, '0')}`;
      const r = rnd();
      let t;
      const debits = txns.filter((x) => x.txn_type === 'DEBIT' && x.status === 'SUCCESS' && !x._reversed);
      if (r < 0.04 && debits.length) {
        const orig = debits[debits.length - 1 - Math.floor(rnd() * Math.min(5, debits.length))];
        orig._reversed = true;
        balance += orig.amount;
        t = { txn_type: 'REVERSAL', status: 'SUCCESS', amount: orig.amount, description: `Reversal of ${orig.txn_id}`, original_txn_id: orig.txn_id };
      } else if (r < 0.10) {
        t = { txn_type: rnd() < 0.5 ? 'DEBIT' : 'CREDIT', status: 'FAILED', amount: Math.round(rnd() * 50000) / 100, description: 'Declined', original_txn_id: null };
      } else if (r < 0.45 || balance < 100) {
        const amount = Math.round((50 + rnd() * 950) * 100) / 100;
        balance += amount;
        t = { txn_type: 'CREDIT', status: 'SUCCESS', amount, description: rnd() < 0.5 ? 'Top-up via card' : 'Bank transfer in', original_txn_id: null };
      } else {
        const amount = Math.round(Math.min(balance, 10 + rnd() * 400) * 100) / 100;
        balance -= amount;
        t = { txn_type: 'DEBIT', status: 'SUCCESS', amount, description: ['Bill payment', 'Merchant purchase', 'Transfer out', 'Mobile recharge'][Math.floor(rnd() * 4)], original_txn_id: null };
      }
      balance = Math.round(balance * 100) / 100;
      txns.push({ txn_id: id, created_at: `${d}T${time}Z`, balance_after: balance, ...t });
    }
  }
  cache.set(walletId, txns);
  return txns;
}

router.get('/wallets/:walletId/transactions', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!/^Bearer \S+/.test(auth)) return res.status(401).json({ error: 'Missing or invalid API key. Use Bearer authentication with any key, e.g. test-key.' });
  // Simulate occasional rate limiting so retries can be seen in action.
  if (Math.random() < 0.01) return res.status(429).set('Retry-After', '1').json({ error: 'Too many requests' });

  const { from_date, to_date } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const all = history(req.params.walletId).filter((t) => {
    const d = t.created_at.slice(0, 10);
    return (!from_date || d >= from_date) && (!to_date || d <= to_date);
  });
  const totalPages = Math.max(1, Math.ceil(all.length / limit));
  const data = all.slice((page - 1) * limit, page * limit).map(({ _reversed, ...t }) => t);

  setTimeout(() => res.json({ data, pagination: { page, total_pages: totalPages, total: all.length } }), 30);
});

module.exports = router;
