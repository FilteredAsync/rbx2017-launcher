'use strict';

// Game assets kept on the player's PC. The launcher's local proxy
// (lib/proxy.js) answers the game client's and Studio's /asset requests from
// here when it can, so meshes, textures and sounds come from this PC's disk
// after the first visit instead of from the server PC over Tailscale.
//
// Only what the web server marks as cacheable is kept: a 200 answer with an
// ETag and "Cache-Control: public, max-age=N": its own cache of Roblox
// assets (a day) and replacement assets from /manage (5 minutes); place
// files and body parts say no-store.
// For N seconds a kept asset is used without asking the server; after that
// the proxy asks with If-None-Match, and a 304 confirms it without sending it
// again. When the server cannot be reached or fails, a kept copy is used.
//
//   RobloxClient/cache/server-assets/<server>/<sha1 of the address>.bin (+ .json)
//
//   const cache = createAssetCache(dir, { maxBytes, log })
//   cache.handles(req)                       true for requests it answers
//   cache.serve(req, res, fetchUpstream)     fetchUpstream(extraHeaders) ->
//                                            Promise<{ status, headers, body }>
//   usage(dir) -> { bytes, files }, clear(dir)   for the launcher's Settings

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const TOUCH_MS = 6 * 3600 * 1000; // how stale a saved "last used" time may get

// /asset/?id=..., /asset?id=..., any case.
function handles(req) {
  return req.method === 'GET' && /^\/asset\/?\?/i.test(req.url || '');
}

// The same asset however the address is written: path in lower case,
// parameter names in lower case, sorted.
function keyOf(url) {
  const at = url.indexOf('?');
  const route = (at < 0 ? url : url.slice(0, at)).toLowerCase().replace(/\/+$/, '');
  const pairs = [...new URLSearchParams(at < 0 ? '' : url.slice(at + 1))].map(([name, value]) => [name.toLowerCase(), value]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return `${route}?${pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`;
}

// -> { etag, maxAge } when the answer may be kept, else null.
function rulesOf(status, headers) {
  if (status !== 200) return null;
  const control = String(headers['cache-control'] || '').toLowerCase();
  const etag = typeof headers.etag === 'string' ? headers.etag : null;
  if (!etag || !/\bpublic\b/.test(control) || /no-store|no-cache|private/.test(control)) return null;
  const encoding = String(headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') return null;
  const maxAge = Number((/max-age=(\d+)/.exec(control) || [])[1]);
  return maxAge > 0 ? { etag, maxAge } : null;
}

function maxAgeOf(headers, fallback) {
  const maxAge = Number((/max-age=(\d+)/.exec(String(headers['cache-control'] || '').toLowerCase()) || [])[1]);
  return maxAge > 0 ? maxAge : fallback;
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch (error) { /* gone or in use */ }
}

function writeAtomic(file, data) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
    return true;
  } catch (error) {
    removeQuietly(temporary);
    return false;
  }
}

