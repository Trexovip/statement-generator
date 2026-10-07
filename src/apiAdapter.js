/**
 * Talks to your wallet API using the connection and field mapping from the Settings page.
 * Most APIs can be connected without code changes. If yours needs something unusual
 * (signed requests, token refresh...), customise buildRequest() or normalize() here.
 */
const settingsStore = require('./settings');
const { formatForApi, parseApiDate } = require('./dates');

class ApiError extends Error {
  constructor(message, { status = 0, retryAfterMs = null, retryable = false, request = null, body = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
    this.request = request;
    this.body = body;
  }
}

/** Read a value by path like "data.items" or "result.list[0].id". Empty path = the object itself. */
function getPath(obj, p) {
  if (!p) return obj;
  return String(p)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

const valueList = (v) => String(v || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const mask = (text, key) => (key && key.length >= 3 ? String(text).split(key).join('••••') : String(text));
const mask2 = (text, key) => mask(mask(text, key), key ? encodeURIComponent(key) : '');

/** Build the HTTP request for one page. */
function buildRequest({ walletId, fromDate, toDate, cursor }, s, apiKey) {
  const a = s.api;
  if (!a.baseUrl) throw new ApiError('API base URL is not set. Add it on the Settings page.');

  const pathPart = (a.path || '').replace(/\{walletId\}/g, encodeURIComponent(walletId));
  const url = new URL(a.baseUrl.replace(/\/$/, '') + (pathPart.startsWith('/') || !pathPart ? pathPart : '/' + pathPart));

  const params = {};
  if (a.walletIdParam) params[a.walletIdParam] = walletId;
  if (a.fromParam) params[a.fromParam] = formatForApi(fromDate, a.dateFormat, false, s.statement.timezone);
  if (a.toParam) params[a.toParam] = formatForApi(toDate, a.dateFormat, true, s.statement.timezone);
  if (a.pagination === 'page' && a.pageParam) params[a.pageParam] = cursor ?? a.pageStart;
  if (a.pagination === 'offset' && a.pageParam) params[a.pageParam] = cursor ?? 0;
  if (a.pagination === 'cursor' && cursor) params[a.cursorParam] = cursor;
  if (a.pagination !== 'none' && a.limitParam) params[a.limitParam] = a.pageSize;

  const headers = { Accept: 'application/json' };
  if (a.extraHeaders) Object.assign(headers, JSON.parse(a.extraHeaders));
  switch (a.authType) {
    case 'bearer': headers.Authorization = `${a.authPrefix ? a.authPrefix + ' ' : ''}${apiKey}`; break;
    case 'header': headers[a.authHeaderName || 'x-api-key'] = apiKey; break;
    case 'query': params[a.authQueryName || 'api_key'] = apiKey; break;
    case 'basic': headers.Authorization = `Basic ${Buffer.from(apiKey).toString('base64')}`; break;
    default: break;
  }

  const init = { method: a.method, headers };
  if (a.method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(params);
  }

  const shown = {
    method: a.method,
    url: mask2(url.toString(), apiKey),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, mask(v, apiKey)])),
    body: init.body ? mask(init.body, apiKey) : undefined,
  };
  return { url, init, shown };
}

/** Work out the next page/offset/cursor from a response. */
function nextCursorFrom(body, items, cursor, s) {
  const a = s.api;
  if (a.pagination === 'none') return null;
  if (a.pagination === 'cursor') {
    const next = getPath(body, s.response.nextCursorPath);
    return next && next !== cursor ? next : null;
  }
  if (a.pagination === 'offset') {
    const current = Number(cursor ?? 0);
    return items.length >= a.pageSize ? current + items.length : null;
  }
  const current = Number(cursor ?? a.pageStart);
  const total = Number(getPath(body, s.response.totalPagesPath));
  if (s.response.totalPagesPath && Number.isFinite(total)) {
    const last = a.pageStart === 0 ? total - 1 : total;
    return current < last ? current + 1 : null;
  }
  return items.length >= a.pageSize ? current + 1 : null;
}

