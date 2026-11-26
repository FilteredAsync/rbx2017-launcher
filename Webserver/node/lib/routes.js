'use strict';

// Endpoints that ran PHP logic under UwAmp, ported one-for-one. Static files
// and PHP files that only print fixed text are served by www.js instead.
// Each handler names the PHP file it replaces.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const core = require('./core');
const assets = require('./assets');
const avatar = require('./avatar');
const avatarStore = require('./avatarstore');
const compression = require('./compression');
const creators = require('./creators');
const accounts = require('./accounts');
const admin = require('./admin');
const announcements = require('./announcements');
const updates = require('./updates');
const datastore = require('./datastore');
const games = require('./games');
const gamethumbs = require('./gamethumbs');
const placefile = require('./placefile');
const rbxbinary = require('./rbxbinary');
const marketplace = require('./marketplace');
const ownership = require('./ownership');
const robux = require('./robux');
const unionshapes = require('./unionshapes');
const missingassets = require('./missingassets');
const places = require('./places');
const engines = require('./engines');
const privateservers = require('./privateservers');
const rbxm = require('./rbxm');
const reports = require('./reports');
const publicnet = require('./publicnet');
const restorevalues = require('./restorevalues');
const social = require('./social');
const thumbs = require('./thumbs');
const www = require('./www');

// --- Response helpers --------------------------------------------------------

// A launcher's proxy asked for compression on a route that allows it
// (ctx.compress: assets and place files; see lib/compression.js).
function compressionFor(ctx, status) {
  return ctx.compress && status === 200 && ctx.method !== 'HEAD' ? compression.encodingFor(ctx.req) : null;
}

function send(ctx, status, headers, body) {
  let buffer = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined ? '' : String(body), 'latin1');
  const out = Object.assign({}, headers);
  const encoding = compressionFor(ctx, status);
  if (encoding && buffer.length >= compression.MIN_BYTES && compression.worthCompressing(buffer)) {
    buffer = compression.compressSync(encoding, buffer);
    out['Content-Encoding'] = encoding;
    out.Vary = 'Accept-Encoding';
  }
  out['Content-Length'] = buffer.length;
  ctx.bytes = buffer.length;
  ctx.res.writeHead(status, out);
  ctx.res.end(ctx.method === 'HEAD' ? undefined : buffer);
}

function sendUtf8(ctx, status, headers, text) {
  send(ctx, status, headers, Buffer.from(text, 'utf8'));
}

