/**
 * App settings managed from the web interface, stored in the database.
 * The API key is encrypted (AES-256-GCM) and never sent back to the browser.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('./config');
const { db, dataDir } = require('./db');

const DEFAULTS = {
  api: {
    baseUrl: env.enableMockApi ? `http://localhost:${env.port}/mock` : '',
    path: '/wallets/{walletId}/transactions',
    method: 'GET',                 // GET | POST
    authType: 'bearer',            // bearer | header | query | basic | none
    authPrefix: 'Bearer',
    authHeaderName: 'x-api-key',
    authQueryName: 'api_key',
    extraHeaders: '',              // JSON object, e.g. {"x-merchant-id":"123"}
    walletIdParam: '',             // set if wallet id goes in a query/body parameter instead of the path
    fromParam: 'from_date',
    toParam: 'to_date',
    dateFormat: 'YYYY-MM-DD',      // see DATE_FORMATS
    pagination: 'page',            // page | offset | cursor | none
    pageParam: 'page',
    pageStart: 1,
    limitParam: 'limit',
    pageSize: 100,
    cursorParam: 'cursor',
    timeoutMs: 30000,
  },
  response: {
    listPath: 'data',
    totalPagesPath: 'pagination.total_pages',
    nextCursorPath: 'next_cursor',
  },
  fields: {
    id: 'txn_id',
    type: 'txn_type',
    status: 'status',
    amount: 'amount',
    date: 'created_at',
    description: 'description',
    originalId: 'original_txn_id',
    balanceAfter: 'balance_after',
    dateDayFirst: true,            // for dates like 05/03/2025: true = 5 March, false = May 3
    apiDatesTimezone: 'utc',       // utc | local : how to read API dates that have no timezone
  },
  values: {
    credit: 'CREDIT, CR',
    debit: 'DEBIT, DR',
    reverse: 'REVERSAL, REVERSE, REVERSED, REFUND',
    failedStatus: 'FAILED, FAILURE, DECLINED, REJECTED, ERROR, CANCELLED',
    signFallback: false,           // unknown type: negative amount = debit, positive = credit
    amountDivisor: 1,              // 100 if the API sends amounts in cents/fils/paise
  },
  statement: {
    startDate: '2024-01-01',
    windowDays: 30,
    timezone: 'UTC',
    currency: '',
    decimals: 2,
    reversalDefaultSign: 1,
  },
  sync: {
    concurrency: 5,
    maxRetries: 6,
  },
};

const ENUMS = {
  'api.method': ['GET', 'POST'],
  'api.authType': ['bearer', 'header', 'query', 'basic', 'none'],
  'api.dateFormat': ['YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYYMMDD', 'ISO', 'unix', 'unixms'],
  'api.pagination': ['page', 'offset', 'cursor', 'none'],
  'fields.apiDatesTimezone': ['utc', 'local'],
};

// ---------------------------------------------------------------- crypto ----
let secretBuf = null;
function secret() {
  if (secretBuf) return secretBuf;
  let raw = env.appSecret;
  if (!raw) {
    const file = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    raw = fs.readFileSync(file, 'utf8').trim();
  }
  secretBuf = crypto.createHash('sha256').update(raw).digest();
  return secretBuf;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

function decrypt(payload) {
  const [iv, tag, enc] = payload.split(':').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// -------------------------------------------------------------- settings ----
const getRow = db.prepare('SELECT value FROM settings WHERE key = ?');
const setRow = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
const delRow = db.prepare('DELETE FROM settings WHERE key = ?');

/** Copy only known keys, coerced to the type of the default value. */
function sanitize(input, defaults, prefix = '') {
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const v = input ? input[k] : undefined;
    if (def && typeof def === 'object') {
      out[k] = sanitize(v, def, key);
    } else if (v === undefined || v === null) {
      out[k] = def;
    } else if (typeof def === 'number') {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : def;
    } else if (typeof def === 'boolean') {
      out[k] = v === true || v === 'true' || v === 1 || v === '1';
    } else {
      out[k] = String(v).trim();
    }
    if (ENUMS[key] && !ENUMS[key].includes(out[k])) out[k] = def;
  }
  return out;
}