/** Call the API once. Throws ApiError with request details on failure. */
async function requestPage(args, s = settingsStore.get(), apiKey = settingsStore.getApiKey()) {
  const { url, init, shown } = buildRequest(args, s, apiKey);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(s.api.timeoutMs) });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? `No response within ${s.api.timeoutMs / 1000}s` : `Could not reach the API: ${err.cause?.message || err.message}`;
    throw new ApiError(msg, { retryable: true, request: shown });
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  const durationMs = Date.now() - started;

  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const hint = res.status === 401 || res.status === 403 ? ' Check the API key and authentication settings.' : '';
    throw new ApiError(`API returned ${res.status} ${res.statusText}.${hint} ${mask(text.slice(0, 300), apiKey)}`.trim(), {
      status: res.status,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      retryable: res.status === 429 || res.status === 408 || res.status >= 500,
      request: shown,
      body: body ?? text.slice(0, 2000),
    });
  }
  if (body === null) {
    throw new ApiError(`The API response is not JSON: ${text.slice(0, 200)}`, { status: res.status, request: shown, body: text.slice(0, 2000) });
  }

  let items = getPath(body, s.response.listPath);
  if (!s.response.listPath && Array.isArray(body)) items = body;
  if (items === null || items === undefined) items = [];
  if (!Array.isArray(items)) {
    throw new ApiError(`Expected a list of transactions at "${s.response.listPath || '(top level)'}" in the response, but found ${typeof items}.`, { status: res.status, request: shown, body });
  }
  return { body, items, status: res.status, durationMs, request: shown, nextCursor: nextCursorFrom(body, items, args.cursor, s) };
}

/** Map ONE raw API transaction to the app's format. Throws with a clear message if it can't. */
function normalize(item, s = settingsStore.get()) {
  const f = s.fields;
  const v = s.values;

  const id = getPath(item, f.id);
  if (id === undefined || id === null || id === '') throw new Error(`No transaction ID at "${f.id}"`);

  const rawAmount = getPath(item, f.amount);
  const signedAmount = Number(String(rawAmount ?? '').replace(/[,\s]/g, '')) / (v.amountDivisor || 1);
  if (!Number.isFinite(signedAmount)) throw new Error(`Amount "${rawAmount}" at "${f.amount}" is not a number (${id})`);

  const dateRaw = getPath(item, f.date);
  const date = parseApiDate(dateRaw, s);
  if (!date) throw new Error(`Can't read date "${dateRaw}" at "${f.date}" (${id})`);

  const type = String(getPath(item, f.type) ?? '').trim().toUpperCase();
  const status = String(getPath(item, f.status) ?? '').trim().toUpperCase();

  let category;
  if (status && valueList(v.failedStatus).includes(status)) category = 'failed';
  else if (type && valueList(v.failedStatus).includes(type)) category = 'failed';
  else if (type && valueList(v.reverse).includes(type)) category = 'reverse';
  else if (type && valueList(v.credit).includes(type)) category = 'credit';
  else if (type && valueList(v.debit).includes(type)) category = 'debit';
  else if (v.signFallback && signedAmount !== 0) category = signedAmount < 0 ? 'debit' : 'credit';
  else throw new Error(`Unknown type "${type || '(empty)'}" with status "${status || '(empty)'}" (${id}). Add it under Transaction types in Settings.`);

  const original = f.originalId ? getPath(item, f.originalId) : null;
  const balRaw = f.balanceAfter ? getPath(item, f.balanceAfter) : null;
  const bal = balRaw === null || balRaw === undefined || balRaw === '' ? null : Number(String(balRaw).replace(/[,\s]/g, '')) / (v.amountDivisor || 1);

  return {
    ref: String(id),
    occurredAt: date.toISOString(),
    category,
    amount: Math.abs(signedAmount),
    description: f.description ? String(getPath(item, f.description) ?? '') : '',
    reverseOf: original === null || original === undefined || original === '' ? null : String(original),
    apiBalance: Number.isFinite(bal) ? bal : null,
    raw: item,
  };
}

/** Fetch and normalize one page (used by the downloader). */
async function fetchPage(args) {
  const s = settingsStore.get();
  const page = await requestPage(args, s);
  return { transactions: page.items.map((it) => normalize(it, s)), nextCursor: page.nextCursor };
}

module.exports = { fetchPage, requestPage, normalize, getPath, ApiError };