// "Range: bytes=a-b" (one range) for a file of size bytes: { start, end },
// 'invalid', or null for the whole file. If-Range must name the ETag sent.
function rangeOf(ctx, size, etag) {
  const header = ctx.req.headers.range;
  if (!header || ctx.method !== 'GET') return null;
  const ifRange = ctx.req.headers['if-range'];
  if (ifRange !== undefined && (!etag || ifRange !== etag)) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

function sendFile(ctx, file, headers) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Asset not found');
    return;
  }
  // Compressed while it is sent (big place files too); no Content-Length.
  const encoding = compressionFor(ctx, 200);
  if (encoding && stat.size >= compression.MIN_BYTES && compression.worthCompressing(readHead(file, 16))) {
    ctx.bytes = 0;
    ctx.res.writeHead(200, Object.assign({}, headers, { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' }));
    const packer = compression.encoder(encoding);
    packer.on('data', (chunk) => { ctx.bytes += chunk.length; });
    fs.createReadStream(file).on('error', () => ctx.res.destroy()).pipe(packer).pipe(ctx.res);
    return;
  }
  // Downloads resume where they stopped (Range, with If-Range on the ETag),
  // on routes that allow it (ctx.ranges: the game files and Studio).
  const resumable = Boolean(ctx.ranges && headers.ETag);
  const range = resumable ? rangeOf(ctx, stat.size, headers.ETag) : null;
  if (range === 'invalid') {
    send(ctx, 416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Type': 'text/plain; charset=utf-8' }, 'Range not satisfiable');
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;
  ctx.bytes = length;
  const out = Object.assign({}, headers, { 'Content-Length': length });
  if (resumable) out['Accept-Ranges'] = 'bytes';
  if (range) out['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  ctx.res.writeHead(range ? 206 : 200, out);
  if (ctx.method === 'HEAD' || length === 0) {
    ctx.res.end();
    return;
  }
  fs.createReadStream(file, { start, end }).on('error', () => ctx.res.destroy()).pipe(ctx.res);
}

// --- Shared game helpers (www/game/functions.php) -------------------------------

let keyCache = { stamp: -1, key: null };

function signingKey() {
  const file = core.rootPath('Server', 'rbxsig_private.pem');
  const stamp = core.mtimeMs(file);
  if (stamp !== keyCache.stamp) {
    let key = null;
    try {
      key = crypto.createPrivateKey(fs.readFileSync(file));
    } catch (error) {
      key = null;
    }
    keyCache = { stamp, key };
  }
  return keyCache.key;
}

// sign() of functions.php: "--rbxsig%<base64 RSA-SHA1>%<script>". Scripts are
// handled as raw bytes (latin1) exactly like PHP strings.
function sign(script) {
  const key = signingKey();
  if (key === null) return null;
  const signature = crypto.sign('sha1', Buffer.from(script, 'latin1'), key).toString('base64');
  return `--rbxsig%${signature}%${script}`;
}

function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value);
}

function gameServerState() {
  const state = { jobId: 'Test', placeId: 1818, address: '127.0.0.1', port: 61250 };
  const saved = core.readJsonFile(path.join(core.WWW, 'game', 'server-state.json'));
  if (!saved) return state;
  if (typeof saved.jobId === 'string' && saved.jobId !== '') state.jobId = saved.jobId;
  if (isNumeric(saved.placeId)) state.placeId = Math.trunc(Number(saved.placeId));
  if (typeof saved.address === 'string' && net.isIP(saved.address) !== 0) state.address = saved.address;
  if (isNumeric(saved.port)) {
    const port = Math.trunc(Number(saved.port));
    if (port >= 1 && port <= 65535) state.port = port;
  }
  return state;
}

function ctypeDigit(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

// PHP rawurlencode(): like encodeURIComponent, but also escapes !'()*
function rawurlencode(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// PHP strings are bytes: a UTF-8 query value inserted into a latin1-handled
// template must keep its UTF-8 bytes.
function utf8Bytes(text) {
  return Buffer.from(String(text), 'utf8').toString('latin1');
}

// --- www/asset/index.php ----------------------------------------------------------

const inflight = new Map();

function fail(ctx, status, message) {
  sendUtf8(ctx, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, message);
}

function cachedContentType(metadataPath) {
  const metadata = core.readJsonFile(metadataPath);
  return metadata && typeof metadata.contentType === 'string' ? metadata.contentType : 'application/octet-stream';
}

// An asset cache file's ETag (size and time). Launchers keep assets on the
// player's PC (lib/proxycache.js) and ask with If-None-Match whether theirs
// is still current, which a 304 answers without sending the asset again.
function fileEtag(file) {
  try {
    const stat = fs.statSync(file);
    return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  } catch (error) {
    return null;
  }
}

function notModified(ctx, etag, headers) {
  if (!etag || ctx.req.headers['if-none-match'] !== etag) return false;
  send(ctx, 304, headers, '');
  return true;
}

// A replacement asset (assets-override/, uploaded on /manage). Launchers may
// keep it too, but check every few minutes, so a new replacement reaches
// players soon (a 304 costs next to nothing).
const OVERRIDE_MAX_AGE = 300;
function sendOverride(ctx, file) {
  const etag = fileEtag(file);
  const headers = Object.assign({ 'Content-Type': assets.contentTypeFor(file), 'Cache-Control': `public, max-age=${OVERRIDE_MAX_AGE}`, 'X-Legacy-Asset-Cache': 'OVERRIDE' }, etag ? { ETag: etag } : {});
  if (notModified(ctx, etag, headers)) return;
  sendFile(ctx, file, headers);
}

function readHead(file, size) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(handle, buffer, 0, size, 0);
    return buffer.subarray(0, read);
  } catch (error) {
    return Buffer.alloc(0);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// The games an asset request came from, for the missing assets list: [] when
// unknown, several when it could be any of them. The engine names the place
// (&serverplaceid= for InsertService, LinkedSource and animations, or the
// Roblox-Place-Id header); otherwise a remote address is a player's launcher
// (the game they joined last) or a host PC's RCC (its listed games), and
// loopback without a launcher proxy is an RCC job on this PC (its servers).
function placeOf(ctx) {
  const named = places.placeKey(ctx.queryLower.serverplaceid) || places.placeKey(ctx.queryLower.moduleplaceid) || places.placeKey(ctx.req.headers['roblox-place-id']);
  if (named) return [named];
  const isLoopback = (remote) => /^(?:127\.|::1$)/.test(String(remote || '').replace(/^::ffff:/i, ''));
  const loopback = isLoopback(ctx.remote);
  const registered = () => [...new Set(games.listAll().map((listed) => games.get(listed.id))
    .filter((game) => game && (loopback ? isLoopback(game.registeredFrom) : sameAddress(game.registeredFrom, ctx.remote)))
    .map((game) => String(game.placeId)))];
  if (loopback && !ctx.req.headers['x-launcher-proxy']) {
    const runner = places.runnerStatus();
    const running = runner && !runner.stale && runner.servers ? Object.values(runner.servers).map((server) => String(server.placeId)) : [];
    const onThisPc = [...new Set(running.concat(registered()))].filter((placeId) => places.placeKey(placeId));
    if (onThisPc.length) return onThisPc;
  }
  const joined = launcher.placeAt(ctx.remote);
  return joined ? [joined] : registered();
}

function noteMissing(ctx, assetId, placeIds) {
  try { missingassets.noteUse(assetId, placeIds || placeOf(ctx)); } catch (error) { /* only for /manage */ }
}

async function assetEndpoint(ctx) {
  // Launchers' proxies may ask for these answers compressed (lib/compression.js).
  ctx.compress = true;
  // A library place opened in Studio (lib/studio.js).
  if (studio.placeAsset(ctx)) return;
  const query = ctx.queryLower;
  // Studio's Toolbox inserting an item, converted for 2017 (lib/toolbox.js).
  if (query.toolbox !== undefined) return toolbox.insert(ctx);
  const decimalParameter = (name) => {
    if (query[name] === undefined) return undefined;
    const value = core.decimal(String(query[name]));
    return value === null ? null : value;
  };

  let assetId = decimalParameter('id');
  if (assetId === null) return fail(ctx, 400, 'Invalid id');
  let assetVersionId = decimalParameter('assetversionid');
  if (assetVersionId === null) return fail(ctx, 400, 'Invalid assetversionid');
  if (assetId === undefined) assetId = null;
  if (assetVersionId === undefined) assetVersionId = null;
  const assetName = query.assetname !== undefined ? String(query.assetname) : null;

  // rbxgameasset://Images/Foo arrives as ?universeId=0&assetName=Images/Foo.
  // These names belong to the game's universe on Roblox: an override file or
  // a gameAssets entry wins, else Roblox resolves the name for the universe in
  // the request or config/assets.json "gameUniverseId" (the 2017 client
  // always sends universeId=0).
  let namedUniverse = null;
  if (assetId === null && assetVersionId === null && assetName !== null && assetName !== '') {
    const override = assets.findOverride(`named/${assetName}`);
    if (override !== null) {
      return sendOverride(ctx, override);
    }
    const config = core.assetConfig();
    const mapped = config.gameAssets && config.gameAssets[assetName] !== undefined ? core.decimal(config.gameAssets[assetName]) : null;
    if (mapped !== null) {
      assetId = mapped;
    } else {
      const requested = decimalParameter('universeid');
      const configured = config.gameUniverseId !== undefined && config.gameUniverseId !== '' ? core.decimal(String(config.gameUniverseId)) : null;
      namedUniverse = requested && requested !== '0' ? requested : configured;
      if (namedUniverse === null) {
        core.assetLog(`named asset '${assetName}': no file in assets-override/named/, no gameAssets entry and no gameUniverseId`);
        return fail(ctx, 404, `Named game asset is not mapped: ${assetName}`);
      }
    }
  }

  if (assetId === null && assetVersionId === null && namedUniverse === null) return fail(ctx, 400, 'An id or assetversionid is required');
  if (assetId !== null && assetVersionId !== null) return fail(ctx, 400, 'Specify either id or assetversionid, not both');

  // Synthetic version IDs come from avatar-fetch and stand for an asset ID.
  if (assetVersionId !== null) {
    const translated = core.assetForVersionId(assetVersionId);
    if (translated !== null) {
      assetId = translated;
      assetVersionId = null;
    }
  }

  // The hosted place (1818, or the place ID of any listed game) is the local
  // place file, never the unrelated Roblox asset with that number. Only for
  // this PC, the host key and the place's editors (studio.mayHavePlaceFile).
  const libraryPlace = assetId !== null ? places.load().places[assetId] : null;
  if (assetId !== null && (libraryPlace || assetId === '1818' || games.list().some((game) => String(game.placeId) === String(assetId)))) {
    if (!studio.mayHavePlaceFile(ctx, assetId)) return fail(ctx, 403, 'Only the game\'s editors can download its place file.');
    // A 2018 RCC of a year the game isn't set to gets that year's file (lib/yearplaces.js).
    const placeFile = libraryPlace ? require('./yearplaces').fetchedFile(libraryPlace, assetId, { loopback: publicnet.fromLoopback(ctx), userAgent: ctx.req.headers['user-agent'] })
      : core.rootPath('Server', 'content', 'place.rbxlx');
    if (!core.isFile(placeFile)) return fail(ctx, 500, 'Local place file is missing');
    return sendFile(ctx, placeFile, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Legacy-Asset-Cache': 'LOCAL' });
  }
  // Locally signed starter script on a private ID (see the PHP version).
  const localScripts = { 37801173: core.rootPath('Client', 'content', 'scripts', 'StarterScript.lua') };
  if (assetId !== null && localScripts[assetId]) {
    if (!core.isFile(localScripts[assetId])) return fail(ctx, 500, 'Local starter script is missing');
    return sendFile(ctx, localScripts[assetId], { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Legacy-Asset-Cache': 'LOCAL-SCRIPT' });
  }

  const kind = namedUniverse !== null ? 'named' : assetId !== null ? 'id' : 'version';
  const value = namedUniverse !== null ? `${namedUniverse}:${assetName}` : assetId !== null ? assetId : assetVersionId;
  // Names can hold any character, so their cache files are named by a hash.
  const fileKey = kind === 'named'
    ? `named-${namedUniverse}-${crypto.createHash('sha1').update(assetName).digest('hex').slice(0, 24)}`
    : `${kind}-${value}`;

  // Body parts for the 2017 engine (see lib/rbxm.js); the appearance list asks
  // for them with &legacybodypart=1.
  if (kind === 'id' && query.legacybodypart !== undefined) return legacyBodyPart(ctx, assetId);

  if (kind === 'id') {
    const override = assets.findOverride(assetId);
    if (override !== null) {
      return sendOverride(ctx, override);
    }
  }

  const cacheDirectory = core.cacheDir('assets');
  const cachePath = path.join(cacheDirectory, `${fileKey}.bin`);
  const metadataPath = `${cachePath}.json`;
  const missingPath = `${cachePath}.missing`;
  const cachedHeaders = (state, type, etag) => Object.assign({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Legacy-Asset-Cache': state }, etag ? { ETag: etag } : {});

  let size = 0;
  try { size = fs.statSync(cachePath).size; } catch (error) { size = 0; }
  if (size > 0) {
    // Old entries may still be gzip or a too-new mesh; a mesh that could not
    // be converted is flagged so it is not retried on every request.
    let metadata = core.readJsonFile(metadataPath);
    if (assets.needsNormalizing(readHead(cachePath, 32)) && !(metadata && metadata.meshUnconverted !== undefined)) {
      const { bytes, changes } = assets.normalizeAsset(fs.readFileSync(cachePath));
      if (changes.includes('mesh-unconverted')) {
        metadata = metadata && !Array.isArray(metadata) ? metadata : {};
        metadata.meshUnconverted = assets.meshError();
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      }
      if (changes.some((change) => change !== 'mesh-unconverted')) {
        core.writeFileAtomic(cachePath, bytes);
        return send(ctx, 200, cachedHeaders('HIT-REPAIRED', cachedContentType(metadataPath), fileEtag(cachePath)), bytes);
      }
    }
    const headers = cachedHeaders('HIT', cachedContentType(metadataPath), fileEtag(cachePath));
    if (notModified(ctx, headers.ETag, headers)) return;
    return sendFile(ctx, cachePath, headers);
  }

  // Remembered failures: private/gone for a day, others for an hour; new
  // credentials retry sign-in failures at once.
  if (core.isFile(missingPath)) {
    const missing = core.readJsonFile(missingPath);
    const missingStatus = missing && missing.status !== undefined ? Math.trunc(Number(missing.status)) || 0 : 0;
    const markedAt = core.mtimeMs(missingPath);
    const ttl = [400, 403, 404].includes(missingStatus) ? 86400000 : 3600000;
    const credentialsChanged = assets.credentialsMtime() > markedAt && [0, 401, 403].includes(missingStatus);
    if (!credentialsChanged && markedAt >= Date.now() - ttl) {
      if (kind === 'id') noteMissing(ctx, assetId);
      return fail(ctx, 404, 'Asset unavailable' + (missing && missing.reason !== undefined ? `: ${missing.reason}` : ''));
    }
    try { fs.unlinkSync(missingPath); } catch (error) { /* raced */ }
  }

  // One download per asset even when the client asks several times at once.
  const key = fileKey;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchIntoCache(kind, value, cachePath, metadataPath, missingPath).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const outcome = await pending;
  if (!outcome.ok) {
    // 404: fetchIntoCache marked it missing.
    if (kind === 'id' && outcome.status === 404) noteMissing(ctx, assetId);
    return fail(ctx, outcome.status, outcome.message);
  }
  return send(ctx, 200, cachedHeaders('MISS', outcome.contentType, fileEtag(cachePath)), outcome.bytes);
}

// A body part asset reduced to its R6 CharacterMesh as an XML model. Older
// XML body parts are already readable and are sent unchanged.
async function legacyBodyPart(ctx, assetId) {
  const cachePath = path.join(core.cacheDir('assets'), `id-${assetId}.bin`);
  let bytes = null;
  try {
    if (fs.statSync(cachePath).size > 0) bytes = fs.readFileSync(cachePath);
  } catch (error) {
    bytes = null;
  }
  if (bytes === null) {
    const outcome = await fetchIntoCache('id', assetId, cachePath, `${cachePath}.json`, `${cachePath}.missing`);
    if (!outcome.ok) {
      if (outcome.status === 404) noteMissing(ctx, assetId, ['avatar']);
      return fail(ctx, outcome.status, outcome.message);
    }
    bytes = outcome.bytes;
  } else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = assets.normalizeAsset(bytes).bytes;
  }
  const meshes = rbxm.characterMeshes(bytes);
  if (meshes === null) {
    return send(ctx, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Legacy-Asset-Cache': 'BODYPART-UNCHANGED' }, bytes);
  }
  const { xml, kept, skipped } = rbxm.characterMeshXml(meshes);
  if (skipped > 0) core.assetLog(`body part ${assetId}: ${skipped} CharacterMesh with IDs too large for the 2017 engine left out`);
  send(ctx, 200, { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store', 'X-Legacy-Asset-Cache': `BODYPART-R6-${kept}` }, xml);
}

// An asset's bytes from the cache, downloading it first if needed (meshes
// converted for the 2017 client, gzip undone). null if Roblox has none.
async function assetBytes(assetId) {
  const cachePath = path.join(core.cacheDir('assets'), `id-${assetId}.bin`);
  try {
    if (fs.statSync(cachePath).size > 0) {
      const bytes = fs.readFileSync(cachePath);
      return bytes[0] === 0x1f && bytes[1] === 0x8b ? assets.normalizeAsset(bytes).bytes : bytes;
    }
  } catch (error) { /* not cached yet */ }
  const key = `id-${assetId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchIntoCache('id', assetId, cachePath, `${cachePath}.json`, `${cachePath}.missing`).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const outcome = await pending;
  return outcome.ok ? outcome.bytes : null;
}

async function fetchIntoCache(kind, value, cachePath, metadataPath, missingPath) {
  const download = await assets.downloadAsset(kind === 'id' || kind === 'named' ? kind : 'assetversionid', value);
  if (!download.ok) {
    const status = download.status;
    let reason = `HTTP ${status}${download.message !== '' ? ` ${download.message}` : ''}`;
    if (status === 401) reason += ' (add an Open Cloud API key, see config/README.txt)';
    else if (status === 403) reason += ' (private on Roblox; put a replacement in assets-override/)';
    core.assetLog(`${kind} ${value}: ${reason} [tried: ${download.via}]`);
    if ([400, 401, 403, 404].includes(status)) {
      fs.writeFileSync(missingPath, JSON.stringify({ status, reason, at: core.isoDate() }));
      return { ok: false, status: 404, message: `Roblox asset delivery failed: ${reason}` };
    }
    return { ok: false, status: 502, message: `Roblox asset delivery failed: ${reason}` };
  }
  const { bytes, changes } = assets.normalizeAsset(download.body);
  if (!core.writeFileAtomic(cachePath, bytes) && !core.isFile(cachePath)) {
    return { ok: false, status: 500, message: 'Unable to commit the asset cache entry' };
  }
  const metadata = {
    contentType: download.contentType,
    source: `${kind}=${value}`,
    via: download.via,
    converted: changes.filter((change) => change !== 'mesh-unconverted'),
    downloadedAt: core.isoDate(),
  };
  if (changes.includes('mesh-unconverted')) metadata.meshUnconverted = assets.meshError();
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  return { ok: true, bytes, contentType: download.contentType };
}

// --- Character endpoints ---------------------------------------------------------

function characterParams(ctx) {
  const query = ctx.queryLower;
  const raw = query.userid !== undefined ? String(query.userid) : null;
  // Guests have negative user IDs.
  const userId = raw === null ? null : /^-\d{1,9}$/.test(raw) ? raw : core.decimal(raw);
  const username = query.username !== undefined && avatar.validUsername(String(query.username)) ? String(query.username) : null;
  return { userId, username };
}

// www/v1.1/avatar-fetch/index.php
async function avatarFetch(ctx) {
  const { userId, username } = characterParams(ctx);
  const placeId = /^\d{1,15}$/.test(String(ctx.queryLower.placeid || '')) ? String(ctx.queryLower.placeid) : null;
  const character = await avatar.characterFor(userId, username, { placeId });
  const json = avatar.avatarFetchJson(character, userId, username);
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
  if (ctx.queryLower.debug !== undefined) {
    return sendUtf8(ctx, 200, headers, JSON.stringify({ character, response: JSON.parse(json) }, null, 4));
  }
  send(ctx, 200, headers, json);
}

// www/asset/bodycolors.php
async function bodyColors(ctx) {
  const { userId, username } = characterParams(ctx);
  const character = await avatar.characterFor(userId, username);
  send(ctx, 200, { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' }, avatar.bodyColorsXml(character));
}

// www/game/characterappearance.ashx/index.php
async function characterAppearance(ctx) {
  const { userId, username } = characterParams(ctx);
  const character = await avatar.characterFor(userId, username);
  const baseUrl = String(core.assetConfig().baseUrl).replace(/\/+$/, '');
  let appearance = avatar.bodyColorsUrl(userId, username !== null ? username : character.username);
  for (const asset of character.assets) {
    // Body parts (27-31) come back as an R6 CharacterMesh the 2017 engine reads.
    const bodyPart = asset.typeId >= 27 && asset.typeId <= 31 ? '&legacybodypart=1' : '';
    appearance += `;${baseUrl}/asset/?id=${asset.id}${bodyPart}`;
  }
  send(ctx, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, `${appearance};`);
}

// --- Joining -------------------------------------------------------------------------

// www/game/placelauncher.ashx/index.php. With ?gameId=<id> (multiplayer,
// from playGame.bat) the join goes to that registered game instead of the
// local server-state.json game.
async function placeLauncher(ctx) {
  // Studio joining a Team Create server (lib/studio.js).
  if (studio.cloudEditLaunch(ctx)) return;
  // The Android app's game engine (lib/mobile.js).
  if (mobile.isMobile(ctx)) return mobile.placeLauncher(ctx);
  const q = ctx.query;
  let state = gameServerState();
  const gameId = ctx.queryLower.gameid;
  if (gameId !== undefined && gameId !== '') {
    const game = games.get(String(gameId));
    if (game === null) {
      return send(ctx, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        core.phpJson({ jobId: '', status: 5, joinScriptUrl: null, authenticationUrl: null, authenticationTicket: null, message: 'That game is no longer online.' }));
    }
    if (game.privateId && !launcher.ticketAllows(q.ticket, game.id)) {
      return send(ctx, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        core.phpJson({ jobId: game.id, status: 12, joinScriptUrl: null, authenticationUrl: null, authenticationTicket: null, message: 'That is a private server. Join it from the launcher.' }));
    }
    const target = await games.resolve(game);
    if (target === null) {
      return send(ctx, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        core.phpJson({ jobId: game.id, status: 4, joinScriptUrl: null, authenticationUrl: null, authenticationTicket: null, message: `Could not find the game server address ${game.address.host}.` }));
    }
    state = { jobId: game.id, placeId: game.placeId, address: target.ip, port: target.port };
  }
  // playGame.bat relays the game's UDP traffic through 127.0.0.1, because
  // this 2017 client binds its game socket to loopback and can only reach a
  // server there (lib/relay.js). relayport is that relay's local port.
  const relayPort = Number(ctx.queryLower.relayport);
  if (Number.isInteger(relayPort) && relayPort > 0 && relayPort < 65536) {
    state = Object.assign({}, state, { address: '127.0.0.1', port: relayPort });
  }
  const placeId = ctypeDigit(q.placeid) ? q.placeid : String(state.placeId);
  // Who joins: the launcher's join ticket (lib/launcherapi.js) decides the
  // name and user ID; without one the player is a guest. "allowNamedJoins":
  // true in config/assets.json brings back joining under any typed name.
  let userId;
  let username;
  if (core.assetConfig().allowNamedJoins === true && q.ticket === undefined) {
    userId = ctypeDigit(q.id) ? q.id : '1';
    const activeUser = avatar.activeUsername();
    username = q.username !== undefined ? q.username : (q.user !== undefined ? q.user : (activeUser !== null ? activeUser : 'Player'));
  } else {
    const who = launcher.joinIdentity(q.ticket, ctx.remote);
    userId = String(who.userId);
    username = who.name;
  }
  const appearance = `http://localhost./v1.1/avatar-fetch/?placeId=${rawurlencode(placeId)}&userId=${rawurlencode(userId)}`;
  const joinUrl = 'http://localhost./game/join.php'
    + `?placeid=${rawurlencode(placeId)}`
    + `&ip=${rawurlencode(state.address)}`
    + `&port=${rawurlencode(String(state.port))}`
    + `&id=${rawurlencode(userId)}`
    + `&user=${rawurlencode(username)}`
    + `&app=${rawurlencode(appearance)}`
    + `&sig=${launcher.joinSignature(userId, username, placeId)}`;
  send(ctx, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, core.phpJson({
    jobId: state.jobId,
    status: 2,
    joinScriptUrl: joinUrl,
    authenticationUrl: 'http://localhost./Login/Negotiate.ashx/',
    authenticationTicket: 'Test',
    message: null,
  }));
}

// www/game/join.php
function join(ctx) {
  const q = ctx.query;
  const integer = (name, fallback) => {
    if (!ctypeDigit(q[name])) return fallback;
    const value = q[name].replace(/^0+/, '');
    return value === '' ? '0' : value;
  };
  const state = gameServerState();
  const placeid = integer('placeid', String(state.placeId));
  const port = integer('port', String(state.port));
  let id = /^-\d{1,9}$/.test(String(q.id || '')) ? String(q.id) : integer('id', '1');
  let ip = q.ip !== undefined ? q.ip : state.address;
  const activeUser = avatar.activeUsername();
  let user = q.user !== undefined ? q.user : (q.username !== undefined ? q.username : (activeUser !== null ? activeUser : 'Player'));
  // The name and ID come signed from placelauncher.ashx; an address made up
  // by hand joins as a guest.
  if (!(core.assetConfig().allowNamedJoins === true && q.sig === undefined)
    && !launcher.checkJoinSignature(id, String(user), placeid, q.sig)) {
    const guest = launcher.guestIdentity();
    id = String(guest.userId);
    user = guest.name;
  }
  // The Android app's engine reaches this server by its public name, not
  // through the PC launcher's localhost. proxy.
  const mobileBase = mobile.isMobile(ctx) ? mobile.baseUrl(ctx) : null;
  const app = `${mobileBase || 'http://localhost./'}v1.1/avatar-fetch/?placeId=${placeid}&userId=${id}`;
  avatar.rememberLocalUser(id, String(user));
  if (net.isIP(ip) === 0) ip = '127.0.0.1';

  const template = fs.readFileSync(path.join(core.WWW, 'game', 'joinguest.ashx')).toString('latin1');
  let payload = core.strtr(template, {
    '%user%': core.phpJson(user),
    '%ip%': core.phpJson(ip),
    '%port%': port,
    '%id%': id,
    '%app%': core.phpJson(app),
    '%placeid%': placeid,
  });
  // The client reads ServerPort as a number, and needs these fields before
  // MachineAddress; see the comments in join.php.
  payload = payload.split(`"ServerPort":"${port}"`).join(`"ServerPort":${port}`);
  if (mobileBase) payload = payload.split('"BaseUrl":"http://localhost./"').join(`"BaseUrl":${core.phpJson(mobileBase)}`);
  // PlaceId comes from the template (%placeid%, the hosted game's place). It
  // was once forced to 1818 here, so any other place ID gave the client and
  // RCC different place IDs and the client crashed right after loading.
  payload = payload.replace(/"IsRobloxPlace":(?:true|false)/, '"IsRobloxPlace":true');
  // Player.MembershipType: the account's Builders Club (lib/membership.js).
  payload = payload.replace('"MembershipType":"None"', `"MembershipType":"${require('./membership').membershipType(id)}"`);
  // game.CreatorId and CreatorType, the same as on the game server (hosting.js).
  const creator = places.exists() ? places.creatorOf(places.load().places[placeid]) : null;
  payload = payload.replace(/"CreatorId":\d+,"CreatorTypeEnum":"\w+"/,
    `"CreatorId":${creator ? creator.id : 0},"CreatorTypeEnum":"${creator ? creator.type : 'User'}"`);
  payload = payload.replace(/[ \t\n\r\0\x0B]+$/, '');
  if (payload.endsWith('}')) {
    payload = payload.slice(0, -1)
      + ',"CountryCode":"US"'
      + ',"GameId":"29fd9df4-4c59-4d8c-8cee-8f187b09709b"'
      + ',"GameChatType":"AllUsers"'
      + `,"ClientTicket":${core.phpJson('Test')}`
      + ',"BrowserTrackerId":0}\n';
  }
  payload = '\r\n' + payload.replace(/^[\r\n]+/, '');
  const signed = sign(payload);
  if (signed === null) return send(ctx, 500, { 'Content-Type': 'text/plain' }, 'Unable to sign join script');
  send(ctx, 200, { 'Content-Type': 'text/plain' }, signed);
}

// www/game/join.lua/index.php (Lua text read from the PHP file itself)
function joinLua(ctx) {
  const q = ctx.query;
  const state = gameServerState();
  const id = ctypeDigit(q.id) ? q.id : '1';
  const source = fs.readFileSync(path.join(core.WWW, 'game', 'join.lua', 'index.php')).toString('latin1');
  const match = /<<<LUA\r?\n([\s\S]*?)\r?\nLUA;/.exec(source);
  if (!match) return send(ctx, 500, { 'Content-Type': 'text/plain' }, 'join.lua template is missing');
  const script = match[1]
    .split('$luaAddress').join(core.phpJson(state.address))
    .split('$port').join(String(state.port))
    .split('$id').join(id);
  const signed = sign(script);
  if (signed === null) return send(ctx, 500, { 'Content-Type': 'text/plain' }, 'Unable to sign join script');
  send(ctx, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, signed);
}

// Old template joins: www/game/join1.php ... joinTurboBuildersClub.php and
// placelauncherr.php. "rbxsig" = functions.php, "none" = functions2.php,
// "unsigned" = functions1.php (signs but returns the plain script).
const TEMPLATE_JOINS = {
  'join1.php': ['joinguest1.txt', 'rbxsig'],
  'join2.php': ['joinguest2.txt', 'rbxsig'],
  'join3.php': ['joinguest3.txt', 'rbxsig'],
  'joinbuildersclub.php': ['joinguest3.txt', 'none'],
  'joinnone.php': ['joinguest.txt', 'none'],
  'joinoutrageousbuildersclub.php': ['joinguest1.txt', 'none'],
  'jointurbobuildersclub.php': ['joinguest2.txt', 'none'],
  'placelauncherr.php': ['launchcode.txt', 'unsigned'],
};

function templateJoin(ctx, match) {
  const [templateName, signing] = TEMPLATE_JOINS[match[1].toLowerCase()];
  const q = ctx.query;
  let text = '';
  try { text = fs.readFileSync(path.join(core.WWW, 'game', templateName)).toString('latin1'); } catch (error) { text = ''; }
  for (const name of ['user', 'ip', 'port', 'id', 'app']) {
    text = text.split(`%${name}%`).join(q[name] !== undefined ? utf8Bytes(q[name]) : '');
  }
  let body = text;
  if (signing === 'rbxsig') {
    body = sign(text);
    if (body === null) return send(ctx, 500, { 'Content-Type': 'text/plain' }, 'Unable to sign join script');
  }
  send(ctx, 200, { 'Content-Type': 'text/plain' }, body);
}

// www/game/studio.ashx, global.ashx and oldstudio.ashx load their key from a
// remote or missing path, so PHP always produced an empty signature. Kept
// as-is: "--rbxsig%%" + the Lua between the PHP blocks.
function unsignedStartScript(ctx, match) {
  const file = path.join(core.WWW, 'game', `${match[1].toLowerCase()}.ashx`, 'index.php');
  const segments = www.phpSegments(fs.readFileSync(file).toString('latin1'));
  const literals = segments.filter((segment) => segment.literal).map((segment) => segment.text);
  const data = literals.slice(1, -1).join('');
  send(ctx, 200, { 'Content-Type': 'text/plain' }, `--rbxsig%%${data}`);
}

// --- Request body limits -----------------------------------------------------------------
// Each route reads with its own (ctx.body(limit), server.js); past it the
// answer is 413. Only place uploads take 1 GB.
const KB = 1024;
const MB = 1024 * KB;
const FORM_LIMIT = 64 * KB; // purchases, device/initialize: a few form fields
const JSON_LIMIT = 256 * KB; // jsonBody's default
const FILTER_TEXT_LIMIT = 256 * KB;
const DATASTORE_LIMIT = 32 * MB; // a 4 MB value, form-encoded, with room
const ABUSE_REPORT_LIMIT = 16 * reports.MAX_BODY; // as much as a gzipped one may unpack to
const PLACE_UPLOAD_LIMIT = 1024 * MB;
const UPDATE_UPLOAD_LIMIT = 600 * MB; // as lib/updates.js downloads one

// --- Small endpoints ---------------------------------------------------------------------

// Crash uploads. The client and Studio post their dumps and logs to
// Error/Dmp.ashx when they next start, RCC to Error/Grid.ashx. They are kept
// in logs/captures (not the web root, so never served), newest first, within
// the limits below. This PC may always upload. Others need a game server's
// address or a signed-in account, and have a per-address limit. Everyone
// else still gets "OK", so their client does not retry at every start.
const CAPTURE_DIR = core.rootPath('Webserver', 'node', 'logs', 'captures');
const CAPTURE_MAX_FILE = 32 * 1024 * 1024; // the largest dumps are about 10 MB
const CAPTURE_MAX_TOTAL = 512 * 1024 * 1024;
const CAPTURE_MAX_FILES = 200;
const CAPTURE_PER_HOUR = 30; // files from one address that is not this PC
const CAPTURE_AT_ONCE = 4; // uploads from other PCs read at the same time
const HOUR_MS = 60 * 60 * 1000;
const captureCounts = new Map();
let captureReading = 0;
const captureHeaders = { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' };

function captureKept(ctx) {
  if (ctx.method !== 'POST') return false;
  if (publicnet.fromLoopback(ctx)) return true;
  // The Android app's crash dumps (log_*.Android.dmp to m.<domain>, at its
  // next start) may come before anyone has signed in.
  const androidDump = mobile.isMobile(ctx) && /\.android\.dmp$/i.test(String(ctx.query.filename || ''));
  if (!fromGameServer(ctx.remote) && accounts.fromRequest(ctx.req) === null && !androidDump) return false;
  if (captureReading >= CAPTURE_AT_ONCE) return false;
  const now = Date.now();
  let entry = captureCounts.get(ctx.remote);
  if (!entry || now - entry.first > HOUR_MS) {
    if (captureCounts.size > 1000) {
      for (const [key, value] of captureCounts) if (now - value.first > HOUR_MS) captureCounts.delete(key);
    }
    entry = { first: now, count: 0 };
    captureCounts.set(ctx.remote, entry);
  }
  if (entry.count >= CAPTURE_PER_HOUR) return false;
  entry.count++;
  return true;
}

// Reads the upload, keeping its bytes only when `keep`. null: over `limit`
// (or cut off), so the caller closes the connection.
function captureBody(req, limit, keep) {
  if (Number(req.headers['content-length']) > limit) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) finish(null);
      else if (keep) chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

// Newest first; deletes what is past CAPTURE_MAX_FILES or CAPTURE_MAX_TOTAL.
function pruneCaptures() {
  let names;
  try { names = fs.readdirSync(CAPTURE_DIR); } catch (error) { return; }
  const files = [];
  for (const name of names) {
    const file = path.join(CAPTURE_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ file, size: stat.size, at: stat.mtimeMs });
    } catch (error) { /* already gone */ }
  }
  files.sort((a, b) => b.at - a.at || (a.file < b.file ? 1 : -1));
  let total = 0;
  files.forEach((item, index) => {
    total += item.size;
    if (index < CAPTURE_MAX_FILES && total <= CAPTURE_MAX_TOTAL) return;
    try { fs.unlinkSync(item.file); } catch (error) { /* in use */ }
  });
}

async function captureUpload(ctx) {
  const keep = captureKept(ctx);
  const counted = keep && !publicnet.fromLoopback(ctx);
  if (counted) captureReading++;
  let body;
  try {
    body = await captureBody(ctx.req, CAPTURE_MAX_FILE, keep);
  } finally {
    if (counted) captureReading--;
  }
  if (body === null) {
    ctx.res.on('finish', () => ctx.req.destroy());
    return send(ctx, 413, Object.assign({ Connection: 'close' }, captureHeaders), 'too large');
  }
  let content = body;
  const type = String(ctx.req.headers['content-type'] || '');
  const boundaryMatch = /multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(type);
  if (keep && boundaryMatch) {
    const file = firstMultipartFile(body, boundaryMatch[2]);
    if (file !== null) content = file;
  }
  if (keep && content.length > 0) {
    const sourceName = ctx.query.filename !== undefined ? path.basename(String(ctx.query.filename).replace(/\\/g, '/')) : 'client-upload.bin';
    const safeName = sourceName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
    const stamp = core.gmdate().replace(/[-:]/g, '').replace(' ', '_');
    const unique = Date.now().toString(16) + Math.floor(Math.random() * 0xfffff).toString(16);
    try {
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CAPTURE_DIR, `${stamp}_${unique}_${safeName}`), content);
    } catch (error) {
      return send(ctx, 500, captureHeaders, 'capture failed');
    }
    pruneCaptures();
  }
  send(ctx, 200, captureHeaders, 'OK');
}

function firstMultipartFile(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    const headerStart = start + delimiter.length + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) return null;
    const next = body.indexOf(delimiter, headerEnd);
    if (next < 0) return null;
    const headers = body.toString('latin1', headerStart, headerEnd);
    if (/filename=/i.test(headers)) return body.subarray(headerEnd + 4, next - 2);
    start = next;
  }
  return null;
}

const jsonNoStore = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

// persistence/*: RCC's DataStoreService, stored per place (lib/datastore.js).
// Game servers only (fromGameServer): players' saves are read and written
// here. A launcher proxy's own requests (X-Launcher-Proxy) are never RCC's.
// Writes are logged to local-api-requests.log (values cut to 200 characters).
async function persistence(ctx, match) {
  if (ctx.req.headers['x-launcher-proxy'] || !fromGameServer(ctx.remote)) {
    send(ctx, 403, jsonNoStore, '{"errors":[{"code":0,"message":"Only game servers can use DataStores."}]}');
    return;
  }
  const action = match[1];
  const raw = (await ctx.body(DATASTORE_LIMIT)).toString('utf8');
  const form = core.parseQuery(raw.replace(/^&+/, ''));
  const query = Object.assign({}, ctx.query);
  const result = datastore.handle(action, query, form);
  if (result === null) {
    send(ctx, 404, jsonNoStore, '{"errors":[{"code":0,"message":"unknown persistence call"}]}');
    return;
  }
  if (action.toLowerCase() !== 'getv2' && action.toLowerCase() !== 'getsortedvalues') {
    const value = form.value !== undefined ? String(form.value) : '';
    const line = core.phpJson({
      time: core.isoDate(), route: `/persistence/${action}`, query, value: value.length > 200 ? `${value.slice(0, 200)}...` : value,
    }).replace(/\\\//g, '/');
    core.appendLog(core.rootPath('local-api-requests.log'), line, 5 * 1024 * 1024);
  }
  send(ctx, 200, jsonNoStore, JSON.stringify(result));
}

// www/moderation/v2/filtertext/index.php: echo the text back unfiltered.
async function filterText(ctx) {
  const raw = (await ctx.body(FILTER_TEXT_LIMIT)).toString('utf8');
  let text = '';
  try {
    const request = JSON.parse(raw);
    if (request !== null && typeof request === 'object') {
      for (const key of ['text', 'Text', 'message', 'Message']) {
        if (typeof request[key] === 'string') {
          text = request[key];
          break;
        }
      }
    }
  } catch (error) {
    text = '';
  }
  if (text === '' && /application\/x-www-form-urlencoded/i.test(String(ctx.req.headers['content-type'] || ''))) {
    const form = core.parseQuery(raw);
    if (typeof form.text === 'string') text = form.text;
  }
  sendUtf8(ctx, 200, jsonNoStore, JSON.stringify({
    success: true,
    data: { AgeUnder13: text, Age13OrOver: text },
    AgeUnder13: text,
    Age13OrOver: text,
    filteredText: text,
  }));
}

// A library place's creator as productinfo shows it.
function placeCreator(place) {
  const creator = places.creatorOf(place);
  if (!creator) return { Id: 0, Name: '', CreatorType: 'User' };
  return { Id: creator.id, Name: creator.name, CreatorType: creator.type };
}

// www/marketplace/productDetails.php: a developer product (lib/marketplace.js).
async function productDetails(ctx) {
  const info = await marketplace.productInfo(core.phpInt(ctx.queryLower.productid));
  send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, core.phpJson(info));
}

// www/marketplace/productinfo.php
async function productInfo(ctx) {
  let assetId = core.phpInt(ctx.queryLower.assetid);
  // Asset 0: Studio naming the window of a place it just opened (lib/studio.js).
  if (assetId === 0) {
    assetId = studio.openedPlace(ctx);
    if (assetId === 0) return send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, core.phpJson({
      TargetId: 0, ProductType: 'User Product', AssetId: 0, ProductId: 0, Name: 'New Place', Description: '', AssetTypeId: 9,
      Creator: { Id: 1, Name: 'ROBLOX', CreatorType: 'User' }, IconImageAssetId: 0, Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z',
      PriceInRobux: null, IsForSale: false, IsLimited: false, IsLimitedUnique: false, Remaining: null, MinimumMembershipLevel: 0, ContentRatingTypeId: 0,
    }));
  }
  // A library place: its own name and creator (the game's loading screen
  // shows "By ..."; Studio shows both, and Team Create checks the owner).
  // Anything else: its Roblox info (lib/marketplace.js), or one of the
  // asking game's passes (by the universe IDs of its places).
  const place = places.exists() ? places.get(assetId) : null;
  if (!place && assetId !== 1818) {
    const library = places.exists() ? places.load().places : {};
    const universeIds = placeOf(ctx).map((id) => library[id] && library[id].universeId).filter(Boolean);
    return send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, core.phpJson(await marketplace.assetInfo(assetId, universeIds)));
  }
  if (place) creators.fillMissing();
  send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, core.phpJson({
    TargetId: assetId, ProductType: 'User Product', AssetId: assetId, ProductId: 0,
    Name: place ? place.name : (assetId === 1818 ? 'Lumber Tycoon 2' : `Local Asset ${assetId}`),
    Description: place && place.description ? place.description : 'Served by the local game server.', AssetTypeId: 9,
    Creator: place ? placeCreator(place) : { Id: 1, Name: 'ROBLOX', CreatorType: 'User' },
    IconImageAssetId: 0, Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z', PriceInRobux: null,
    IsForSale: false, IsLimited: false, IsLimitedUnique: false, Remaining: null, MinimumMembershipLevel: 0, ContentRatingTypeId: 0,
  }));
}

// Developer product purchases (lib/marketplace.js): the client's purchase
// prompt pays and gets a receipt; the game server checks it before
// ProcessReceipt and reports it granted.
async function submitPurchase(ctx) {
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  const body = await ctx.body(FORM_LIMIT);
  sendJson(ctx, 200, await marketplace.submitPurchase(launcher.playerAt(ctx.remote), body));
}

// The universe IDs of the game(s) a request comes from (their game passes).
function universesOf(ctx) {
  const library = places.exists() ? places.load().places : {};
  return placeOf(ctx).map((id) => library[id] && library[id].universeId).filter(Boolean);
}

// Asset and game pass purchases (lib/marketplace.js): the buyer pays, and
// owns the item from then on (lib/ownership.js), which is what these answer:
// MarketplaceService:PlayerOwnsAsset (and UserOwnsGamePassAsync, through
// lib/luacompat.js) asks ownership/hasasset?userId=&assetId=, and
// GamePassService:PlayerHasPass asks GamePassHandler.ashx?Action=HasPass&UserID=&PassID=.
async function purchaseAsset(ctx) {
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  const body = await ctx.body(FORM_LIMIT);
  sendJson(ctx, 200, await marketplace.purchaseAsset(launcher.playerAt(ctx.remote), body, universesOf(ctx)));
}

// The purchase prompt's balance (currency/balance): the player's Robux. With
// no player known at the address, the prompt says it can't get the balance.
function currencyBalance(ctx) {
  const buyer = launcher.playerAt(ctx.remote);
  if (!buyer) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, '');
  sendJson(ctx, 200, { robux: robux.balance(buyer.userId), tickets: 0 });
}

// The prompt's "Buy R$" button opens BaseUrl/Upgrades/Robux.aspx in a
// browser window. Robux can't be bought, so this says how to earn it. Plain
// HTML for the 2017 client's own browser window.
function robuxPage(ctx) {
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const player = launcher.playerAt(ctx.remote);
  const r = robux.rules();
  const ways = [
    r.daily > 0 ? `R$ ${r.daily} each day you open the launcher or the website` : null,
    r.playAmount > 0 ? `R$ ${r.playAmount} for every ${r.playEvery} minutes in a game, up to R$ ${r.playDailyMax} a day` : null,
    r.badge > 0 ? `R$ ${r.badge} for each badge you earn` : null,
  ].filter(Boolean);
  const balanceLine = player ? `<p class="bal">${esc(player.name)}, you have <b>R$ ${robux.balance(player.userId)}</b>.</p>` : '';
  sendUtf8(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Get R$</title>
<style>body{margin:0;background:#f2f2f2;color:#191919;font-family:"Source Sans Pro",Arial,sans-serif}
.box{max-width:460px;margin:40px auto;background:#fff;border-radius:4px;padding:24px 28px;box-shadow:0 1px 4px rgba(0,0,0,.15)}
h1{margin:0 0 8px;font-size:26px;font-weight:400}p{font-size:16px;line-height:1.4}.bal{font-size:18px}
ul{padding-left:20px;font-size:16px;line-height:1.6}.note{color:#757575;font-size:14px}</style></head>
<body><div class="box"><h1>Get R$</h1>${balanceLine}
<p>R$ can't be bought here. You earn it by playing:</p>
<ul>${ways.map((way) => `<li>${esc(way)}</li>`).join('')}</ul>
<p class="note">Close this window to go back to the game.</p></div></body></html>`);
}

// A game awarded a badge for the first time: Robux, if the badge is one of
// the game's own (its Roblox universe's), so a script can't make up badges.
async function rewardBadge(userId, badgeId, placeId) {
  if (!accounts.byUserId(userId)) return;
  const place = places.exists() ? places.get(placeId) : null;
  if (!place || !place.universeId) return;
  const list = await marketplace.universeBadges(place.universeId);
  const badge = Array.isArray(list) ? list.find((entry) => String(entry.id) === String(Number(badgeId))) : null;
  if (badge && badge.enabled) robux.badgeEarned(userId, badge.name);
}

function hasAsset(ctx) {
  const owned = ownership.owns(ctx.queryLower.userid, ctx.queryLower.assetid);
  send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, owned ? 'true' : 'false');
}

function hasPass(ctx) {
  const owned = ownership.owns(ctx.queryLower.userid, ctx.queryLower.passid);
  send(ctx, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, `<Value Type="boolean">${owned}</Value>`);
}

// The 2018 engine's game pass and badge checks (UserOwnsGamePassAsync,
// UserHasBadgeAsync), in Roblox's inventory API form: one entry in "data"
// when the player has it. Its RCC and client ask api.<domain> here
// (tools/make-engine.py points their inventory.<domain> there).
function inventoryItem(ctx, match) {
  const badge = match[2].toLowerCase() === 'badge';
  const owned = badge ? require('./badges').has(match[1], match[3]) : ownership.owns(match[1], match[3]);
  sendJson(ctx, 200, {
    previousPageCursor: null,
    nextPageCursor: null,
    data: owned ? [{ type: badge ? 'Badge' : 'GamePass', id: Number(match[3]), name: '', instanceId: null }] : [],
  });
}

// The receipt calls are the game server's (players have paid for these).
function validatePurchase(ctx) {
  if (!fromGameServer(ctx.remote)) return sendJson(ctx, 403, { error: 'Only game servers can check receipts.' });
  sendJson(ctx, 200, marketplace.validatePurchase(ctx.queryLower.receipt));
}

function pendingPurchases(ctx) {
  if (!fromGameServer(ctx.remote)) return sendJson(ctx, 403, { error: 'Only game servers can list receipts.' });
  sendJson(ctx, 200, marketplace.pendingPurchases(ctx.queryLower.placeid, ctx.queryLower.playerid));
}

async function completePurchase(ctx) {
  if (!fromGameServer(ctx.remote)) return sendJson(ctx, 403, { error: 'Only game servers can complete receipts.' });
  sendJson(ctx, 200, marketplace.completePurchase(await ctx.body(FORM_LIMIT)));
}

// www/game/LuaWebService/HandleSocialRequest.php (the .ashx URL maps here).
// RCC only reaches this with patch-rcc-http-urls.ps1 applied (hosting.js
// does that); the client reaches it as it is. Answers: lib/social.js.
async function socialRequest(ctx) {
  const { contentType, body } = await social.answer(ctx.query.method, ctx.queryLower);
  send(ctx, 200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }, body);
}

// Thumbnail images (see lib/thumbs.js). Query names vary by era.
function thumbnailRoute(kind) {
  return async (ctx) => {
    const q = ctx.queryLower;
    const pick = (...names) => { for (const name of names) if (q[name] !== undefined && q[name] !== '') return String(q[name]); return undefined; };
    const names = kind === 'asset' ? ['aid', 'assetid', 'id'] : kind === 'bundle' ? ['bundleid', 'id'] : ['userid', 'id'];
    const raw = pick(...names) || '';
    // Players of this server: their picture is the one the launcher saved
    // with their avatar (guests and new players get the default figure).
    if (kind === 'avatar' || kind === 'headshot') {
      const local = avatarStore.imageFor(raw);
      if (local) return send(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }, local);
      // An account here has no Roblox picture under its user ID.
      if (avatarStore.isGuestId(raw) || accounts.byUserId(raw)) return fail(ctx, 404, 'No picture saved for this player yet');
    }
    // The Xbox app's game tiles: a game's picture is asset -<placeId> (lib/xbox.js).
    if (kind === 'asset' && /^-\d{1,15}$/.test(raw.trim())) {
      const found = gamethumbs.get(raw.trim().slice(1));
      if (!found) return fail(ctx, 404, 'This game has no picture');
      return sendFile(ctx, found.file, { 'Content-Type': found.type, 'Cache-Control': 'no-cache' });
    }
    let id = core.decimal(raw);
    if (id === null || id === '0' || id.length > 15) return fail(ctx, 400, 'Invalid id');
    // A game pass ID (the purchase prompt shows the ID's asset thumbnail): its icon.
    if (kind === 'asset') id = marketplace.passIcon(id) || id;
    const width = parseInt(pick('wd', 'width', 'x', 'w') || '', 10) || 0;
    const height = parseInt(pick('ht', 'height', 'y', 'h') || '', 10) || width;
    const result = await thumbs.thumbnail(kind, id, width, height);
    if (!result.ok) return fail(ctx, 404, result.message);
    send(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }, result.bytes);
  };
}

// LuaWebService (IsInGroup, GetRankInGroup, GetRoleInGroup, IsFriendsWith):
// RCC asks https://assetgame.<domain>/ + SocialService*Url, a relative path
// that must stay at RCC's default (a full address here only produced
// "https://assetgame.localhost./http://..."). The https:// and RCC's trust
// check are handled by patch-rcc-http-urls.ps1, not by settings.
const RCC_STRINGS = {
  // Chat filter: RCC posts to <subdomain>.<domain>/moderation/v2/filtertext,
  // "textfilter" by default, which no hosts file here lists ("Couldn't
  // resolve host name", messages shown as ____). www.localhost is listed on
  // every hosting PC by addHostsEntries.bat.
  FilterTextSubdomain: 'www',
};

// The client's flags (Setting/QuietGet/ClientAppSettings): the 2017 (0.299)
// set, the same as Client/ClientSettings/ClientAppSettings.json. Only flags
// this build knows; everything else stays at the build's own 2017 value.
// - DebugLocalRccServerConnection: without it joining fails with "ROBLOX
//   version is out of date".
// - SoundServiceGameConfigurerConfigureRunServiceRun: after joining, the
//   client sets RunService running. Every Sound:Play() checks for that, so
//   without it the whole game is silent.
// - The player-script flags must match RCC's (Server/ClientSettings), or
//   characters get no sounds (Sound.server.lua / Sound/LocalSound.client.lua)
//   and a wrong camera.
const CLIENT_APP_SETTINGS = {
  FFlagDebugLocalRccServerConnection: true,
  FFlagSoundServiceGameConfigurerConfigureRunServiceRun: true,
  FFlagLoadPlayerScriptsFromLua: true,
  FFlagNewNamingForPlayerScripts: true,
  FFlagUseLuaCameraAndControl: true,
  FFlagServerNotifyPlayerScriptsStatus: true,
  FFlagPlayerAcceptPlayerScriptsStatus: true,
};

// Features this 2017 build already has but keeps switched off, which newer
// games use: CollectionService tags (AddTag/HasTag/GetTagged), TweenService,
// FindFirstChildWhichIsA and friends, mouse queries (GetMouseLocation...),
// BindActionAtPriority, raycast/region whitelists, AnimationTrack.Looped,
// UITableLayout, BuildRigFromAttachments, collision groups (PhysicsService),
// and the features listed with them below.
// Without them scripts stop with
// "... is not enabled yet". RCC gets them here; the 2017 client reads only
// its own Client/ClientSettings/ClientAppSettings.json, which has the same
// list (game files). Each is sent as FFlag and DFFlag, as the build reads
// one or the other.
const FEATURE_FLAGS = [
  'InstanceTaggingEnabled', 'GenericTweensEnabled', 'InstanceNavigationAdditionsEnabled', 'MouseInputQueryMethodsEnabled',
  'EnableContextActionPriority', 'Region3WhitelistEnabled', 'AnimationTrackHasLoopApi', 'TableLayoutEnabled',
  'BuildRigFromAttachmentsApiEnabled', 'EnableCollisionGroups',
  // Also off in this build, though games of 2018 on use them: WeldConstraint
  // (Jailbreak holds a driver in the seat with one), Trails, particles,
  // lights and sounds in attachments, attachments as BillboardGui adornees,
  // ParticleEmitter.SpreadAngle, BillboardGui.MaxDistance, UIPadding,
  // UIScale, grid cell size constraints, image tiling, Motor6D.Transform,
  // Humanoid health display, CFrame.RightVector/UpVector and more math.
  'EnableWeldConstraint', 'CFrameRightAndUpVectors', 'AddMoreMathAPI', 'EnableTrailEffect',
  'EnableParticleEmittersInAttachments', 'EnableLightObjectsInAttachments', 'EnableSoundsInAttachments', 'EnableAttachmentsAsBillboardGuiAdornee',
  'EnableParticleSpreadAngle', 'BillboardGuiMaxDistance', 'PaddingComponentEnabled', 'UIScaleComponentEnabled',
  'GridLayoutCellSizeConstraints', 'SizeFromContentsEnabled', 'EnableImageTilingInGUI', 'Motor6DTransformPropEnabled',
  'HumanoidHealthDisplayTypeEnabled',
  // GroupService:GetGroupsAsync (this server's groups, lib/groupapi.js).
  'GetGroupsAsyncEnabled',
  // Not EmojiEnabled2: it turns emoji on, but the sheets in
  // content/textures/emoji are from a 2018 build and draw the wrong slices.
];
for (const name of FEATURE_FLAGS) {
  CLIENT_APP_SETTINGS[`FFlag${name}`] = true;
  CLIENT_APP_SETTINGS[`DFFlag${name}`] = true;
}

function clientAppSettings(ctx) {
  send(ctx, 200, jsonNoStore, JSON.stringify(CLIENT_APP_SETTINGS));
}

// www/Setting/QuietGet/RCCServiceRCCService/index.php
function rccSettings(ctx) {
  const settings = {
    FFlagDebugLocalRccServerConnection: true,
    FFlagRCCDisableArbitraryScriptExecution: true,
    DFFlagRCCDisableArbitraryScriptExecution: true,
    FFlagRCCDisableUrlExecution: false,
    DFFlagRCCDisableUrlExecution: false,
    FFlagRCCUseBundledMonitoringScript: true,
    DFFlagRCCUseBundledMonitoringScript: true,
    DFIntRCCNonJsonExecuteInfluxHundrethsPercentage: 0,
    DFIntRCCUrlExecuteInfluxHundrethsPercentage: 0,
    DFIntGameServerInitializationErrorInfluxHundrethsPercentage: 0,
    // Team Create: RCC as a cloud edit server (gameserver.lua, matchmaking context 3).
    FFlagRCCSupportCloudEdit: true,
    DFFlagRCCSupportCloudEdit: true,
    // Joining sends the map's terrain at no more than this (40 KB/s by
    // default): most of a Jailbreak join's minute. 1000 took it from 57 s to
    // a few seconds on this PC; it is per player, so the server's upload
    // still has room for several joining at once.
    FIntMaxClusterKBPerSecond: 1000,
    DFIntMaxClusterKBPerSecond: 1000,
  };
  for (const name of FEATURE_FLAGS) {
    settings[`FFlag${name}`] = true;
    settings[`DFFlag${name}`] = true;
  }
  // RCC reads each as FString (at startup) or DFString (live); send both.
  for (const [name, value] of Object.entries(RCC_STRINGS)) {
    settings[`FString${name}`] = value;
    settings[`DFString${name}`] = value;
  }
  send(ctx, 200, jsonNoStore, core.phpJson(settings));
}

// www/device/initialize/index.php: answer its literal. Studio 2017 posts
// here for a browser tracker ID (mobileDeviceId=...). The PHP page saved the
// body into the web root as post.txt; nothing read it, so it is not kept.
async function deviceInitialize(ctx) {
  const directory = path.join(core.WWW, 'device', 'initialize');
  await ctx.body(FORM_LIMIT);
  const segments = www.phpSegments(fs.readFileSync(path.join(directory, 'index.php')).toString('latin1'));
  const literal = segments.filter((segment) => segment.literal).map((segment) => segment.text).join('');
  send(ctx, 200, { 'Content-Type': 'text/html' }, literal);
}

// www/v1.1/game-start-info/index.php: pass Roblox's answer through.
async function gameStartInfo(ctx) {
  const universeId = ctx.query.universeId !== undefined ? ctx.query.universeId : '';
  const response = await assets.httpRequest(`https://avatar.roblox.com/v1/game-start-info?universeId=${encodeURIComponent(universeId)}`, {}, 15000);
  send(ctx, 200, { 'Content-Type': 'text/plain' }, response.status > 0 ? response.body : '');
}

// --- Multiplayer game list (/api/games) -----------------------------------------
// GET  /api/games                    the online games (public)
// POST /api/games/register           {key, name, placeId, address} -> {id}
// POST /api/games/<id>/heartbeat     {key}   keep the game listed
// POST /api/games/<id>/close         {key}   remove it
// The key may also be sent as an X-Host-Key header.

function sendJson(ctx, status, value) {
  // Players coming through the VPS relay get its name in game addresses (lib/publicnet.js).
  if (ctx.publicHost) value = publicnet.rewriteAddresses(ctx, value);
  sendUtf8(ctx, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(value));
}

async function jsonBody(ctx, limit = JSON_LIMIT) {
  const text = (await ctx.body(limit)).toString('utf8');
  try {
    const value = JSON.parse(text || '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    return {};
  }
}

async function gamesApi(ctx, match) {
  const id = match[1] ? match[1].toLowerCase() : null;
  const action = match[2] ? match[2].toLowerCase() : null;
  if (id === null && action === null) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return sendJson(ctx, 405, { error: 'use GET' });
    // Library places show their library name and description (renames apply
    // at once, without restarting the game).
    const library = places.exists() ? places.load().places : {};
    creators.fillMissing();
    // Players in each game, from the always-on server's last check (null:
    // not known, e.g. a game hosted from another PC).
    const runner = places.runnerStatus();
    const running = runner && !runner.stale && runner.servers ? runner.servers : {};
    const list = games.list().map((game) => {
      const place = library[game.placeId];
      const creator = place ? places.creatorOf(place) : null;
      const status = running[game.id];
      return Object.assign(game, place ? { name: place.name, description: place.description || '' } : {}, {
        creator: creator ? creator.name : '',
        playing: status && Array.isArray(status.players) ? status.players.length : null,
        thumbnail: gamethumbs.version(game.placeId),
      });
    });
    return sendJson(ctx, 200, { games: list });
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  const wrongKey = () => sendJson(ctx, 403, { error: 'wrong or missing host key (config/host-key.txt on the web server)' });
  const headerKey = ctx.req.headers['x-host-key'];
  if (headerKey !== undefined && !games.checkHostKey(String(headerKey))) return wrongKey();
  const body = await jsonBody(ctx);
  const key = headerKey !== undefined ? String(headerKey) : body.key;
  if (!games.checkHostKey(key)) return wrongKey();

  if (id === 'register' && action === null) {
    const result = games.register(body, ctx.remote);
    if (result.error) return sendJson(ctx, 400, { error: result.error });
    return sendJson(ctx, 200, { id: result.game.id, heartbeatSeconds: games.HEARTBEAT_SECONDS });
  }
  if (action === 'heartbeat') {
    return games.heartbeat(id) ? sendJson(ctx, 200, { ok: true }) : sendJson(ctx, 404, { error: 'unknown game; register again' });
  }
  if (action === 'close') {
    games.close(id);
    return sendJson(ctx, 200, { ok: true });
  }
  return sendJson(ctx, 404, { error: 'unknown games API call' });
}

// --- Place library (lib/places.js) and the /manage page ----------------------------
//   GET    /api/places                        library + what the always-on server runs
//   POST   /api/places?name=&description=&fromPlace=&universeId=&enabled=1
//                                            body: a .rbxlx or .rbxl; converted, given the next place ID
//   POST   /api/places/<id>/file?fromPlace=   new file for a place (same ID)
//   POST   /api/places/<id>                   JSON {name, description, enabled, universeId}
//   POST   /api/places/<id>/restart           ask the always-on server to restart its servers
//   POST   /api/places/<id>/reconvert         run the stored file through the converter again (a new version)
//   POST   /api/places/<id>/restore-values?name=   body: the original file; IntValues left at 0 by
//                                            older converters filled from it (a new version)
//   POST   /api/places/<id>/servers/<job ID>/restart | stop    one server (players saved first)
//   DELETE /api/private-servers/<id>          remove a private server (its server stops)
//   DELETE /api/places/<id>                   remove (saves, thumbnail and ID stay reserved)
//   GET    /api/places/<id>/versions          the replaced versions kept in places/old
//   POST   /api/places/<id>/versions/<file>/restore   make one of them current again (a new version)
// Changes need the host key (X-Host-Key).

// A new version that cannot go in yet (lib/places.js replaceFile waited a
// minute for a starting server of the game to finish reading the old one).
const PLACE_FILE_BUSY = 'A server of this game is still loading the current version, so it cannot be replaced yet. Try again in a minute.';

// Fields of a library place only admins see.
const ADMIN_PLACE_FIELDS = ['file', 'uploadedFrom', 'notes'];
function forViewer(place, isAdmin) {
  if (!isAdmin) for (const field of ADMIN_PLACE_FIELDS) delete place[field];
  return place;
}

function placesWithStatus(isAdmin) {
  const runner = places.runnerStatus();
  const up = runner && !runner.stale;
  const running = up && runner.games ? runner.games : {};
  const servers = up && runner.servers ? Object.values(runner.servers) : [];
  const privates = isAdmin ? privateservers.list() : [];
  const ownerName = (userId) => { const found = accounts.byUserId(userId); return found ? found.name : `User ${userId}`; };
  const privateName = (id) => { const found = privates.find((server) => server.id === id); return found ? `${found.name} (${ownerName(found.ownerId)})` : 'a private server'; };
  creators.fillMissing();
  return {
    places: places.list().map((place) => Object.assign(forViewer(place, isAdmin), {
      thumbnail: gamethumbs.version(place.placeId),
      status: running[place.placeId] || null,
      // Each running server: job ID, players, state; private ones say whose.
      servers: servers.filter((server) => String(server.placeId) === String(place.placeId))
        .map((server) => Object.assign({}, server, { privateName: server.privateId ? (isAdmin ? privateName(server.privateId) : 'a private server') : null })),
      privateServers: privates.filter((server) => server.placeId === String(place.placeId))
        .map((server) => ({ id: server.id, name: server.name, owner: ownerName(server.ownerId), members: server.members.length, friends: server.friends, createdAt: server.createdAt })),
      cloudEdit: up && runner.cloudEdit ? runner.cloudEdit[place.placeId] || null : null,
    })),
    runner: runner ? { running: !runner.stale, updatedAt: runner.updatedAt, maxGames: runner.maxGames, idleStopMinutes: runner.idleStopMinutes, problems: runner.problems || [] } : { running: false },
    // This PC's Tailscale address (players now come through the VPS relay instead).
    server: { tailscaleUrl: core.tailscaleIPv4() ? `http://${core.tailscaleIPv4()}` : null },
    // The Roblox versions a game can be set to (lib/engines.js), and whether
    // this server has each one's game server.
    engines: engines.list(),
  };
}

// Earlier versions of a place's file (lib/places.js oldVersions): list, or
// restore one. Restoring stores it as a new version, so the current one
// joins the list instead of being lost, and the restored one leaves it.
// Stored files are already converted.
async function placeVersionsApi(ctx, match) {
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  const placeId = match[1];
  const versionId = match[2] || null;
  const current = places.get(placeId);
  if (!current) return sendJson(ctx, 404, { error: 'no such place' });
  if (versionId === null) {
    if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
    return sendJson(ctx, 200, { versions: places.oldVersions(placeId) });
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  const version = places.oldVersions(placeId).find((item) => item.id === versionId);
  const bytes = version ? places.oldVersionBytes(placeId, versionId) : null;
  if (!bytes) return sendJson(ctx, 404, { error: 'That version is no longer kept.' });
  const notes = [`Restored the version saved ${version.savedAt.replace('T', ' ').replace(/\..*$/, '')} UTC.`];
  let place;
  try {
    place = await places.replaceFile(placeId, { bytes, notes, universeId: current.universeId, from: 'restored', source: 'restored' });
  } catch (error) {
    if (error.busy) return sendJson(ctx, 409, { error: PLACE_FILE_BUSY });
    throw error;
  }
  // Now the current file (the one it replaced took its place in the list).
  places.removeOldVersion(placeId, versionId, version.savedAt);
  return sendJson(ctx, 200, { place, notes, versions: places.oldVersions(placeId) });
}

// An uploaded place file -> { bytes } or { error }.
async function placeUpload(ctx) {
  const declared = Number(ctx.req.headers['content-length']);
  const bytes = await ctx.body(PLACE_UPLOAD_LIMIT);
  if (bytes.length === 0) return { error: 'no place file was sent' };
  if (Number.isFinite(declared) && declared !== bytes.length) return { error: 'the upload was cut short' };
  return { bytes };
}

// The uploaded place, converted for the 2017 engine -> { bytes, notes, universeId } or { error }.
async function convertUpload(ctx, query) {
  const upload = await placeUpload(ctx);
  if (upload.error) return upload;
  const { bytes } = upload;
  let universeId = places.placeKey(query.universeid);
  if (universeId === null && places.placeKey(query.fromplace)) {
    universeId = await placefile.universeForPlace(places.placeKey(query.fromplace));
    if (universeId === null) return { error: `could not find the universe of Roblox place ${query.fromplace}` };
  }
  try {
    return Object.assign(await convertPlaceFile(bytes, universeId), { universeId });
  } catch (error) {
    return { error: error.message };
  }
}

// A place file (XML, or binary read into XML: lib/rbxbinary.js) through the
// converter -> { bytes, notes }; bytes are what the server stores (binary).
async function convertPlaceFile(bytes, universeId) {
  const input = rbxbinary.placeXml(bytes);
  const result = placefile.convertPlace(input.xml, { universeId, unionShapes: await unionShapes(input.xml) });
  const stored = rbxbinary.placeToStore(result.output);
  return { bytes: stored.bytes, notes: [...input.notes, ...result.summary, ...stored.notes] };
}

// A model (Studio's Toolbox inserts it) through the same converter -> its XML,
// which 2017 Studio reads.
async function convertModelFile(bytes) {
  const input = rbxbinary.placeXml(bytes);
  return placefile.convertPlace(input.xml, { unionShapes: await unionShapes(input.xml) }).output;
}

// Collision shapes for a place's unions, made from their meshes (lib/unionshapes.js),
// which come like any asset (cache, then Roblox). Unions without one keep the
// converter's old rule.
async function unionShapes(bytes) {
  try {
    return await unionshapes.buildShapes(placefile.unionsNeedingShapes(bytes), assetBytes);
  } catch (error) {
    return new Map();
  }
}

async function placesApi(ctx, match) {
  const placeId = match[1] || null;
  const action = match[2] ? match[2].toLowerCase() : null;
  const query = ctx.queryLower;
  if ((ctx.method === 'GET' || ctx.method === 'HEAD') && placeId === null) return sendJson(ctx, 200, placesWithStatus(admin.allowed(ctx)));
  if (ctx.method === 'GET' && placeId !== null && action === null) {
    const place = places.get(placeId);
    return place ? sendJson(ctx, 200, { place: forViewer(place, admin.allowed(ctx)) }) : sendJson(ctx, 404, { error: 'no such place' });
  }
  if (ctx.method !== 'POST' && ctx.method !== 'DELETE') return sendJson(ctx, 405, { error: 'use GET, POST or DELETE' });
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  const from = ctx.remote;

  if (placeId === null) {
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST to upload' });
    const converted = await convertUpload(ctx, query);
    if (converted.error) return sendJson(ctx, 400, { error: converted.error });
    const place = places.create({
      name: query.name, description: query.description, universeId: converted.universeId,
      enabled: query.enabled === '1' || query.enabled === 'true', bytes: converted.bytes, notes: converted.notes, from,
    });
    return sendJson(ctx, 200, { place, notes: converted.notes });
  }
  if (!places.get(placeId)) return sendJson(ctx, 404, { error: 'no such place' });
  if (ctx.method === 'DELETE' && action === null) {
    places.remove(placeId);
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === 'file') {
    const converted = await convertUpload(ctx, query);
    if (converted.error) return sendJson(ctx, 400, { error: converted.error });
    let place;
    try {
      place = await places.replaceFile(placeId, { bytes: converted.bytes, notes: converted.notes, universeId: converted.universeId, from });
    } catch (error) {
      if (error.busy) return sendJson(ctx, 409, { error: PLACE_FILE_BUSY });
      throw error;
    }
    return sendJson(ctx, 200, { place, notes: converted.notes });
  }
  if (action === 'restart') {
    places.requestRestart(placeId);
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === 'reconvert') {
    // The stored file through the current converter again (it learns new
    // fixes over time): a new version, the old one kept in places/old.
    const current = places.get(placeId);
    let result;
    try {
      result = await convertPlaceFile(fs.readFileSync(places.filePath(current)), current.universeId || null);
    } catch (error) {
      return sendJson(ctx, 400, { error: `could not convert the place again: ${error.message}` });
    }
    let place;
    try {
      place = await places.replaceFile(placeId, { bytes: result.bytes, notes: result.notes, universeId: current.universeId, from: 'converted again' });
    } catch (error) {
      if (error.busy) return sendJson(ctx, 409, { error: PLACE_FILE_BUSY });
      throw error;
    }
    return sendJson(ctx, 200, { place, notes: result.notes });
  }
  if (action === 'restore-values') {
    // IntValues older converters left at 0 (they dropped int64 values),
    // filled from the original file; nothing else changes. A new version
    // when any is filled, the old one kept in places/old.
    const upload = await placeUpload(ctx);
    if (upload.error) return sendJson(ctx, 400, { error: upload.error });
    const current = places.get(placeId);
    let result;
    try {
      result = restorevalues.restoreValues(fs.readFileSync(places.filePath(current)), upload.bytes);
    } catch (error) {
      return sendJson(ctx, 400, { error: `could not read the place files: ${error.message}` });
    }
    const lists = { restored: result.restored, stillZero: result.stillZero, otherInt64: result.otherInt64 };
    if (result.restored.length === 0) return sendJson(ctx, 200, Object.assign({ place: current, notes: [] }, lists));
    const fileName = String(query.name || 'the original file').replace(/[\x00-\x1f]/g, '').slice(0, 100);
    const notes = [...restorevalues.summary(result, fileName), ...result.notes, ...current.notes];
    let place;
    try {
      place = await places.replaceFile(placeId, { bytes: result.bytes, notes, universeId: current.universeId, from: 'numbers fixed' });
    } catch (error) {
      if (error.busy) return sendJson(ctx, 409, { error: PLACE_FILE_BUSY });
      throw error;
    }
    return sendJson(ctx, 200, Object.assign({ place, notes }, lists));
  }
  if (action === null) {
    const body = await jsonBody(ctx);
    const place = places.update(placeId, {
      name: body.name, description: body.description, enabled: body.enabled, universeId: body.universeId,
      teamCreate: body.teamCreate, creator: body.creator, keepRunning: body.keepRunning, maxPlayers: body.maxPlayers,
      avatarType: body.avatarType, allowGear: body.allowGear, engine: body.engine,
    });
    return sendJson(ctx, 200, { place });
  }
  return sendJson(ctx, 404, { error: 'unknown places API call' });
}

// One server of a place (/manage): restart it, or save its players and stop it.
async function placeServerApi(ctx, match) {
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  if (!places.get(match[1])) return sendJson(ctx, 404, { error: 'no such place' });
  if (match[3].toLowerCase() === 'restart') places.requestRestart(match[1], match[2].toLowerCase());
  else places.requestStopServer(match[1], match[2].toLowerCase());
  return sendJson(ctx, 200, { ok: true });
}

async function privateServerAdminApi(ctx, match) {
  if (ctx.method !== 'DELETE') return sendJson(ctx, 405, { error: 'use DELETE' });
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  const result = privateservers.remove(match[1].toLowerCase());
  return result.error ? sendJson(ctx, 404, { error: result.error }) : sendJson(ctx, 200, { ok: true });
}

// Missing assets and their replacements (lib/missingassets.js), for /manage.
//   GET    /api/assets/missing                  list (names are looked up in the background)
//   POST   /api/assets/<id>/replacement          body: the file; X-Host-Key
//   DELETE /api/assets/<id>/replacement          X-Host-Key
async function assetsApi(ctx, match) {
  if (match[1] === undefined) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return sendJson(ctx, 405, { error: 'use GET' });
    if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
    const list = missingassets.list();
    missingassets.lookUpNames(list.map((entry) => entry.id)).catch(() => {});
    return sendJson(ctx, 200, { assets: list });
  }
  if (ctx.method !== 'POST' && ctx.method !== 'DELETE') return sendJson(ctx, 405, { error: 'use POST or DELETE' });
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  const id = match[1];
  if (ctx.method === 'DELETE') return sendJson(ctx, 200, { ok: missingassets.removeReplacement(id) });
  const declared = Number(ctx.req.headers['content-length']);
  const bytes = await ctx.body(missingassets.MAX_BYTES);
  if (Number.isFinite(declared) && declared !== bytes.length) return sendJson(ctx, 400, { error: 'the upload was cut short' });
  const result = missingassets.saveReplacement(id, bytes);
  return result.error ? sendJson(ctx, 400, result) : sendJson(ctx, 200, Object.assign({ ok: true }, result));
}

// Game files for the downloader installer: the launcher from the small
// Setup.exe downloads the client from here on first run (and offers updates
// when the version changes). Built by tools/build-client-files.py into
// RobloxClient/downloads/: <name>.json (the list), <name>.tar.zst (all
// files), <name>-from-<version>.tar.zst (only what changed since an older
// version) and <name>.zip (for launchers before 1.7.2); client-files-2016 is
// the 2016 client (lib/engines.js). Packages resume
// where a dropped download stopped (Range).
function downloadType(name) {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  return name.endsWith('.zip') ? 'application/zip' : 'application/zstd';
}
function downloadsRoute(ctx, match) {
  const name = match[1].toLowerCase();
  const file = core.rootPath('downloads', name);
  if (!core.isFile(file)) {
    // client-files-2016...: another year's client (lib/engines.js).
    const year = (/^client-files-(\d{4})/.exec(name) || [])[1];
    return sendJson(ctx, 404, { error: name.startsWith('studio')
      ? 'this server has no Studio to hand out (run tools/build-client-files.py studio on the PC that has it)'
      : year ? `this server has no ${year} game files to hand out (run tools/build-client-files.py client${year} on it)`
        : 'this server has no game files to hand out (run tools/build-client-files.py on it)' });
  }
  if (name.endsWith('.json')) return sendFile(ctx, file, { 'Content-Type': downloadType(name), 'Cache-Control': 'no-cache' });
  const stat = fs.statSync(file);
  ctx.ranges = true;
  sendFile(ctx, file, {
    'Content-Type': downloadType(name),
    'Cache-Control': 'public, max-age=3600',
    ETag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
  });
}

// The ROBLOX logo for launchers (Launcher/renderer/roblox-logo*.png on this
// PC): the public launcher download leaves Roblox's art out, so launchers
// fetch it from their server, like the menu music.
function launcherLogoRoute(ctx, match) {
  const file = core.rootPath('Launcher', 'renderer', match[1].toLowerCase());
  if (!core.isFile(file)) return sendJson(ctx, 404, { error: 'this server has no launcher logo' });
  sendFile(ctx, file, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
}

// The host's menu music (config/menu-music.mp3 on this PC): launchers
// download it into their own config folder, so every player hears it.
function menuMusicRoute(ctx) {
  const file = core.rootPath('config', 'menu-music.mp3');
  if (!core.isFile(file)) return sendJson(ctx, 404, { error: 'this server has no menu music' });
  const stat = fs.statSync(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (ctx.req.headers['if-none-match'] === etag) return send(ctx, 304, { ETag: etag, 'Cache-Control': 'no-cache' }, '');
  sendFile(ctx, file, { 'Content-Type': 'audio/mpeg', ETag: etag, 'Cache-Control': 'no-cache' });
}

// Announcements to every launcher (lib/announcements.js), for /manage.
//   GET    /api/announcements                 the current ones
//   POST   /api/announcements                 JSON {title, text, level, expiresHours}; X-Host-Key
//   DELETE /api/announcements/<id>            X-Host-Key
async function announcementsApi(ctx, match) {
  if ((ctx.method === 'GET' || ctx.method === 'HEAD') && !match[1]) return sendJson(ctx, 200, { announcements: announcements.list() });
  if (ctx.method !== (match[1] ? 'DELETE' : 'POST')) return sendJson(ctx, 405, { error: match[1] ? 'use DELETE' : 'use GET or POST' });
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  if (match[1]) {
    return announcements.remove(match[1].toLowerCase()) ? sendJson(ctx, 200, { ok: true }) : sendJson(ctx, 404, { error: 'no such announcement' });
  }
  const body = await jsonBody(ctx);
  try {
    return sendJson(ctx, 200, { announcement: announcements.post(body || {}) });
  } catch (error) {
    return sendJson(ctx, 400, { error: error.message });
  }
}

// Player reports (lib/reports.js). The game server posts the in-game Report
// menu's reports here as XML (Server/gameserver.lua sets this address with
// Players:SetAbuseReportUrl):
//   <report userID placeID gameJobID><comment>AbuserID:<id>;<reason>;<text></comment>
//     <messages><message userID guid>chat</message>...</messages></report>
// AbuserID 0 is a report on the game; its text is "User Report: ... Place Title: ...".
//   POST   /AbuseReport/InGameChatHandler.ashx   game servers only (fromGameServer)
//   GET    /api/reports                          -> { reports, open }; host key or manage token
//   POST   /api/reports/<id>/resolve
//   DELETE /api/reports/<id>

function xmlUnescape(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (all, hex, dec, name) => {
    if (name) return named[name.toLowerCase()];
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

function xmlAttributes(text) {
  const found = Object.create(null);
  for (const match of String(text).matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    found[match[1].toLowerCase()] = xmlUnescape(match[2] !== undefined ? match[2] : match[3]);
  }
  return found;
}

// The report's fields, or null when the body is not a report.
function parseAbuseReport(xml) {
  const root = /<report\b([^>]*)>/i.exec(xml);
  if (!root) return null;
  const attributes = xmlAttributes(root[1]);
  const child = (name) => {
    const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
    return match ? xmlUnescape(match[1]).trim() : '';
  };
  const field = (name) => (attributes[name.toLowerCase()] !== undefined ? attributes[name.toLowerCase()] : child(name));
  const comment = child('comment');
  const parts = /^AbuserID:\s*(-?\d+)\s*;([^;]*);?([\s\S]*)$/i.exec(comment);
  let text = parts ? parts[3] : comment;
  // A report on the game carries the place's details after the player's words.
  const gameReport = /^\s*User Report:\s*([\s\S]*?)\s*Place Title:/i.exec(text);
  if (gameReport) text = gameReport[1];
  // The text box's placeholder, sent when nothing was typed.
  if (/^(?:Short Description\s*)?\(Optional\)$/i.test(text.trim())) text = '';
  const names = new Map();
  const nameOf = (id) => {
    if (!names.has(id)) names.set(id, reports.nameOf(id));
    return names.get(id);
  };
  const messages = [];
  for (const match of xml.matchAll(/<message\b([^>]*?)(?:\/>|>([\s\S]*?)<\/message>)/gi)) {
    const line = xmlUnescape(match[2] || '').trim();
    if (!line) continue;
    const from = nameOf(xmlAttributes(match[1]).userid);
    messages.push(from ? `${from}: ${line}` : line);
  }
  return {
    reporterId: field('userID'),
    reportedId: parts ? parts[1] : null,
    reason: parts ? parts[2] : '',
    text,
    placeId: field('placeID'),
    jobId: field('gameJobID'),
    messages,
  };
}

const sameAddress = (a, b) => String(a || '').replace(/^::ffff:/i, '').toLowerCase() === String(b || '').replace(/^::ffff:/i, '').toLowerCase();

// RCC on this PC (loopback, or one of this PC's own addresses), or on a PC a
// game was registered from (listed, or in the last few minutes; see
// games.hostedFrom): that PC's RCC reaches this server through its launcher
// proxy, so the request comes from the same address.
function fromGameServer(remote) {
  const address = String(remote || '').replace(/^::ffff:/i, '');
  if (address === '::1' || /^127\./.test(address)) return true;
  const own = Object.values(os.networkInterfaces()).some((list) => (list || []).some((item) => sameAddress(item.address, address)));
  return own || games.hostedFrom(address);
}

async function abuseReport(ctx) {
  const textHeaders = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  if (ctx.method !== 'POST') return send(ctx, 405, textHeaders, 'use POST');
  if (!fromGameServer(ctx.remote)) return send(ctx, 403, textHeaders, 'Only game servers can send reports here.');
  let body = await ctx.body(ABUSE_REPORT_LIMIT);
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try { body = zlib.gunzipSync(body, { maxOutputLength: 16 * reports.MAX_BODY }); } catch (error) { body = body.subarray(0, 0); }
  }
  const fields = parseAbuseReport(body.subarray(0, reports.MAX_BODY).toString('utf8'));
  if (!fields) return send(ctx, 400, textHeaders, 'not a report');
  // RCC sends no job ID here; a single listed server of the place from that PC is the one.
  if (!fields.jobId) {
    const servers = games.listAll().filter((listed) => listed.placeId === String(fields.placeId)
      && sameAddress((games.get(listed.id) || {}).registeredFrom, ctx.remote));
    if (servers.length === 1) fields.jobId = servers[0].id;
  }
  try {
    reports.add(Object.assign({ source: 'game' }, fields));
  } catch (error) {
    return send(ctx, error.status || 400, textHeaders, error.message);
  }
  return send(ctx, 200, textHeaders, '');
}

async function reportsApi(ctx, match) {
  const id = match[1] ? match[1].toLowerCase() : null;
  const action = match[2] ? match[2].toLowerCase() : null;
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  if (id === null) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return sendJson(ctx, 405, { error: 'use GET' });
    const list = reports.list();
    return sendJson(ctx, 200, { reports: list, open: list.filter((item) => item.status === 'open').length });
  }
  if (action === 'resolve') {
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
    const found = admin.who(ctx);
    const report = reports.resolve(id, found && found.name ? found.name : 'Host key');
    return report ? sendJson(ctx, 200, { report }) : sendJson(ctx, 404, { error: 'no such report' });
  }
  if (ctx.method !== 'DELETE') return sendJson(ctx, 405, { error: 'use DELETE' });
  return reports.remove(id) ? sendJson(ctx, 200, { ok: true }) : sendJson(ctx, 404, { error: 'no such report' });
}

// The always-on server itself (dedicated.js), for /manage: updates
// (lib/updates.js), restarting the whole server and reading its logs.
//   GET  /api/server/status                  versions, waiting updates, the last result
//   POST /api/server/update/check            look for a newer update on GitHub now
//   POST /api/server/update/install          install the waiting update(s) now
//   POST /api/server/update/upload           body: an .rbxupd file (checked and set to wait)
//   POST /api/server/update/discard?build=   drop a waiting (or failed) update
//   POST /api/server/restart                 restart the whole server (players saved first)
//   GET  /api/server/logs?name=&lines=       the end of a log: server, web, studio, update
//   GET  /api/server/moved                   where launchers are sent (config/moved.json)
//   POST /api/server/moved                   {to: "https://..."} sends them there; {to: null} stops
// All but status need the host key (X-Host-Key).
const SERVER_LOGS = {
  server: ['Webserver', 'node', 'logs', 'dedicated.log'],
  web: ['Webserver', 'node', 'logs', 'server.log'],
  studio: ['Webserver', 'node', 'logs', 'studio.log'],
  update: ['updates', 'update.log'],
  // Every web request (who asked for what, the answer's status): for tracing
  // what the game client and RCC ask this server.
  access: ['Webserver', 'node', 'logs', 'access.log'],
};

// The last `lines` lines of a text file (from its last 1 MB), or null when there is none.
function tailFile(file, lines) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 1048576);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8').split(/\r?\n/);
    if (length < size) text.shift(); // a partial first line
    while (text.length > 0 && text[text.length - 1] === '') text.pop();
    return text.slice(-lines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

async function serverApi(ctx, match) {
  const action = match[1].toLowerCase();
  if (action === 'status') {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return sendJson(ctx, 405, { error: 'use GET' });
    const runner = places.runnerStatus();
    return sendJson(ctx, 200, Object.assign(updates.status(), {
      runner: runner ? { running: !runner.stale, updatedAt: runner.updatedAt, updates: runner.updates || null } : { running: false },
    }));
  }
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  // The website key (lib/sitekey.js), to paste into the Cloudflare project.
  if (action === 'site-key') {
    if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
    return sendJson(ctx, 200, { key: require('./sitekey').key() });
  }
  if (action === 'logs') {
    if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
    const parts = SERVER_LOGS[String(ctx.queryLower.name || 'server').toLowerCase()];
    if (!parts) return sendJson(ctx, 400, { error: `name is one of ${Object.keys(SERVER_LOGS).join(', ')}` });
    const lines = Math.min(3000, Math.max(10, Number(ctx.queryLower.lines) || 300));
    const text = tailFile(core.rootPath(...parts), lines);
    return send(ctx, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, text === null ? '(this log is empty or does not exist yet)' : text);
  }
  // Launchers ask /api/launcher/moved and switch to this address once it
  // answers (the VPS relay, tools/vps): accounts and sessions carry over.
  if (action === 'moved') {
    const file = core.rootPath('config', 'moved.json');
    if (ctx.method === 'GET') {
      const moved = core.readJsonFile(file);
      return sendJson(ctx, 200, { to: moved && typeof moved.to === 'string' ? moved.to : null });
    }
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use GET or POST' });
    const body = await jsonBody(ctx);
    if (body.to === null) {
      try { fs.unlinkSync(file); } catch (error) { /* not set */ }
      return sendJson(ctx, 200, { to: null });
    }
    const to = typeof body.to === 'string' ? body.to.trim().replace(/\/+$/, '') : '';
    if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(to)) return sendJson(ctx, 400, { error: 'to must be an address like https://play.example.com' });
    if (!core.writeFileAtomic(file, Buffer.from(JSON.stringify({ to }, null, 2)))) return sendJson(ctx, 500, { error: 'could not save config/moved.json' });
    return sendJson(ctx, 200, { to });
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  if (action === 'update/check') {
    places.requestServer('update-check');
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === 'update/install') {
    if (!updates.listStaged().some((item) => !item.failed)) return sendJson(ctx, 409, { error: 'no update is waiting to install' });
    places.requestServer('update-install');
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === 'update/discard') {
    updates.discard(ctx.queryLower.build);
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === 'restart') {
    places.requestServer('server-restart');
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === 'update/upload') {
    const declared = Number(ctx.req.headers['content-length']);
    const bytes = await ctx.body(UPDATE_UPLOAD_LIMIT);
    if (bytes.length === 0) return sendJson(ctx, 400, { error: 'no update file was sent' });
    if (Number.isFinite(declared) && declared !== bytes.length) return sendJson(ctx, 400, { error: 'the upload was cut short' });
    try {
      const { dir, ...staged } = updates.stage(bytes, 'uploaded on /manage');
      return sendJson(ctx, 200, { staged });
    } catch (error) {
      return sendJson(ctx, 400, { error: error.message });
    }
  }
  return sendJson(ctx, 404, { error: 'unknown server API call' });
}

// /play/<placeId>[?server=<job ID>]: a game's share link. Chat apps make
// https links clickable (not rbx2017:// ones) and show the game's name and
// picture; the page then hands the game to the launcher through its
// rbx2017:// link (Launcher/main.js), which joins it, or that server.
const LAUNCHER_DOWNLOAD = 'https://github.com/FilteredAsync/rbx2017-launcher/releases/latest';
function sharePage(ctx, match) {
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const place = places.exists() ? places.get(match[1]) : null;
  const html = (status, body) => sendUtf8(ctx, status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body);
  let host = ctx.publicHost || String(ctx.req.headers.host || '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
  let base = `${ctx.publicHost || ctx.req.socket.encrypted ? 'https' : 'http'}://${host}`;
  // Launchers take a link only for the server they use, and moved ones use
  // the address in config/moved.json: links shared under an older name
  // (the sslip.io one, say) hand them that address.
  const moved = core.readJsonFile(core.rootPath('config', 'moved.json'));
  if (moved && typeof moved.to === 'string' && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(moved.to)) {
    base = moved.to;
    host = new URL(moved.to).host;
  }
  const server = /^[0-9a-f]{8,64}$/i.test(ctx.queryLower.server || '') ? ctx.queryLower.server : '';
  if (!place) return html(404, `<!doctype html><meta charset="utf-8"><title>Game not found</title><body style="font:16px Segoe UI,sans-serif;background:#0d1b26;color:#ddd;padding:40px">There is no game with that link on this server.`);
  const link = `rbx2017://play/${place.placeId}?host=${encodeURIComponent(host)}${server ? `&server=${server}` : ''}`;
  const thumb = gamethumbs.get(place.placeId) ? `${base}/api/thumbnails/${place.placeId}` : '';
  const title = server ? `Join ${place.name} (a friend's server)` : `Play ${place.name}`;
  const about = (place.description || 'A game on this RobloxClient server.').slice(0, 300);
  return html(200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(about)}">
${thumb ? `<meta property="og:image" content="${esc(thumb)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<meta name="theme-color" content="#00a2ff">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1b26;color:#e8eef3;font:16px "Segoe UI",system-ui,sans-serif}
main{width:min(460px,90vw);text-align:center}
img{width:100%;aspect-ratio:1;object-fit:cover;box-shadow:0 18px 50px rgba(0,0,0,.45)}
h1{font-weight:300;font-size:34px;margin:22px 0 6px}
p{color:#9fb1bf;margin:6px 0}
a.play{display:inline-block;margin-top:22px;padding:14px 40px;background:#00a2ff;color:#fff;text-decoration:none;font-size:18px;font-weight:600}
a.get{color:#9fd8ff}
</style></head>
<body><main>
${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}
<h1>${esc(place.name)}</h1>
<p>${server ? 'A friend shared the server they are in.' : 'Shared from the RobloxClient Launcher.'}</p>
<a class="play" href="${esc(link)}">Open in the launcher</a>
<p style="margin-top:18px">No launcher yet? <a class="get" href="${LAUNCHER_DOWNLOAD}">Get it</a>, then open this link again.</p>
</main>
<script>setTimeout(function () { location.href = ${JSON.stringify(link).replace(/</g, '\\u003c')}; }, 400);</script>
</body></html>`);
}

// Custom game thumbnails (lib/gamethumbs.js): anyone may look, hosts may change.
async function thumbnailsApi(ctx, match) {
  const placeId = match[1];
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    const found = gamethumbs.get(placeId);
    if (!found) return sendJson(ctx, 404, { error: 'this place has no thumbnail' });
    return sendFile(ctx, found.file, { 'Content-Type': found.type, 'Cache-Control': 'no-cache' });
  }
  if (ctx.method !== 'POST' && ctx.method !== 'DELETE') return sendJson(ctx, 405, { error: 'use GET, POST or DELETE' });
  if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
  if (ctx.method === 'DELETE') {
    gamethumbs.remove(placeId);
    return sendJson(ctx, 200, { ok: true, thumbnail: null });
  }
  const result = gamethumbs.save(placeId, await ctx.body(gamethumbs.MAX_BYTES));
  if (result.error) return sendJson(ctx, 400, { error: result.error });
  return sendJson(ctx, 200, { ok: true, thumbnail: result.version });
}

function fixed(contentType, body, extra) {
  return (ctx) => send(ctx, 200, Object.assign({ 'Content-Type': contentType }, extra || {}), body);
}

// BadgeService (lib/badges.js), in the replies the 2017 engine reads:
// HasBadge "Success" (else false), AwardBadge "0" (not awarded) or the text
// of the player's badge notification, IsBadgeDisabled "0", IsBadgeLegal "1".
function badgeRoute(ctx, match) {
  const badges = require('./badges');
  const q = ctx.queryLower;
  const reply = (status, body) => send(ctx, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body);
  const call = match[1].toLowerCase();
  if (call === 'hasbadge') return reply(200, badges.has(q.userid, q.badgeid) ? 'Success' : 'Failure');
  if (call === 'isbadgedisabled') return reply(200, '0');
  if (call === 'isbadgelegal') return reply(200, '1');
  if (!fromGameServer(ctx.remote)) return reply(403, '0');
  const isNew = badges.award(q.userid, q.badgeid);
  if (isNew) rewardBadge(q.userid, q.badgeid, q.placeid).catch(() => { /* no Robux this time */ });
  return reply(200, isNew ? 'You won a badge!' : '0');
}

// Roblox Studio 2017: login, start page, editing and publishing (lib/studio.js).
const studio = require('./studio')({ send, sendUtf8, sendFile, sendJson, jsonBody, sign });
const launcher = require('./launcherapi')({ send, sendJson, jsonBody, assetBytes });
// The Android app (lib/mobile.js).
const mobile = require('./mobile')({ send, sendUtf8, sendJson, launcher, sessionCookie: studio.sessionCookie });
// The Xbox One app, rebuilt for Windows (lib/xbox.js).
const xbox = require('./xbox')({ send, sendUtf8, sendJson, launcher, sessionCookie: studio.sessionCookie });
// Studio's Toolbox: free models from before 2018 and the player's inventory (lib/toolbox.js).
const toolbox = require('./toolbox')({ send, sendUtf8, launcher, assetBytes, convertModel: convertModelFile });

// --- Route table ---------------------------------------------------------------------
// Matched case-insensitively against the path without the leading "/".
// Covers www/.htaccess rewrites and every PHP file with real logic.

const opt = '(?:/index\\.php)?/?';
const ROUTES = [
  [/^ide\/clienttoolbox\.aspx/i, toolbox.page],
  ...studio.routes,
  ...launcher.routes,
  ...mobile.routes,
  ...xbox.routes,
  [/^api\/games(?:\/([a-z0-9]+)(?:\/([a-z]+))?)?\/?$/i, gamesApi],
  [/^api\/thumbnails\/(\d{1,15})\/?$/i, thumbnailsApi],
  [/^play\/(\d{1,15})\/?$/i, sharePage],
  [/^api\/places\/(\d{1,15})\/versions(?:\/(\d{1,15}-\d{8}T\d{6}\.rbxlx?)\/restore)?\/?$/i, placeVersionsApi],
  [/^api\/places(?:\/(\d{1,15})(?:\/([a-z-]+))?)?\/?$/i, placesApi],
  [/^api\/places\/(\d{1,15})\/servers\/([0-9a-f]{16,32})\/(restart|stop)\/?$/i, placeServerApi],
  [/^api\/private-servers\/([0-9a-f]{12})\/?$/i, privateServerAdminApi],
  ...require('./manageapi')({ send, sendJson, sendFile, jsonBody }).routes,
  [/^download\/((?:client|studio)-files(?:-\d{4})?(?:\.(?:zip|json|tar\.zst)|-from-[0-9a-f]{12}\.tar\.zst))$/i, downloadsRoute],
  [/^download\/menu-music\.mp3$/i, menuMusicRoute],
  [/^download\/(roblox-logo(?:-tagline)?\.png)$/i, launcherLogoRoute],
  [/^api\/assets\/(?:missing|(\d{1,15})\/replacement)\/?$/i, assetsApi],
  [/^api\/announcements(?:\/([0-9a-f]{12}))?\/?$/i, announcementsApi],
  [/^api\/reports(?:\/([0-9a-f]{12})(?:\/(resolve))?)?\/?$/i, reportsApi],
  [/^abusereport\/ingamechathandler\.ashx\/?$/i, abuseReport],
  [/^api\/manage\/(token|whoami)\/?$/i, (ctx, match) => admin.route(ctx, match, sendJson)],
  [/^api\/server\/(status|update\/check|update\/install|update\/upload|update\/discard|restart|logs|moved|site-key)\/?$/i, serverApi],
  [new RegExp(`^asset(?:/index\\.php)?/?$`, 'i'), assetEndpoint],
  [/^asset\/bodycolors\.(?:ashx|php)$/i, bodyColors],
  [new RegExp(`^v1\\.1/avatar-fetch${opt}$`, 'i'), avatarFetch],
  [new RegExp(`^game/characterappearance\\.ashx${opt}$`, 'i'), characterAppearance],
  [new RegExp(`^game/placelauncher\\.ashx${opt}$`, 'i'), placeLauncher],
  [/^game\/join\.php$/i, join],
  [new RegExp(`^game/join\\.lua${opt}$`, 'i'), joinLua],
  [/^game\/(join[123]\.php|joinbuildersclub\.php|joinnone\.php|joinoutrageousbuildersclub\.php|jointurbobuildersclub\.php|placelauncherr\.php)$/i, templateJoin],
  [new RegExp(`^game/(studio|global|oldstudio)\\.ashx${opt}$`, 'i'), unsignedStartScript],
  [new RegExp(`^error/(?:dmp|grid)\\.ashx${opt}$`, 'i'), captureUpload],
  [/^error\/capture\.php$/i, captureUpload],
  [new RegExp(`^persistence/(getv2|set|increment|remove|getsortedvalues)${opt}$`, 'i'), persistence],
  [new RegExp(`^moderation/v2/filtertext${opt}$`, 'i'), filterText],
  [/^marketplace\/productdetails(?:\.php)?$/i, productDetails],
  [/^marketplace\/productinfo(?:\.php)?$/i, productInfo],
  // MarketplaceService (lib/marketplace.js): purchases cost Robux
  // (lib/robux.js), assets and game passes are owned once bought
  // (lib/ownership.js), developer products are bought with receipts.
  [new RegExp(`^marketplace/submitpurchase${opt}$`, 'i'), submitPurchase],
  [new RegExp(`^marketplace/validatepurchase${opt}$`, 'i'), validatePurchase],
  [new RegExp(`^marketplace/purchase${opt}$`, 'i'), purchaseAsset],
  [new RegExp(`^gametransactions/settransactionstatuscomplete${opt}$`, 'i'), completePurchase],
  [new RegExp(`^gametransactions/getpendingtransactions${opt}$`, 'i'), pendingPurchases],
  [new RegExp(`^my/economy-status${opt}$`, 'i'), fixed('application/json; charset=utf-8', '{"isMarketplaceEnabled":true,"isMarketplaceEnabledForAuthenticatedUser":true,"isMarketplaceEnabledForUser":true,"isMarketplaceEnabledForGroup":true}', { 'Cache-Control': 'no-store' })],
  [new RegExp(`^ownership/hasasset${opt}$`, 'i'), hasAsset],
  [/^game\/gamepass\/gamepasshandler\.ashx$/i, hasPass],
  [/^v1\/users\/(-?\d{1,15})\/items\/(gamepass|badge)\/(\d{1,15})\/?$/i, inventoryItem],
  [/^game\/badge\/(hasbadge|awardbadge|isbadgedisabled|isbadgelegal)\.ashx$/i, badgeRoute],
  [/^game\/luawebservice\/handlesocialrequest\.(?:ashx|php)$/i, socialRequest],
  [/^game\/tools\/thumbnailasset\.ashx$/i, thumbnailRoute('asset')],
  [/^(?:thumbs\/asset\.ashx|asset-thumbnail\/image)$/i, thumbnailRoute('asset')],
  [/^(?:thumbs\/avatar\.ashx|avatar-thumbnail\/image)$/i, thumbnailRoute('avatar')],
  [/^bundle-thumbnail\/image$/i, thumbnailRoute('bundle')],
  [/^(?:thumbs\/headshot\.ashx|headshot-thumbnail\/image)$/i, thumbnailRoute('headshot')],
  [new RegExp(`^setting/quietget/rccservicerccservice${opt}$`, 'i'), rccSettings],
  // RCC parses these as JSON and crashes on anything else ("Expect either an
  // object or array at root"), so every settings group answers JSON: RCC's
  // flags for its own groups (e.g. /Setting/QuietGet/RCCService/), {} otherwise.
  [/^setting\/quietget\/rccservice[^/]*\/?$/i, rccSettings],
  [/^setting\/quietget\/clientappsettings\/?$/i, clientAppSettings],
  [/^setting\/quietget\/[^/]+\/?$/i, fixed('application/json; charset=utf-8', '{}', { 'Cache-Control': 'no-store' })],
  [new RegExp(`^device/initialize${opt}$`, 'i'), deviceInitialize],
  [new RegExp(`^v1\\.1/game-start-info${opt}$`, 'i'), gameStartInfo],
  [new RegExp(`^currency/balance${opt}$`, 'i'), currencyBalance],
  [/^upgrades\/robux\.aspx$/i, robuxPage],
  [new RegExp(`^game/validate-machine${opt}$`, 'i'), fixed('application/json', '{"success":true}', { 'Cache-Control': 'no-store' })],
  // The 2018 RCC reports its game to Roblox's game server list
  // (gameinstances.api.<domain>, games.api.<domain>) and its players' visits;
  // games here are listed by lib/hosting.js instead, so these only answer.
  [/^v2\/createorupdate\/?$/i, fixed('application/json; charset=utf-8', '{}', { 'Cache-Control': 'no-store' })],
  [/^v1\/close\/?$/i, fixed('application/json; charset=utf-8', '{}', { 'Cache-Control': 'no-store' })],
  [/^v2\.0\/refresh\/?$/i, fixed('application/json; charset=utf-8', '{}', { 'Cache-Control': 'no-store' })],
  [/^game\/(?:clientpresence|placevisit)\.ashx\/?$/i, fixed('text/plain; charset=utf-8', '', { 'Cache-Control': 'no-store' })],
  [new RegExp(`^login/negotiate\\.ashx${opt}$`, 'i'), fixed('text/plain; charset=utf-8', 'true')],
  // RCC asks this before accepting a player (api.<domain>); the retired
  // Roblox service answered true for a place the player may join.
  [new RegExp(`^universes/validate-place-join${opt}$`, 'i'), fixed('application/json; charset=utf-8', 'true', { 'Cache-Control': 'no-store' })],
  // RCC's lists of allowed client versions and exe hashes
  // (versioncompatibility.api.<domain>). Empty means "check nothing". The
  // 2017 RCC skips the checks anyway (FFlagDebugLocalRccServerConnection),
  // but the 2016 one (0.254) can't use that flag, since its client doesn't
  // know it, and kicked its own client for missing from the old web root's
  // list (www/GetAllowedSecurityVersions, from 0.225 to 0.394 but not 0.254).
  [new RegExp(`^(?:GetAllowedSecurityVersions|GetAllowedSecurityKeys|GetAllowedMD5Hashes)${opt}$`, 'i'),
    fixed('application/json; charset=utf-8', '{"data":[]}', { 'Cache-Control': 'no-store' })],
  // www/game/players/1/index.php, for any player ID (guests' are negative).
  [new RegExp(`^game/players/-?\\d+${opt}$`, 'i'), fixed('text/html', '{"ChatFilter":"whitelist"}')],
  // www/studio/e.png forwarded a fake analytics event to Roblox; now a no-op.
  [new RegExp(`^studio/e\\.png${opt}$`, 'i'), fixed('text/plain', '')],
];

// The Android app's pages, tried first for requests to m.<domain>, and its
// page for anything else it opens there.
const MOBILE_ROUTES = mobile.pageRoutes;

module.exports = { ROUTES, MOBILE_ROUTES, NEXT: mobile.NEXT, upgrade: mobile.upgrade, isMobile: mobile.isMobile, mobileNotHere: mobile.notHerePage, send, sendFile, sign };
