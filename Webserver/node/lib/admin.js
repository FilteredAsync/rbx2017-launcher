'use strict';

// Who may manage this server (/manage and the API calls it makes): whoever
// sends the host key (config/host-key.txt, header X-Host-Key), or a manage
// token (header X-Manage-Token). The launcher gets a token for an admin
// account (accounts.js "admin", set on /manage) or, on the server PC, with
// the host key, and opens /manage with it, so admins need not know the key.
// Tokens are kept in memory for 12 hours; restarting the web server ends
// them (Manage games in the launcher makes a new one).
//
//   POST /api/manage/token    with X-Host-Key or an admin's launcher session
//                             (Authorization: Bearer ...) -> { token, expiresAt }
//   GET  /api/manage/whoami   -> { via: 'key' | 'account', name } or 403

const crypto = require('crypto');
const accounts = require('./accounts');
const games = require('./games');

const TOKEN_MS = 12 * 60 * 60 * 1000;
const tokens = new Map(); // token -> { userId (null: host key), expires }

function header(ctx, name) {
  const value = ctx.req.headers[name];
  return value !== undefined ? String(value) : '';
}

function issue(account) {
  for (const [token, entry] of tokens) if (entry.expires < Date.now()) tokens.delete(token);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + TOKEN_MS;
  tokens.set(token, { userId: account ? Number(account.userId) : null, expires });
  return { token, expiresAt: new Date(expires).toISOString() };
}

// -> { via: 'key' } | { via: 'account', name, userId } | null
function who(ctx) {
  if (games.checkHostKey(header(ctx, 'x-host-key'))) return { via: 'key', name: null };
  const token = header(ctx, 'x-manage-token');
  const entry = /^[0-9a-f]{64}$/.test(token) ? tokens.get(token) : null;
  if (!entry || entry.expires < Date.now()) return null;
  if (entry.userId === null) return { via: 'key', name: null };
  // Someone who is no longer an admin loses the token at once.
  const account = accounts.byUserId(entry.userId);
  if (!account || !account.admin) {
    tokens.delete(token);
    return null;
  }
  return { via: 'account', name: account.name, userId: account.userId };
}

function allowed(ctx) {
  return who(ctx) !== null;
}

const DENIED = { error: 'This needs the host key, or an admin account (open Manage games from the launcher).' };

// /api/manage/(token|whoami)
function route(ctx, match, sendJson) {
  const action = match[1].toLowerCase();
  if (action === 'whoami') {
    if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
    const found = who(ctx);
    return found ? sendJson(ctx, 200, { via: found.via, name: found.name }) : sendJson(ctx, 403, DENIED);
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  if (games.checkHostKey(header(ctx, 'x-host-key'))) return sendJson(ctx, 200, issue(null));
  const account = accounts.fromRequest(ctx.req);
  if (!account) return sendJson(ctx, 401, { error: 'Sign in first.' });
  if (!account.admin) return sendJson(ctx, 403, { error: `${account.name} is not an admin on this server. An admin can make you one on the Manage games page.` });
  return sendJson(ctx, 200, issue(account));
}

module.exports = { issue, who, allowed, route, DENIED };
