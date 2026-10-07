const settings = require('./settings');

const fmtCache = new Map();
function dayFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return fmtCache.get(tz);
}
const partsCache = new Map();
function partsFormatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsCache.get(tz);
}

const tz = () => settings.get().statement.timezone;

/** Calendar date (YYYY-MM-DD) of an instant, in the statement timezone. */
function localDate(isoOrDate, zone = tz()) {
  return dayFormatter(zone).format(new Date(isoOrDate));
}

function today() {
  return localDate(new Date());
}

function addDays(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const minDate = (a, b) => (a < b ? a : b);

/** Offset (ms) of a timezone at a given instant. */
function tzOffset(ts, zone) {
  const p = Object.fromEntries(partsFormatter(zone).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock time in a timezone -> UTC timestamp (ms). */
function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, zone = tz()) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ts = guess - tzOffset(guess, zone);
  ts = guess - tzOffset(ts, zone); // second pass handles DST edges
  return ts;
}

/** Format a YYYY-MM-DD day for the API request. `end` = last moment of the day. */
function formatForApi(ymd, format, end = false, zone = tz()) {
  const [y, m, d] = ymd.split('-');
  switch (format) {
    case 'DD-MM-YYYY': return `${d}-${m}-${y}`;
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
    case 'YYYYMMDD': return `${y}${m}${d}`;
    case 'ISO': return `${ymd}T${end ? '23:59:59' : '00:00:00'}`;
    case 'unix':
    case 'unixms': {
      const ts = end ? zonedToUtc(+y, +m, +d + 1, 0, 0, 0, zone) - 1000 : zonedToUtc(+y, +m, +d, 0, 0, 0, zone);
      return String(format === 'unix' ? Math.floor(ts / 1000) : ts);
    }
    default: return ymd;
  }
}

/**
 * Read a date value from the API: ISO strings (with or without timezone), unix seconds/ms,
 * "YYYY-MM-DD HH:mm:ss", "DD/MM/YYYY HH:mm" or "DD-MM-YYYY".
 * Returns a Date, or null if it can't be read.
 */
function parseApiDate(value, cfg = settings.get()) {
  if (value === null || value === undefined || value === '') return null;
  const f = cfg.fields;
  const zone = f.apiDatesTimezone === 'local' ? cfg.statement.timezone : 'UTC';

  if (typeof value === 'number' || /^\d{9,13}$/.test(String(value).trim())) {
    const n = Number(value);
    return new Date(n > 1e11 ? n : n * 1000);
  }
  const s = String(value).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && !isNaN(new Date(s))) return new Date(s);

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
  if (m) return new Date(zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), zone));

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (m) {
    const [day, month] = f.dateDayFirst ? [+m[1], +m[2]] : [+m[2], +m[1]];
    let h = +(m[4] || 0);
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(zonedToUtc(+m[3], month, day, h, +(m[5] || 0), +(m[6] || 0), zone));
  }

  const d = new Date(s);
  return isNaN(d) ? null : d;
}

module.exports = { localDate, today, addDays, minDate, formatForApi, parseApiDate };