function validate(s) {
  const errors = [];
  if (s.api.baseUrl && !/^https?:\/\/.+/i.test(s.api.baseUrl)) errors.push('API base URL must start with http:// or https://');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.statement.startDate) || isNaN(new Date(s.statement.startDate))) errors.push('Start date must be a valid date');
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.statement.timezone }); }
  catch { errors.push(`Unknown timezone "${s.statement.timezone}". Use a name like Asia/Dubai or UTC.`); }
  if (s.api.extraHeaders) {
    try {
      const h = JSON.parse(s.api.extraHeaders);
      if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error();
    } catch { errors.push('Extra headers must be a JSON object, e.g. {"x-merchant-id": "123"}'); }
  }
  if (!s.fields.id) errors.push('The transaction ID field is required');
  if (!s.fields.amount) errors.push('The amount field is required');
  if (!s.fields.date) errors.push('The date field is required');
  if (s.api.pagination === 'page' && !s.api.pageParam) errors.push('Page parameter name is required for page-based paging');
  if (s.api.pagination === 'offset' && !s.api.pageParam) errors.push('Offset parameter name is required for offset paging');
  if (s.api.pagination === 'cursor' && (!s.api.cursorParam || !s.response.nextCursorPath)) errors.push('Cursor paging needs the cursor parameter and the next-cursor location');
  if (s.statement.decimals < 0 || s.statement.decimals > 6) errors.push('Decimals must be between 0 and 6');
  if (s.statement.windowDays < 1 || s.statement.windowDays > 3660) errors.push('Days per request must be between 1 and 3660');
  if (s.sync.concurrency < 1 || s.sync.concurrency > 50) errors.push('Wallets at a time must be between 1 and 50');
  if (s.sync.maxRetries < 0 || s.sync.maxRetries > 20) errors.push('Retries must be between 0 and 20');
  if (s.api.pageSize < 1) errors.push('Page size must be at least 1');
  if (!(s.values.amountDivisor > 0)) errors.push('Amount divisor must be greater than 0');
  s.statement.reversalDefaultSign = s.statement.reversalDefaultSign < 0 ? -1 : 1;
  return errors;
}

let cache = null;

function get() {
  if (!cache) {
    const row = getRow.get('config');
    cache = sanitize(row ? JSON.parse(row.value) : {}, DEFAULTS);
  }
  return cache;
}

/** Validate a (possibly partial) settings object merged over the current one, without saving. */
function prepare(input) {
  const current = get();
  const merged = sanitize(deepMerge(current, input || {}), DEFAULTS);
  return { settings: merged, errors: validate(merged) };
}

function save(input) {
  const { settings, errors } = prepare(input);
  if (errors.length) {
    const err = new Error(errors.map((x) => x.replace(/\.$/, '')).join('. ') + '.');
    err.errors = errors;
    throw err;
  }
  setRow.run('config', JSON.stringify(settings));
  cache = settings;
  return settings;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

// --------------------------------------------------------------- API key ----
function getApiKey() {
  const row = getRow.get('apiKey');
  if (!row) return '';
  try { return decrypt(row.value); }
  catch { return ''; } // secret changed: key must be entered again
}

function setApiKey(key) {
  if (key) setRow.run('apiKey', encrypt(String(key)));
  else delRow.run('apiKey');
}

function apiKeyInfo() {
  const row = getRow.get('apiKey');
  if (!row) return { set: false, hint: '', unreadable: false };
  const key = getApiKey();
  if (!key) return { set: false, hint: '', unreadable: true };
  return { set: true, hint: key.length > 6 ? `••••${key.slice(-4)}` : '••••', unreadable: false };
}

module.exports = { get, save, prepare, DEFAULTS, ENUMS, getApiKey, setApiKey, apiKeyInfo };
