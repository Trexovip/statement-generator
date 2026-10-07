const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'statements.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    wallet_id        TEXT PRIMARY KEY,
    name             TEXT,
    opening_balance  INTEGER NOT NULL DEFAULT 0,   -- minor units (e.g. fils / paise / cents)
    sync_status      TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | done | error
    synced_until     TEXT,                          -- last fully fetched date (YYYY-MM-DD)
    last_error       TEXT,
    last_synced_at   TEXT,
    -- cached summary, refreshed after every sync
    txn_count        INTEGER NOT NULL DEFAULT 0,
    total_credit     INTEGER NOT NULL DEFAULT 0,
    total_debit      INTEGER NOT NULL DEFAULT 0,
    total_reversed   INTEGER NOT NULL DEFAULT 0,
    failed_count     INTEGER NOT NULL DEFAULT 0,
    closing_balance  INTEGER NOT NULL DEFAULT 0,
    flag_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    wallet_id    TEXT NOT NULL,
    ref          TEXT NOT NULL,          -- unique transaction id from the API
    occurred_at  TEXT NOT NULL,          -- ISO timestamp (UTC)
    local_date   TEXT NOT NULL,          -- YYYY-MM-DD in configured timezone
    category     TEXT NOT NULL,          -- credit | debit | failed | reverse
    amount       INTEGER NOT NULL,       -- minor units, always positive
    description  TEXT,
    reverse_of   TEXT,                   -- for reversals: ref of the original transaction
    api_balance  INTEGER,                -- balance reported by the API after this txn (optional)
    raw          TEXT,                   -- original JSON from the API, for audit
    PRIMARY KEY (wallet_id, ref)
  );

  CREATE INDEX IF NOT EXISTS idx_txn_wallet_time ON transactions (wallet_id, occurred_at);

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    salt           TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
`);

const stmts = {
  upsertTxn: db.prepare(`
    INSERT INTO transactions
      (wallet_id, ref, occurred_at, local_date, category, amount, description, reverse_of, api_balance, raw)
    VALUES
      (@wallet_id, @ref, @occurred_at, @local_date, @category, @amount, @description, @reverse_of, @api_balance, @raw)
    ON CONFLICT (wallet_id, ref) DO UPDATE SET
      occurred_at = excluded.occurred_at,
      local_date  = excluded.local_date,
      category    = excluded.category,
      amount      = excluded.amount,
      description = excluded.description,
      reverse_of  = excluded.reverse_of,
      api_balance = excluded.api_balance,
      raw         = excluded.raw
  `),
  addWallet: db.prepare(`
    INSERT INTO wallets (wallet_id, name, opening_balance) VALUES (@wallet_id, @name, @opening_balance)
    ON CONFLICT (wallet_id) DO UPDATE SET
      name = COALESCE(excluded.name, wallets.name),
      opening_balance = CASE WHEN @has_opening THEN excluded.opening_balance ELSE wallets.opening_balance END
  `),
  getWallet: db.prepare('SELECT * FROM wallets WHERE wallet_id = ?'),
  txnsForWallet: db.prepare(
    'SELECT * FROM transactions WHERE wallet_id = ? ORDER BY occurred_at, rowid'
  ),
};

const upsertTransactions = db.transaction((rows) => {
  for (const r of rows) stmts.upsertTxn.run(r);
});

const addWallets = db.transaction((rows) => {
  for (const r of rows) stmts.addWallet.run(r);
});

module.exports = { db, stmts, upsertTransactions, addWallets, dataDir };
