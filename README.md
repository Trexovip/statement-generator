# Wallet statements

A Node.js web app that rebuilds the full statement (day 1 to today) for hundreds of wallet accounts from your wallet API. Everything is managed from the browser: sign-in, API connection and key, field mapping, wallets, downloads, statements and exports.

## Start

Requires Node.js 18.17 or newer.

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open http://localhost:3000 and create your admin account. The app comes connected to a built-in test API with sample data, so you can try everything straight away.

## Connect your real API (Settings page)

1. **API connection:** enter the base URL and endpoint path (put `{walletId}` where the wallet ID goes), choose the authentication type and paste your API key. The key is encrypted on the server and only its last 4 characters are ever shown again.
2. **Request parameters and Paging:** the parameter names your API uses for dates and pages, and the date format it expects.
3. **Test connection:** enter a wallet ID and choose "Test connection". This uses the settings on screen without saving them. It shows the request sent (key hidden), the raw response, every field name in a transaction, the type and status values your API uses, and how each transaction was read.
4. **Response fields:** click a box (e.g. "Amount"), then click the matching field name in the test results to fill it in.
5. **Transaction types:** add your API's type and status values (shown by the test) to Credit, Debit, Reversal and Failed.
6. **Statements:** day 1, timezone, currency label.
7. Test again until it says every transaction was read correctly, then choose "Save settings".

Then set `ENABLE_MOCK_API=false` in `.env` and restart, clear the test data under Settings › Data, and import your wallets.

## Managing wallets

- **Add wallets:** paste or upload a CSV with one wallet per line: `wallet_id, opening_balance, name` (the last two are optional).
- **Download:** "Update all wallets", "Only new wallets" or "Retry failed wallets". A live progress bar shows wallets done, transactions downloaded, retries and failures.
- **Bulk actions:** tick wallets in the list to update, re-download from day 1, or delete them.
- **Statement page:** edit the name and opening balance, filter by dates and type, show only rows with issues, click a reference to see exactly what the API returned, and export PDF, Excel or CSV.
- **Exports for everyone:** "Summary (Excel)" and "Download all statements (ZIP)".

## Balance rules

| Type     | Effect on balance |
|----------|-------------------|
| Credit   | + amount |
| Debit    | − amount |
| Failed   | none; listed with a "not applied" note |
| Reversal | undoes the original: reversal of a debit adds back, of a credit takes back |

Flagged for checking: calculated balance differs from the API's balance, reversal without a matching original, total reversed larger than the original, reversal dated before its original, reversal of a failed transaction.

## Security

- Every page and API route requires sign-in. Five wrong passwords lock that address out for 15 minutes.
- Passwords are hashed (scrypt). The API key is encrypted (AES-256-GCM) with `APP_SECRET`, or with a random secret saved in `data/secret.key` if `APP_SECRET` is empty. Keep that file (or the env value) with your database; without it the key must be entered again.
- If the app is reachable from other machines, run it behind HTTPS and set `SECURE_COOKIES=true`.
- Forgot the password? Run `npm run reset-login`, then open the app to create a new account. Data, settings and key are kept.

## Data and backups

Everything is stored in `data/statements.db` (SQLite). Back up the `data/` folder.

## Project structure

```
src/
  server.js       web server and routes
  auth.js         sign-in, sessions, password change
  settings.js     settings storage, API key encryption
  apiAdapter.js   builds API requests and reads responses from the settings
  sync.js         downloading: concurrency, date windows, paging, retries, resume
  statement.js    running balance, reversal matching, checks
  exporters.js    PDF, Excel, CSV, summary
  dates.js        timezones and date formats
  mockApi.js      test API with sample data
  resetLogin.js   npm run reset-login
public/
  index.html, styles.css
  js/             core, auth, wallets, statement, settings, main
```

If your API needs something the Settings page can't express (signed requests, token refresh), customise `buildRequest()` in `src/apiAdapter.js`.
