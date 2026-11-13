'use strict';

// Endpoints that ran PHP logic under UwAmp, ported one-for-one. Static files
// and PHP files that only print fixed text are served by www.js instead.
// Each handler names the PHP file it replaces.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const core = require('./core');
const assets = require('./assets');
const avatar = require('./avatar');
const avatarStore = require('./avatarstore');
const creators = require('./creators');
const accounts = require('./accounts');
const admin = require('./admin');
const announcements = require('./announcements');
const updates = require('./updates');
const datastore = require('./datastore');
const games = require('./games');
const gamethumbs = require('./gamethumbs');
const placefile = require('./placefile');
const missingassets = require('./missingassets');
const places = require('./places');
const rbxm = require('./rbxm');
const social = require('./social');
const thumbs = require('./thumbs');
const www = require('./www');

// --- Response helpers --------------------------------------------------------

function send(ctx, status, headers, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined ? '' : String(body), 'latin1');
  const out = Object.assign({}, headers, { 'Content-Length': buffer.length });
  ctx.bytes = buffer.length;
  ctx.res.writeHead(status, out);
  ctx.res.end(ctx.method === 'HEAD' ? undefined : buffer);
}

function sendUtf8(ctx, status, headers, text) {
  send(ctx, status, headers, Buffer.from(text, 'utf8'));
}

function sendFile(ctx, file, headers) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Asset not found');
    return;
  }
  ctx.bytes = stat.size;
  ctx.res.writeHead(200, Object.assign({}, headers, { 'Content-Length': stat.size }));
  if (ctx.method === 'HEAD') {
    ctx.res.end();
    return;
  }
  fs.createReadStream(file).on('error', () => ctx.res.destroy()).pipe(ctx.res);
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

