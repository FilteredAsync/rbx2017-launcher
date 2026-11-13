'use strict';

// Signing in to the host's web server, the avatar editor's requests, and the
// launcher-net:// protocol that hands the window pictures, meshes and item
// data from that server (and a few of the client's own files).
//
// Sessions are kept per server in config/session.json:
//   { "<server address>": { "token": "...", "name": "...", "userId": 123, "admin": false } }
// They are the same accounts Studio uses; the token is sent as
// "Authorization: Bearer <token>" (Webserver/node/lib/launcherapi.js).
//
//   launcher-net://server/<path>?...   GET <server>/<path>?... (only the paths below)
//   launcher-net://client/<path>       Client/content/<path> (meshes, textures, fonts)

const fs = require('fs');
const path = require('path');

const SERVER_PATHS = /^(?:asset\/?|asset-thumbnail\/image|bundle-thumbnail\/image|avatar-thumbnail\/image|headshot-thumbnail\/image|api\/launcher\/item\/\d{1,19}|api\/thumbnails\/\d{1,15})$/i;
const CLIENT_TYPES = { '.mesh': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const CACHE_LIMIT = 160 * 1024 * 1024;
// Pictures of avatars change when players save; everything else is fixed by ID.
const UNCACHED = /^(?:avatar-thumbnail|headshot-thumbnail|api\/thumbnails)/i;

module.exports = function accountModule({ ROOT, lib }) {
  const FILE = path.join(ROOT, 'config', 'session.json');

  function serverUrl(centralUrl) {
    const saved = (lib('joining').loadConfig() || {}).centralUrl || '';
    const url = lib('proxy').normalizeCentralUrl(centralUrl || saved);
    if (url === null) throw new Error('Set your server address first (Settings → Network).');
    return url;
  }

  function loadSessions() {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
      return {};
    }
  }

  function saveSessions(sessions) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(sessions, null, 2)}\n`);
  }

  function session(url) {
    const entry = loadSessions()[url];
    return entry && /^[0-9a-f]{64}$/.test(String(entry.token || '')) ? entry : null;
  }

  async function request(url, method, route, { body = null, token = null, bytes = null, timeoutMs = 20000 } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (bytes) {
      headers['Content-Type'] = 'image/png';
      payload = bytes;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`${url}/api/launcher/${route}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? 'it did not answer in time' : (error.cause && error.cause.code) || error.message;
      const failure = new Error(`Could not reach your server (${reason}).`);
      failure.offline = true;
      throw failure;
    }
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    if (!response.ok) {
      const failure = new Error(data.error || (response.status === 404
        ? 'Your server is too old for launcher accounts. The host needs to update its server files.'
        : `Your server answered HTTP ${response.status}.`));
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function withSession(centralUrl) {
    const url = serverUrl(centralUrl);
    const entry = session(url);
    if (!entry) throw new Error('Sign in first.');
    return { url, token: entry.token };
  }

  async function signIn({ centralUrl, name, password, mode }) {
    const url = serverUrl(centralUrl);
    const data = await request(url, 'POST', 'login', { body: { name, password, mode: mode === 'signup' ? 'signup' : 'signin' } });
    const sessions = loadSessions();
    sessions[url] = { token: data.token, name: data.account.name, userId: data.account.userId, admin: Boolean(data.account.admin) };
    saveSessions(sessions);
    return { account: data.account, created: Boolean(data.created) };
  }

  async function signOut(centralUrl) {
    const url = serverUrl(centralUrl);
    const entry = session(url);
    const sessions = loadSessions();
    delete sessions[url];
    saveSessions(sessions);
    if (entry) await request(url, 'POST', 'logout', { token: entry.token, timeoutMs: 5000 }).catch(() => {});
    return true;
  }

  // The signed-in account for this server: checked with the server when it
  // answers; kept as it was when the server cannot be reached.
  async function current(centralUrl) {
    let url;
    try { url = serverUrl(centralUrl); } catch (error) { return null; }
    const entry = session(url);
    if (!entry) return null;
    try {
      const data = await request(url, 'GET', 'me', { token: entry.token, timeoutMs: 8000 });
      return { account: data.account, server: url, offline: false };
    } catch (error) {
      if (error.status === 401) {
        const sessions = loadSessions();
        delete sessions[url];
        saveSessions(sessions);
        return null;
      }
      return { account: { name: entry.name, userId: entry.userId, admin: entry.admin }, server: url, offline: true };
    }
  }

  async function authed(centralUrl, method, route, options = {}) {
    const { url, token } = withSession(centralUrl);
    return request(url, method, route, Object.assign({ token }, options));
  }

  async function open(centralUrl, method, route, options = {}) {
    return request(serverUrl(centralUrl), method, route, options);
  }

  // Join ticket for the client: the account's, or a guest's.
  async function joinTicket(centralUrl, gameId, guest) {
    const url = serverUrl(centralUrl);
    const entry = guest ? null : session(url);
    if (!guest && !entry) throw new Error('Sign in first, or play as a guest.');
    return lib('joining').joinTicket(url, gameId, entry ? entry.token : null);
  }

  // --- launcher-net:// -------------------------------------------------------------------

  const cache = new Map();
  let cacheBytes = 0;

  function remember(key, entry) {
    cache.set(key, entry);
    cacheBytes += entry.bytes.length;
    while (cacheBytes > CACHE_LIMIT && cache.size > 1) {
      const [oldKey, old] = cache.entries().next().value;
      cache.delete(oldKey);
      cacheBytes -= old.bytes.length;
    }
  }

  function reply(entry) {
    return new Response(entry.bytes, {
      status: entry.status,
      headers: { 'Content-Type': entry.type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  }

  function notFound(text) {
    return new Response(text || 'not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
  }

  async function handleNet(request) {
    if (request.method !== 'GET') return notFound('GET only');
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (url.hostname === 'client') {
      const base = path.join(ROOT, 'Client', 'content');
      const file = path.resolve(base, relative);
      const type = CLIENT_TYPES[path.extname(file).toLowerCase()];
      if (!type || !file.startsWith(base + path.sep)) return notFound();
      try {
        return reply({ status: 200, type, bytes: fs.readFileSync(file) });
      } catch (error) {
        return notFound();
      }
    }
    if (url.hostname !== 'server' || !SERVER_PATHS.test(relative)) return notFound();
    let base;
    try { base = serverUrl(); } catch (error) { return notFound('no server set'); }
    const target = `${base}/${relative}${url.search}`;
    const cacheable = !UNCACHED.test(relative);
    if (cacheable && cache.has(target)) {
      const entry = cache.get(target);
      cache.delete(target); // most recently used last
      cache.set(target, entry);
      return reply(entry);
    }
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(30000) });
      const entry = {
        status: response.status,
        type: response.headers.get('content-type') || 'application/octet-stream',
        bytes: Buffer.from(await response.arrayBuffer()),
      };
      if (cacheable && response.ok) remember(target, entry);
      return reply(entry);
    } catch (error) {
      return new Response('server unreachable', { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
  }

  return {
    serverUrl,
    signIn,
    signOut,
    current,
    joinTicket,
    handleNet,
    avatar: (centralUrl) => authed(centralUrl, 'GET', 'avatar'),
    saveAvatar: (centralUrl, body) => authed(centralUrl, 'POST', 'avatar', { body }),
    copyAvatar: (centralUrl) => authed(centralUrl, 'POST', 'avatar/copy', { timeoutMs: 40000 }),
    uploadAvatarImage: (centralUrl, bytes, guest) => (guest
      ? open(centralUrl, 'POST', 'avatar/image?guest=1', { bytes })
      : authed(centralUrl, 'POST', 'avatar/image', { bytes })),
    guestAvatar: (centralUrl) => open(centralUrl, 'GET', 'guest-avatar'),
    catalog: (centralUrl, { category, keyword, cursor }) => {
      const query = new URLSearchParams({ category: String(category || 'hats') });
      if (keyword) query.set('keyword', String(keyword).slice(0, 50));
      if (cursor) query.set('cursor', String(cursor));
      return open(centralUrl, 'GET', `catalog?${query}`, { timeoutMs: 60000 });
    },
    bundle: (centralUrl, id) => open(centralUrl, 'GET', `bundle/${encodeURIComponent(String(id))}`, { timeoutMs: 60000 }),
    item: (centralUrl, id) => open(centralUrl, 'GET', `item/${encodeURIComponent(String(id))}`, { timeoutMs: 60000 }),
    players: (centralUrl) => open(centralUrl, 'GET', 'players', { timeoutMs: 8000 }),
  };
};
