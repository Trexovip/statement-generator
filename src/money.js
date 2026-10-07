const settings = require('./settings');

const decimals = () => settings.get().statement.decimals;
const factor = () => 10 ** decimals();

/** Major units (e.g. 12.50) -> integer minor units (1250). Avoids floating-point drift. */
const toMinor = (n) => Math.round(Number(n) * factor());
const toMajor = (m) => (m === null || m === undefined ? null : m / factor());
const format = (m) =>
  m === null || m === undefined
    ? ''
    : (m / factor()).toLocaleString('en-US', { minimumFractionDigits: decimals(), maximumFractionDigits: decimals() });

module.exports = { toMinor, toMajor, format, decimals };