async function assetEndpoint(ctx) {
  // A library place opened in Studio (lib/studio.js).
  if (studio.placeAsset(ctx)) return;
  const query = ctx.queryLower;
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
      return sendFile(ctx, override, { 'Content-Type': assets.contentTypeFor(override), 'Cache-Control': 'no-store', 'X-Legacy-Asset-Cache': 'OVERRIDE' });
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
  // place file, never the unrelated Roblox asset with that number.
  const libraryPlace = assetId !== null ? places.load().places[assetId] : null;
  if (assetId !== null && (libraryPlace || assetId === '1818' || games.list().some((game) => String(game.placeId) === String(assetId)))) {
    const placeFile = libraryPlace ? places.filePath(libraryPlace) : core.rootPath('Server', 'content', 'place.rbxlx');
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
      return sendFile(ctx, override, { 'Content-Type': assets.contentTypeFor(override), 'Cache-Control': 'no-store', 'X-Legacy-Asset-Cache': 'OVERRIDE' });
    }
  }

  const cacheDirectory = core.cacheDir('assets');
  const cachePath = path.join(cacheDirectory, `${fileKey}.bin`);
  const metadataPath = `${cachePath}.json`;
  const missingPath = `${cachePath}.missing`;
  const cachedHeaders = (state, type) => ({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Legacy-Asset-Cache': state });

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
        return send(ctx, 200, cachedHeaders('HIT-REPAIRED', cachedContentType(metadataPath)), bytes);
      }
    }
    return sendFile(ctx, cachePath, cachedHeaders('HIT', cachedContentType(metadataPath)));
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
  if (!outcome.ok) return fail(ctx, outcome.status, outcome.message);
  return send(ctx, 200, cachedHeaders('MISS', outcome.contentType), outcome.bytes);
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
    if (!outcome.ok) return fail(ctx, outcome.status, outcome.message);
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
  const character = await avatar.characterFor(userId, username);
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
  const q = ctx.query;
  let state = gameServerState();
  const gameId = ctx.queryLower.gameid;
  if (gameId !== undefined && gameId !== '') {
    const game = games.get(String(gameId));
    if (game === null) {
      return send(ctx, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        core.phpJson({ jobId: '', status: 5, joinScriptUrl: null, authenticationUrl: null, authenticationTicket: null, message: 'That game is no longer online.' }));
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
  const app = `http://localhost./v1.1/avatar-fetch/?placeId=${placeid}&userId=${id}`;
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
  // PlaceId comes from the template (%placeid%, the hosted game's place). It
  // was once forced to 1818 here, so any other place ID gave the client and
  // RCC different place IDs and the client crashed right after loading.
  payload = payload.replace(/"IsRobloxPlace":(?:true|false)/, '"IsRobloxPlace":true');
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

// --- Small endpoints ---------------------------------------------------------------------

function captureUpload(ctx) {
  return ctx.body().then((body) => {
    const directory = path.join(core.WWW, 'Error', 'captures');
    fs.mkdirSync(directory, { recursive: true });
    const sourceName = ctx.query.filename !== undefined ? path.basename(ctx.query.filename.replace(/\\/g, '/')) : 'client-upload.bin';
    const safeName = sourceName.replace(/[^A-Za-z0-9._-]/g, '_');
    const stamp = core.gmdate().replace(/[-:]/g, '').replace(' ', '_');
    const unique = Date.now().toString(16) + Math.floor(Math.random() * 0xfffff).toString(16);
    const capturePath = path.join(directory, `${stamp}_${unique}_${safeName}`);
    let content = body;
    const type = String(ctx.req.headers['content-type'] || '');
    const boundaryMatch = /multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(type);
    if (boundaryMatch) {
      const file = firstMultipartFile(body, boundaryMatch[2]);
      if (file !== null) content = file;
    }
    try {
      fs.writeFileSync(capturePath, content);
    } catch (error) {
      return send(ctx, 500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'capture failed');
    }
    send(ctx, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'OK');
  });
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
// Writes are logged to local-api-requests.log (values cut to 200 characters).
async function persistence(ctx, match) {
  const action = match[1];
  const raw = (await ctx.body()).toString('utf8');
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
  const raw = (await ctx.body()).toString('utf8');
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

const LOCAL_PRODUCTS = {
  25386984: 'Local Money Pack 1', 25387029: 'Local Money Pack 2', 25387042: 'Local Money Pack 3',
  25386995: 'Local Money Pack 4', 25387075: 'Local Money Pack 5', 25387014: 'Local Money Pack 6',
};

// Creator of things that are not library places: ROBLOX (user 1), as on
// the 2017 site for catalog items.
const ROBLOX_CREATOR = { Id: 1, Name: 'ROBLOX', CreatorType: 'User' };

// A library place's creator as productinfo shows it.
function placeCreator(place) {
  const creator = places.creatorOf(place);
  if (!creator) return { Id: 0, Name: '', CreatorType: 'User' };
  return { Id: creator.id, Name: creator.name, CreatorType: creator.type };
}

// www/marketplace/productDetails.php
function productDetails(ctx) {
  const productId = core.phpInt(ctx.query.productId);
  const name = LOCAL_PRODUCTS[productId] || `Local Product ${productId}`;
  send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, core.phpJson({
    TargetId: productId, ProductType: 'Developer Product', AssetId: 0, ProductId: productId, Name: name,
    Description: 'Local developer product.', AssetTypeId: 0,
    Creator: ROBLOX_CREATOR,
    IconImageAssetId: 0, Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z', PriceInRobux: 0,
    IsForSale: false, IsLimited: false, IsLimitedUnique: false, Remaining: null, MinimumMembershipLevel: 0, ContentRatingTypeId: 0,
  }));
}

// www/marketplace/productinfo.php
function productInfo(ctx) {
  const assetId = core.phpInt(ctx.query.assetId);
  // A library place: its own name and creator (the game's loading screen
  // shows "By ..."; Studio shows both, and Team Create checks the owner).
  const place = places.exists() ? places.get(assetId) : null;
  if (place) creators.fillMissing();
  send(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8' }, core.phpJson({
    TargetId: assetId, ProductType: 'User Product', AssetId: assetId, ProductId: 0,
    Name: place ? place.name : (assetId === 1818 ? 'Lumber Tycoon 2' : `Local Asset ${assetId}`),
    Description: place && place.description ? place.description : 'Served by the local game server.', AssetTypeId: 9,
    Creator: place ? placeCreator(place) : ROBLOX_CREATOR,
    IconImageAssetId: 0, Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z', PriceInRobux: null,
    IsForSale: false, IsLimited: false, IsLimitedUnique: false, Remaining: null, MinimumMembershipLevel: 0, ContentRatingTypeId: 0,
  }));
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
    const id = core.decimal(raw);
    if (id === null || id === '0' || id.length > 15) return fail(ctx, 400, 'Invalid id');
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
  };
  // RCC reads each as FString (at startup) or DFString (live); send both.
  for (const [name, value] of Object.entries(RCC_STRINGS)) {
    settings[`FString${name}`] = value;
    settings[`DFString${name}`] = value;
  }
  send(ctx, 200, jsonNoStore, core.phpJson(settings));
}

