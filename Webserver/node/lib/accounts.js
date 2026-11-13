'use strict';

// Studio accounts: a username and password per person, kept on this server.
// The first login with a name creates the account ("claims" the name); after
// that the password is needed. User IDs are the same ones the game uses for
// that name (core.localUserId), so avatars and saves line up.
//
// data/accounts.json holds the accounts (passwords as scrypt hashes) and the
// login sessions (as SHA-256 hashes of their tokens, so the file never holds
// a usable session). Studio carries the session in a .ROBLOSECURITY cookie,
// the name the 2017 engine expects.
//
// Edit tokens are separate and need no storage: an HMAC over (user, place,
// expiry) with a secret in data/studio-secret.txt. The edit script puts one in
// the place's download and upload addresses, so saving keeps working when
// Studio's own cookies are not set and after the web server restarts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'accounts.json');
const SECRET_FILE = path.join(DATA, 'studio-secret.txt');
const SESSION_DAYS = 30;
const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 200;

// --- storage -------------------------------------------------------------------------

function empty() {
  return { accounts: {}, sessions: {} };
}

function load() {
  const data = core.readJsonFile(FILE);
  if (!data || typeof data !== 'object') return empty();
  if (!data.accounts || typeof data.accounts !== 'object') data.accounts = {};
  if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {};
  return data;
}

function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save accounts');
}

let secretCache = null;
function secret() {
  if (secretCache) return secretCache;
  try {
    const text = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(text)) secretCache = Buffer.from(text, 'hex');
  } catch (error) { /* made below */ }
  if (!secretCache) {
    secretCache = crypto.randomBytes(32);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SECRET_FILE, `${secretCache.toString('hex')}\n`);
  }
  return secretCache;
}

function now() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64).toString('hex');
}

function publicAccount(account) {
  return account ? { name: account.name, userId: Number(account.userId), admin: Boolean(account.admin) } : null;
}

// --- login rate limit (per address) --------------------------------------------------

const failures = new Map();
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;

function tooManyFailures(address) {
  const entry = failures.get(address);
  if (!entry) return false;
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failures.delete(address);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function noteFailure(address) {
  const entry = failures.get(address);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) failures.set(address, { first: Date.now(), count: 1 });
  else entry.count++;
}

// --- accounts and sessions -------------------------------------------------------------

function newSession(data, account) {
  const token = crypto.randomBytes(32).toString('hex');
  data.sessions[hashToken(token)] = { name: account.name.toLowerCase(), createdAt: now(), lastSeenAt: now() };
  return token;
}

function pruneSessions(data) {
  const cutoff = Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, session] of Object.entries(data.sessions)) {
    if (!data.accounts[session.name] || Date.parse(session.lastSeenAt) < cutoff) delete data.sessions[key];
  }
}

function isLoopback(address) {
  return /^(?:127\.|::1$|::ffff:127\.)/.test(String(address || ''));
}

