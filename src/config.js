/**
 * Server-level settings from .env. Everything else (API URL, key, field mapping,
 * statement options) is managed from the Settings page in the web app.
 */
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  // Used to encrypt the API key stored in the database. If empty, a random
  // secret is generated once and saved in data/secret.key.
  appSecret: process.env.APP_SECRET || '',
  // Set to true to serve a fake wallet API at /mock for trying the app.
  enableMockApi: String(process.env.ENABLE_MOCK_API || 'false').toLowerCase() === 'true',
  // Set to true when the app is served over HTTPS (marks the login cookie Secure).
  secureCookies: String(process.env.SECURE_COOKIES || 'false').toLowerCase() === 'true',
};