function createAssetCache(dir, { maxBytes = DEFAULT_MAX_BYTES, log = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = new Map(); // key -> { key, name, etag, maxAge, contentType, size, storedAt, validatedAt, usedAt }
  const inflight = new Map(); // key -> Promise
  let total = 0;
  const binOf = (entry) => path.join(dir, `${entry.name}.bin`);
  const metaOf = (entry) => path.join(dir, `${entry.name}.json`);

  // What an earlier run kept; anything half-written is removed.
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    if (file.endsWith('.tmp')) { removeQuietly(full); continue; }
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    try {
      const entry = JSON.parse(fs.readFileSync(full, 'utf8'));
      const size = fs.statSync(path.join(dir, `${name}.bin`)).size;
      if (!entry || typeof entry.key !== 'string' || entry.name !== name || entry.size !== size) throw new Error('mismatch');
      entries.set(entry.key, entry);
      total += size;
    } catch (error) {
      removeQuietly(full);
      removeQuietly(path.join(dir, `${name}.bin`));
    }
  }
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.bin') && !fs.existsSync(path.join(dir, `${file.slice(0, -'.bin'.length)}.json`))) removeQuietly(path.join(dir, file));
  }

  function saveMeta(entry) {
    writeAtomic(metaOf(entry), JSON.stringify(entry));
  }

  function drop(entry) {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    total -= entry.size;
    removeQuietly(metaOf(entry));
    removeQuietly(binOf(entry));
  }

  // Least recently used first, down to 90% of the limit.
  function evict() {
    if (total <= maxBytes) return;
    const oldest = [...entries.values()].sort((a, b) => a.usedAt - b.usedAt);
    for (const entry of oldest) {
      if (total <= maxBytes * 0.9) break;
      drop(entry);
    }
  }

  function store(key, response, rules) {
    const old = entries.get(key) || null;
    const name = crypto.createHash('sha1').update(key).digest('hex');
    const now = Date.now();
    const entry = {
      key, name, etag: rules.etag, maxAge: rules.maxAge,
      contentType: String(response.headers['content-type'] || 'application/octet-stream'),
      size: response.body.length, storedAt: now, validatedAt: now, usedAt: now,
    };
    // The old copy may be open for another request: then keep using it.
    if (!writeAtomic(binOf(entry), response.body)) return null;
    if (old) {
      entries.delete(key);
      total -= old.size;
    }
    saveMeta(entry);
    entries.set(key, entry);
    total += entry.size;
    evict();
    return entry;
  }

  function present(entry) {
    try {
      return fs.statSync(binOf(entry)).size === entry.size;
    } catch (error) {
      return false;
    }
  }

  function reply(req, res, entry, state) {
    const now = Date.now();
    if (now - entry.usedAt > TOUCH_MS) {
      entry.usedAt = now;
      saveMeta(entry);
    } else {
      entry.usedAt = now;
    }
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': entry.size,
      'Cache-Control': `public, max-age=${entry.maxAge}`,
      ETag: entry.etag,
      'X-Launcher-Cache': state,
    });
    fs.createReadStream(binOf(entry)).on('error', () => res.destroy()).pipe(res);
  }

  function pass(res, response, state) {
    const headers = Object.assign({}, response.headers, { 'content-length': response.body.length, 'x-launcher-cache': state });
    delete headers['transfer-encoding'];
    delete headers.connection;
    res.writeHead(response.status, headers);
    res.end(response.body);
  }

  // One request to the server per asset, however many ask at once.
  // -> { entry, state } (answer from disk) or { response } (pass it on)
  function fetchShared(key, fetchUpstream) {
    let pending = inflight.get(key);
    if (pending) return pending;
    pending = (async () => {
      const before = entries.get(key) || null;
      const usable = before && present(before) ? before : null;
      let response;
      try {
        response = await fetchUpstream(usable ? { 'if-none-match': usable.etag } : {});
      } catch (error) {
        if (usable) return { entry: usable, state: 'STALE' };
        throw error;
      }
      if (response.status === 304 && usable) {
        usable.validatedAt = Date.now();
        usable.maxAge = maxAgeOf(response.headers, usable.maxAge);
        saveMeta(usable);
        return { entry: usable, state: 'REVALIDATED' };
      }
      const rules = rulesOf(response.status, response.headers);
      if (rules && response.body.length > 0 && response.body.length <= MAX_ENTRY_BYTES) {
        const stored = store(key, response, rules);
        if (stored) return { entry: stored, state: 'STORED' };
        return { response, state: 'NOT-STORED' };
      }
      // The server failed: the kept copy is better than nothing.
      if (usable && response.status >= 400) return { entry: usable, state: 'STALE' };
      if (before && response.status === 200) drop(before); // no longer meant to be kept
      return { response, state: 'BYPASS' };
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  async function serve(req, res, fetchUpstream) {
    const key = keyOf(req.url);
    const entry = entries.get(key);
    if (entry && Date.now() - entry.validatedAt < entry.maxAge * 1000 && present(entry)) {
      reply(req, res, entry, 'HIT');
      return;
    }
    const outcome = await fetchShared(key, fetchUpstream);
    if (outcome.entry && present(outcome.entry)) reply(req, res, outcome.entry, outcome.state);
    else if (outcome.response) pass(res, outcome.response, outcome.state);
    else throw new Error('the kept copy of this asset disappeared');
  }

  if (log) log(`Asset cache: ${entries.size} assets (${Math.round(total / 1048576)} MB) kept on this PC.`);
  return { handles, serve, get size() { return total; }, get count() { return entries.size; } };
}

// The whole cache (every server's folder) for Settings.
function usage(root) {
  let bytes = 0;
  let files = 0;
  let servers = [];
  try { servers = fs.readdirSync(root); } catch (error) { return { bytes, files }; }
  for (const server of servers) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, server)); } catch (error) { continue; }
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      try {
        bytes += fs.statSync(path.join(root, server, name)).size;
        files++;
      } catch (error) { /* removed meanwhile */ }
    }
  }
  return { bytes, files };
}

function clear(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// A folder name for a server address (http://100.1.2.3:8080 -> 100.1.2.3_8080).
function folderFor(centralUrl) {
  return new URL(centralUrl).host.replace(/[^A-Za-z0-9.-]/g, '_');
}

module.exports = { createAssetCache, usage, clear, folderFor, keyOf, rulesOf, DEFAULT_MAX_BYTES };