// www/device/initialize/index.php: store the posted body, answer the literal.
async function deviceInitialize(ctx) {
  const directory = path.join(core.WWW, 'device', 'initialize');
  try { fs.writeFileSync(path.join(directory, 'post.txt'), await ctx.body()); } catch (error) { /* as PHP: ignore */ }
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
  sendUtf8(ctx, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(value));
}

async function jsonBody(ctx) {
  try {
    const value = JSON.parse((await ctx.body()).toString('utf8') || '{}');
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
    const running = runner && !runner.stale && runner.games ? runner.games : {};
    const list = games.list().map((game) => {
      const place = library[game.placeId];
      const creator = place ? places.creatorOf(place) : null;
      const status = running[game.placeId];
      return Object.assign(game, place ? { name: place.name, description: place.description || '' } : {}, {
        creator: creator ? creator.name : '',
        playing: status && Array.isArray(status.players) ? status.players.length : null,
        thumbnail: gamethumbs.version(game.placeId),
      });
    });
    return sendJson(ctx, 200, { games: list });
  }
  if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
  const body = await jsonBody(ctx);
  const key = ctx.req.headers['x-host-key'] !== undefined ? String(ctx.req.headers['x-host-key']) : body.key;
  if (!games.checkHostKey(key)) return sendJson(ctx, 403, { error: 'wrong or missing host key (config/host-key.txt on the web server)' });

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
//                                            body: a .rbxlx; converted, given the next place ID
//   POST   /api/places/<id>/file?fromPlace=   new file for a place (same ID)
//   POST   /api/places/<id>                   JSON {name, description, enabled, universeId}
//   POST   /api/places/<id>/restart           ask the always-on server to restart it
//   DELETE /api/places/<id>                   remove (saves, thumbnail and ID stay reserved)
// Changes need the host key (X-Host-Key).

// Fields of a library place only admins see.
const ADMIN_PLACE_FIELDS = ['file', 'uploadedFrom', 'notes'];
function forViewer(place, isAdmin) {
  if (!isAdmin) for (const field of ADMIN_PLACE_FIELDS) delete place[field];
  return place;
}

function placesWithStatus(isAdmin) {
  const runner = places.runnerStatus();
  const running = runner && !runner.stale && runner.games ? runner.games : {};
  creators.fillMissing();
  return {
    places: places.list().map((place) => Object.assign(forViewer(place, isAdmin), {
      thumbnail: gamethumbs.version(place.placeId),
      status: running[place.placeId] || null,
      cloudEdit: runner && !runner.stale && runner.cloudEdit ? runner.cloudEdit[place.placeId] || null : null,
    })),
    runner: runner ? { running: !runner.stale, updatedAt: runner.updatedAt, maxGames: runner.maxGames, problems: runner.problems || [] } : { running: false },
    // For the join code players paste into their launcher.
    server: { tailscaleUrl: core.tailscaleIPv4() ? `http://${core.tailscaleIPv4()}` : null },
  };
}

// The uploaded place, converted for the 2017 engine -> { bytes, notes, universeId } or { error }.
async function convertUpload(ctx, query) {
  const declared = Number(ctx.req.headers['content-length']);
  const bytes = await ctx.body();
  if (bytes.length === 0) return { error: 'no place file was sent' };
  if (Number.isFinite(declared) && declared !== bytes.length) return { error: 'the upload was cut short (too large? the limit is 512 MB)' };
  let universeId = places.placeKey(query.universeid);
  if (universeId === null && places.placeKey(query.fromplace)) {
    universeId = await placefile.universeForPlace(places.placeKey(query.fromplace));
    if (universeId === null) return { error: `could not find the universe of Roblox place ${query.fromplace}` };
  }
  try {
    const result = placefile.convertPlace(bytes, { universeId });
    return { bytes: result.output, notes: result.summary, universeId };
  } catch (error) {
    return { error: error.message };
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
    const place = places.replaceFile(placeId, { bytes: converted.bytes, notes: converted.notes, universeId: converted.universeId, from });
    return sendJson(ctx, 200, { place, notes: converted.notes });
  }
  if (action === 'restart') {
    places.requestRestart(placeId);
    return sendJson(ctx, 200, { ok: true });
  }
  if (action === null) {
    const body = await jsonBody(ctx);
    const place = places.update(placeId, { name: body.name, description: body.description, enabled: body.enabled, universeId: body.universeId, teamCreate: body.teamCreate, creator: body.creator });
    return sendJson(ctx, 200, { place });
  }
  return sendJson(ctx, 404, { error: 'unknown places API call' });
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
  const bytes = await ctx.body();
  if (Number.isFinite(declared) && declared !== bytes.length) return sendJson(ctx, 400, { error: 'the upload was cut short' });
  const result = missingassets.saveReplacement(id, bytes);
  return result.error ? sendJson(ctx, 400, result) : sendJson(ctx, 200, Object.assign({ ok: true }, result));
}

// Game files for the downloader installer: the launcher from the small
// Setup.exe downloads the client from here on first run (and offers updates
// when the version changes). Built by tools/build-client-files.py into
// RobloxClient/downloads/.
const DOWNLOADS = {
  'client-files.json': 'application/json; charset=utf-8', 'client-files.zip': 'application/zip',
  'studio-files.json': 'application/json; charset=utf-8', 'studio-files.zip': 'application/zip',
};
function downloadsRoute(ctx, match) {
  const name = match[1].toLowerCase();
  const file = core.rootPath('downloads', name);
  if (!core.isFile(file)) {
    return sendJson(ctx, 404, { error: name.startsWith('studio')
      ? 'this server has no Studio to hand out (run tools/build-client-files.py studio on the PC that has it)'
      : 'this server has no game files to hand out (run tools/build-client-files.py on it)' });
  }
  sendFile(ctx, file, { 'Content-Type': DOWNLOADS[name], 'Cache-Control': name.endsWith('.json') ? 'no-cache' : 'public, max-age=3600' });
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

// The always-on server itself (dedicated.js), for /manage: updates
// (lib/updates.js), restarting the whole server and reading its logs.
//   GET  /api/server/status                  versions, waiting updates, the last result
//   POST /api/server/update/check            look for a newer update on GitHub now
//   POST /api/server/update/install          install the waiting update(s) now
//   POST /api/server/update/upload           body: an .rbxupd file (checked and set to wait)
//   POST /api/server/update/discard?build=   drop a waiting (or failed) update
//   POST /api/server/restart                 restart the whole server (players saved first)
//   GET  /api/server/logs?name=&lines=       the end of a log: server, web, studio, update
// All but status need the host key (X-Host-Key).
const SERVER_LOGS = {
  server: ['Webserver', 'node', 'logs', 'dedicated.log'],
  web: ['Webserver', 'node', 'logs', 'server.log'],
  studio: ['Webserver', 'node', 'logs', 'studio.log'],
  update: ['updates', 'update.log'],
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
  if (action === 'logs') {
    if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
    const parts = SERVER_LOGS[String(ctx.queryLower.name || 'server').toLowerCase()];
    if (!parts) return sendJson(ctx, 400, { error: `name is one of ${Object.keys(SERVER_LOGS).join(', ')}` });
    const lines = Math.min(3000, Math.max(10, Number(ctx.queryLower.lines) || 300));
    const text = tailFile(core.rootPath(...parts), lines);
    return send(ctx, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, text === null ? '(this log is empty or does not exist yet)' : text);
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
    const bytes = await ctx.body();
    if (bytes.length === 0) return sendJson(ctx, 400, { error: 'no update file was sent' });
    if (Number.isFinite(declared) && declared !== bytes.length) return sendJson(ctx, 400, { error: 'the upload was cut short (too large? the limit is 512 MB)' });
    try {
      const { dir, ...staged } = updates.stage(bytes, 'uploaded on /manage');
      return sendJson(ctx, 200, { staged });
    } catch (error) {
      return sendJson(ctx, 400, { error: error.message });
    }
  }
  return sendJson(ctx, 404, { error: 'unknown server API call' });
}

// The management page (Webserver/node/manage/).
const MANAGE_FILES = { '': ['index.html', 'text/html; charset=utf-8'], 'manage.js': ['manage.js', 'text/javascript; charset=utf-8'], 'manage.css': ['manage.css', 'text/css; charset=utf-8'] };
function managePage(ctx, match) {
  const entry = MANAGE_FILES[(match[1] || '').toLowerCase()];
  if (!entry) return send(ctx, 404, { 'Content-Type': 'text/plain' }, 'Not found');
  return sendFile(ctx, path.join(__dirname, '..', 'manage', entry[0]), { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
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
  const result = gamethumbs.save(placeId, await ctx.body());
  if (result.error) return sendJson(ctx, 400, { error: result.error });
  return sendJson(ctx, 200, { ok: true, thumbnail: result.version });
}

function fixed(contentType, body, extra) {
  return (ctx) => send(ctx, 200, Object.assign({ 'Content-Type': contentType }, extra || {}), body);
}

// Roblox Studio 2017: login, start page, editing and publishing (lib/studio.js).
const studio = require('./studio')({ send, sendUtf8, sendFile, sendJson, jsonBody, sign });
const launcher = require('./launcherapi')({ send, sendJson, jsonBody, assetBytes });

// --- Route table ---------------------------------------------------------------------
// Matched case-insensitively against the path without the leading "/".
// Covers www/.htaccess rewrites and every PHP file with real logic.

const opt = '(?:/index\\.php)?/?';
const ROUTES = [
  ...studio.routes,
  ...launcher.routes,
  [/^api\/games(?:\/([a-z0-9]+)(?:\/([a-z]+))?)?\/?$/i, gamesApi],
  [/^api\/thumbnails\/(\d{1,15})\/?$/i, thumbnailsApi],
  [/^api\/places(?:\/(\d{1,15})(?:\/([a-z]+))?)?\/?$/i, placesApi],
  [/^manage(?:\/([a-z.]*))?\/?$/i, managePage],
  [/^download\/((?:client|studio)-files\.(?:zip|json))$/i, downloadsRoute],
  [/^download\/menu-music\.mp3$/i, menuMusicRoute],
  [/^download\/(roblox-logo(?:-tagline)?\.png)$/i, launcherLogoRoute],
  [/^api\/assets\/(?:missing|(\d{1,15})\/replacement)\/?$/i, assetsApi],
  [/^api\/announcements(?:\/([0-9a-f]{12}))?\/?$/i, announcementsApi],
  [/^api\/manage\/(token|whoami)\/?$/i, (ctx, match) => admin.route(ctx, match, sendJson)],
  [/^api\/server\/(status|update\/check|update\/install|update\/upload|update\/discard|restart|logs)\/?$/i, serverApi],
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
  [new RegExp(`^currency/balance${opt}$`, 'i'), fixed('application/json; charset=utf-8', '{"robux":0}', { 'Cache-Control': 'no-store' })],
  [new RegExp(`^game/validate-machine${opt}$`, 'i'), fixed('application/json', '{"success":true}', { 'Cache-Control': 'no-store' })],
  [new RegExp(`^login/negotiate\\.ashx${opt}$`, 'i'), fixed('text/plain; charset=utf-8', 'true')],
  // RCC asks this before accepting a player (api.<domain>); the retired
  // Roblox service answered true for a place the player may join.
  [new RegExp(`^universes/validate-place-join${opt}$`, 'i'), fixed('application/json; charset=utf-8', 'true', { 'Cache-Control': 'no-store' })],
  // www/game/players/1/index.php, for any player ID.
  [new RegExp(`^game/players/\\d+${opt}$`, 'i'), fixed('text/html', '{"ChatFilter":"whitelist"}')],
  // www/studio/e.png forwarded a fake analytics event to Roblox; now a no-op.
  [new RegExp(`^studio/e\\.png${opt}$`, 'i'), fixed('text/plain', '')],
];

module.exports = { ROUTES, send, sendFile, sign };
