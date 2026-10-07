/**
 * Forgot the password? Run:  npm run reset-login
 * Removes the admin account so the app asks you to create a new one.
 * Your wallets, transactions, settings and API key are kept.
 */
const { db } = require('./db');
db.prepare('DELETE FROM sessions').run();
const n = db.prepare('DELETE FROM users').run().changes;
console.log(n ? 'Login removed. Open the app to create a new admin account.' : 'No login was set up.');