// -> { account, token, created } or { error, status }
// The first account made on the server PC itself (a loopback address) is an
// admin: admins may edit every game. /manage changes who is one.
// mode: 'claim' (Studio's page: the first login with a name creates it),
// 'signin' (the account must exist) or 'signup' (the name must be free).
function login(name, password, address, mode = 'claim') {
  name = String(name || '').trim();
  password = String(password || '');
  if (tooManyFailures(address)) return { status: 429, error: 'Too many wrong passwords. Wait a few minutes and try again.' };
  if (!NAME_RE.test(name)) return { status: 400, error: 'Usernames are 3 to 20 letters, digits or underscores.' };
  if (password.length === 0) return { status: 400, error: 'Type your password.' };
  if (password.length > MAX_PASSWORD) return { status: 400, error: 'That password is too long.' };
  const data = load();
  const key = name.toLowerCase();
  let account = data.accounts[key];
  let created = false;
  if (account && mode === 'signup') return { status: 409, error: 'That name is taken. Pick another, or sign in if it is yours.' };
  if (!account && mode === 'signin') return { status: 404, error: 'No account has that name. Check the spelling, or create one.' };
  if (!account) {
    if (password.length < MIN_PASSWORD) {
      return { status: 400, error: `New account: pick a password of at least ${MIN_PASSWORD} characters.` };
    }
    const userId = core.localUserId(name);
    if (Object.values(data.accounts).some((other) => String(other.userId) === userId)) {
      return { status: 409, error: 'That name clashes with an existing account. Pick another name.' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    account = {
      name, userId: Number(userId), salt, hash: hashPassword(password, salt),
      admin: isLoopback(address) && !Object.values(data.accounts).some((other) => other.admin),
      createdAt: now(), lastLoginAt: now(),
    };
    data.accounts[key] = account;
    created = true;
  } else {
    const expected = Buffer.from(account.hash, 'hex');
    const actual = Buffer.from(hashPassword(password, account.salt), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      noteFailure(address);
      return { status: 403, error: 'Wrong password for that account.' };
    }
    account.lastLoginAt = now();
  }
  pruneSessions(data);
  const token = newSession(data, account);
  save(data);
  return { account: publicAccount(account), token, created };
}

// The account behind a session token, or null. Marks the session as used
// (at most once an hour, to keep writes down).
function fromToken(token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const data = load();
  const session = data.sessions[hashToken(token)];
  if (!session) return null;
  const account = data.accounts[session.name];
  if (!account) return null;
  const last = Date.parse(session.lastSeenAt);
  if (Date.now() - last > SESSION_DAYS * 24 * 60 * 60 * 1000) return null;
  if (Date.now() - last > 60 * 60 * 1000) {
    session.lastSeenAt = now();
    try { save(data); } catch (error) { /* read-only */ }
  }
  return publicAccount(account);
}

// A launcher sends its session as "Authorization: Bearer <token>".
function bearerToken(header) {
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(String(header || '').trim());
  return match ? match[1].toLowerCase() : null;
}

function cookieToken(cookieHeader) {
  const match = /(?:^|;\s*)\.ROBLOSECURITY=([0-9a-f]{64})(?:;|$)/i.exec(String(cookieHeader || ''));
  return match ? match[1].toLowerCase() : null;
}

function fromRequest(req) {
  return fromToken(bearerToken(req.headers.authorization) || cookieToken(req.headers.cookie));
}

function logout(token) {
  if (!token) return;
  const data = load();
  if (data.sessions[hashToken(token)]) {
    delete data.sessions[hashToken(token)];
    save(data);
  }
}

function byUserId(userId) {
  const data = load();
  return publicAccount(Object.values(data.accounts).find((account) => String(account.userId) === String(userId)) || null);
}

function byName(name) {
  const data = load();
  return publicAccount(data.accounts[String(name || '').toLowerCase()] || null);
}

// For /manage.
function list() {
  const data = load();
  return Object.values(data.accounts)
    .map((account) => ({
      name: account.name, userId: Number(account.userId), admin: Boolean(account.admin),
      createdAt: account.createdAt, lastLoginAt: account.lastLoginAt || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- profiles (the launcher's People tab) --------------------------------------------------

const MAX_BIO = 200;

function cleanBio(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .split('\n').slice(0, 4).join('\n')
    .trim()
    .slice(0, MAX_BIO);
}

// What anyone may see of an account -> { name, userId, admin, bio, joinedAt } or null.
function profile(userId) {
  const data = load();
  const account = Object.values(data.accounts).find((entry) => String(entry.userId) === String(userId));
  if (!account) return null;
  return Object.assign(publicAccount(account), { bio: account.bio || '', joinedAt: account.createdAt || null });
}

function setBio(userId, text) {
  const data = load();
  const account = Object.values(data.accounts).find((entry) => String(entry.userId) === String(userId));
  if (!account) return null;
  account.bio = cleanBio(text);
  save(data);
  return profile(userId);
}

// Accounts whose name contains the text (names starting with it first) -> [publicAccount].
function search(text, limit = 40) {
  const needle = String(text || '').trim().toLowerCase();
  const data = load();
  return Object.values(data.accounts)
    .filter((account) => !needle || account.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const pa = needle && a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const pb = needle && b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map(publicAccount);
}

function setAdmin(name, admin) {
  const data = load();
  const account = data.accounts[String(name || '').toLowerCase()];
  if (!account) return null;
  account.admin = Boolean(admin);
  save(data);
  return publicAccount(account);
}

// Deletes the account and logs it out everywhere; its name can be claimed again
// (that is how a forgotten password is reset).
function remove(name) {
  const data = load();
  const key = String(name || '').toLowerCase();
  if (!data.accounts[key]) return false;
  // Its friendships go with it (required here: friends.js needs no accounts).
  try { require('./friends').forget(data.accounts[key].userId); } catch (error) { /* no friends file */ }
  delete data.accounts[key];
  for (const [hash, session] of Object.entries(data.sessions)) {
    if (session.name === key) delete data.sessions[hash];
  }
  save(data);
  return true;
}

// --- edit tokens ---------------------------------------------------------------------------

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function editToken(userId, placeId, days = 7) {
  const expires = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const payload = `${Number(userId)}.${Number(placeId)}.${expires}`;
  const mac = base64url(crypto.createHmac('sha256', secret()).update(payload).digest()).slice(0, 32);
  return `${payload}.${mac}`;
}

// Short HMAC over any text with the server secret (join tickets).
function mac(text) {
  return base64url(crypto.createHmac('sha256', secret()).update(String(text)).digest()).slice(0, 32);
}

function checkMac(text, value) {
  const expected = Buffer.from(mac(text));
  const actual = Buffer.from(String(value || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// -> { userId, placeId } or null
function checkEditToken(token) {
  const match = /^(\d{1,12})\.(\d{1,15})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!match) return null;
  const payload = `${match[1]}.${match[2]}.${match[3]}`;
  const expected = base64url(crypto.createHmac('sha256', secret()).update(payload).digest()).slice(0, 32);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[4]))) return null;
  if (Number(match[3]) < Date.now() / 1000) return null;
  return { userId: Number(match[1]), placeId: Number(match[2]) };
}

module.exports = {
  login, logout, fromToken, fromRequest, cookieToken, bearerToken, byUserId, byName, list, setAdmin, remove,
  profile, setBio, search, MAX_BIO,
  editToken, checkEditToken, mac, checkMac, NAME_RE, MIN_PASSWORD,
};
