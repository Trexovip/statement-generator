/**
 * Login for the web app. The first visit asks to create the admin account.
 * Passwords are hashed with scrypt; sessions are random tokens in an httpOnly cookie.
 */
const crypto = require('crypto');
const express = require('express');
const env = require('./config');
const { db } = require('./db');

const COOKIE = 'ws_session';
const SESSION_DAYS = 7;
const router = express.Router();

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return row.username;
}

function setSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.prepare('INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)').run(token, username, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${env.secureCookies ? '; Secure' : ''}`);
}

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw new Error('Password must be at least 8 characters');
}

// --- simple brute-force protection: 5 failed logins per IP -> 15 minute wait
const failures = new Map();
function tooManyAttempts(ip) {
  const f = failures.get(ip);
  return f && f.count >= 5 && Date.now() - f.first < 15 * 60000;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

router.get('/status', (req, res) => {
  res.json({ setupRequired: userCount() === 0, username: sessionUser(req) });
});

router.post('/setup', (req, res) => {
  try {
    if (userCount() > 0) return res.status(403).json({ error: 'An admin account already exists. Please log in.' });
    const username = String(req.body.username || '').trim();
    if (!username) throw new Error('Enter a username');
    checkPassword(req.body.password);
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run(username, hash(req.body.password, salt), salt);
    setSession(res, username);
    res.json({ username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const username = String(req.body.username || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = user && crypto.timingSafeEqual(Buffer.from(hash(String(req.body.password || ''), user.salt), 'hex'), Buffer.from(user.password_hash, 'hex'));
  if (!ok) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  failures.delete(ip);
  setSession(res, username);
  res.json({ username });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

router.post('/password', (req, res) => {
  try {
    const username = sessionUser(req);
    if (!username) return res.status(401).json({ error: 'Please log in' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (hash(String(req.body.current || ''), user.salt) !== user.password_hash) throw new Error('Current password is wrong');
    checkPassword(req.body.next);
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?').run(hash(req.body.next, salt), salt, username);
    // sign out other sessions
    const token = parseCookies(req.headers.cookie)[COOKIE];
    db.prepare('DELETE FROM sessions WHERE username = ? AND token != ?').run(username, token);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Protects every /api route except /api/auth/*. */
function requireLogin(req, res, next) {
  const username = sessionUser(req);
  if (!username) return res.status(401).json({ error: 'Please log in', loginRequired: true });
  req.username = username;
  next();
}

module.exports = { router, requireLogin };
