'use strict';

// Looks for usable copies of missing assets (lib/missingassets.js) and keeps
// what it finds until an admin approves or rejects it on /manage. Nothing
// becomes a replacement (assets-override/) without an approval.
//
// Where it looks, for each missing asset:
//   roblox     the asset itself (it may work again) and its older versions
//   thumbnail  for images, Roblox's own 512 px render of it
//   wayback    Wayback Machine captures of its URLs (www, assetgame,
//              assetdelivery), following their redirects to the rbxcdn files
//   creator    public uploads by the same creator with the same name
//              (Roblox's toolbox search, filtered to that creator)
// Never offered: anything Roblox marks Content Deleted or removed for
// copyright, or whose thumbnail is blocked (moderated), for the missing asset
// or for a copy of it.
//
// One asset at a time in the background, with a pause between requests to
// each site. What it found is kept in
//   Webserver/node/data/asset-search.json   per asset: state, found files
//   cache/asset-search/<id>/<n>.<ext>        a found file awaiting a decision

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const assets = require('./assets');
const missingassets = require('./missingassets');

const STATE = core.rootPath('Webserver', 'node', 'data', 'asset-search.json');
const FILES = core.rootPath('cache', 'asset-search');
const MAX_FOUND = 4;               // pending copies kept per asset
const MAX_CAPTURES = 6;            // Wayback captures tried per asset
const RESEARCH_EMPTY_DAYS = 30;    // search again when nothing was found
const RETRY_FAILED_HOURS = 12;     // search again after an error
const REFILL_MS = 10 * 60 * 1000;  // look for newly missing assets
const SAVE_MS = 3000;
const REMOVED = /content deleted|removed for copyright|\[\s*removed\s*\]/i;
// Pause between requests to the same site; longer after HTTP 429.
const SPACING = { roblox: 800, archive: 2500 };
const COOLDOWN_MS = 90 * 1000;

// Toolbox categories to look in for a creator's re-uploads, by asset type.
// Images are found as decals (an uploaded image comes with one).
const CREATOR_SEARCH = { Audio: 3, Decal: 13, Image: 13, Model: 10 };
// Which file kinds fit which asset type.
const FITS = {
  Audio: ['ogg', 'mp3', 'wav'],
  Image: ['png', 'jpg'],
  Decal: ['rbxm', 'rbxmx', 'png', 'jpg'],
  Animation: ['rbxm', 'rbxmx'],
  Model: ['rbxm', 'rbxmx'],
  // No replacement kind fits these (lib/missingassets.js).
  Mesh: [], MeshPart: [], Video: [],
};

// --- state ---------------------------------------------------------------------------------

let state = null;
let saveTimer = null;

function load() {
  if (state === null) {
    const data = core.readJsonFile(STATE);
    state = {
      paused: Boolean(data && data.paused),
      assets: data && data.assets && typeof data.assets === 'object' && !Array.isArray(data.assets) ? data.assets : {},
    };
    // A search cut off by a restart starts over.
    for (const entry of Object.values(state.assets)) if (entry.state === 'searching') entry.state = 'queued';
  }
  return state;
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  core.writeFileAtomic(STATE, JSON.stringify(state, null, 1));
}
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_MS);
  if (saveTimer.unref) saveTimer.unref();
}
process.on('exit', () => { if (saveTimer) save(); });

function entryOf(id) {
  const all = load().assets;
  if (!all[id]) all[id] = { state: 'new', found: [], rejected: [] };
  if (!Array.isArray(all[id].found)) all[id].found = [];
  if (!Array.isArray(all[id].rejected)) all[id].rejected = [];
  return all[id];
}

const fileOf = (id, item) => path.join(FILES, String(id), `${item.n}.${item.ext}`);

// --- HTTP, spaced out per site -------------------------------------------------------------

const nextAt = { roblox: 0, archive: 0 };
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (timer.unref) timer.unref(); });
const siteOf = (url) => (/(^|\.)archive\.org$/i.test(new URL(url).hostname) ? 'archive' : 'roblox');

async function polite(url, run) {
  const site = siteOf(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = nextAt[site] - Date.now();
    if (wait > 0) await sleep(wait);
    nextAt[site] = Date.now() + SPACING[site];
    const result = await run();
    if (result && result.status === 429) {
      nextAt[site] = Date.now() + COOLDOWN_MS;
      continue;
    }
    return result;
  }
  return { status: 429, body: Buffer.alloc(0), contentType: '', redirect: '', error: 'rate limited' };
}

const get = (url, headers, timeoutMs) => polite(url, () => assets.httpRequest(url, Object.assign({ Accept: '*/*' }, headers || {}), timeoutMs || 30000));

async function getJson(url, timeoutMs) {
  const response = await get(url, { Accept: 'application/json' }, timeoutMs || 20000);
  if (response.status !== 200) return null;
  try { return JSON.parse(response.body.toString('utf8')); } catch (error) { return null; }
}

// assets.downloadAsset (anonymous, then the API key, then the cookie), spaced out.
const download = (id) => polite('https://assetdelivery.roblox.com/', () => assets.downloadAsset('id', String(id)));

// An older version of an asset: Open Cloud with the API key, or the legacy
// endpoint with the cookie -> a downloadAsset-like result.
async function downloadVersion(id, version) {
  const key = assets.apiKey();
  if (key !== null) {
    const lookup = await get(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${id}/version/${version}`, { Accept: 'application/json', 'x-api-key': key });
    if (lookup.status !== 200) return { ok: false, status: lookup.status };
    let location = null;
    try { location = JSON.parse(lookup.body.toString('utf8')).location; } catch (error) { location = null; }
    if (typeof location !== 'string' || !/^https:\/\//i.test(location)) return { ok: false, status: 502 };
    const file = await polite(location, () => assets.httpGet(location, {}, 60000));
    return file.status === 200 ? { ok: true, body: file.body } : { ok: false, status: file.status };
  }
  const cookie = assets.roblosecurity();
  if (cookie === null) return { ok: false, status: 401 };
  const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}&version=${version}`;
  const file = await polite(url, () => assets.httpGet(url, { Cookie: `.ROBLOSECURITY=${cookie}` }, 60000));
  return file.status === 200 ? { ok: true, body: file.body } : { ok: false, status: file.status };
}

// --- Roblox facts -------------------------------------------------------------------------

async function details(id) {
  const data = await getJson(`https://economy.roblox.com/v2/assets/${id}/details`);
  if (!data) return null;
  const creator = data.Creator || {};
  return {
    name: String(data.Name || ''),
    description: String(data.Description || ''),
    type: missingassets.TYPE_NAMES[data.AssetTypeId] || `Type ${data.AssetTypeId}`,
    typeId: Number(data.AssetTypeId) || 0,
    creatorName: String(creator.Name || ''),
    creatorType: creator.CreatorType === 'Group' ? 2 : 1,
    creatorId: Number(creator.CreatorTargetId || creator.Id) || 0,
    created: String(data.Created || ''),
  };
}

// id -> { state, imageUrl } for each asset ID (up to 100).
async function thumbnails(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const data = await getJson(`https://thumbnails.roblox.com/v1/assets?assetIds=${ids.join(',')}&size=512x512&format=Png&isCircular=false`);
  for (const item of (data && Array.isArray(data.data)) ? data.data : []) out.set(String(item.targetId), { state: String(item.state || ''), imageUrl: String(item.imageUrl || '') });
  return out;
}

const removedName = (text) => REMOVED.test(String(text || ''));
const normalName = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// --- one search ----------------------------------------------------------------------------

// Adds a found file unless it is a duplicate, rejected before, the wrong kind,
// or one too many. -> true when added.
function offer(id, entry, bytes, fields, want) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > missingassets.MAX_BYTES) return false;
  const ext = missingassets.kindOf(bytes);
  if (!ext || (want && !want.includes(ext))) return false;
  const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
  if (entry.rejected.includes(sha1) || entry.found.some((item) => item.sha1 === sha1)) return false;
  if (entry.found.filter((item) => item.status === 'pending').length >= MAX_FOUND) return false;
  const n = entry.found.reduce((max, item) => Math.max(max, item.n), 0) + 1;
  const item = Object.assign({ n, ext, size: bytes.length, sha1, status: 'pending', foundAt: core.isoDate() }, fields);
  fs.mkdirSync(path.join(FILES, String(id)), { recursive: true });
  if (!core.writeFileAtomic(fileOf(id, item), bytes)) return false;
  entry.found.push(item);
  return true;
}

// -> true when Roblox serves the asset itself again (nothing else is worth a look then).
async function searchRoblox(id, entry, info, want) {
  const now = await download(id);
  if (now.ok) {
    offer(id, entry, now.body, { source: 'roblox', label: 'Roblox (works again)', link: `https://www.roblox.com/library/${id}` }, want);
    return true;
  }
  // Private assets are private in every version.
  if (now.status === 401 || now.status === 403) return false;
  for (let version = 1; version <= 3; version++) {
    const old = await downloadVersion(id, version);
    if (old.ok) {
      offer(id, entry, old.body, { source: 'version', label: `Roblox, version ${version}`, link: `https://www.roblox.com/library/${id}` }, want);
    } else if (old.status === 404 || old.status === 401 || old.status === 403) {
      break;
    }
  }
  return false;
}

async function searchThumbnail(id, entry, thumb) {
  if (!thumb || thumb.state !== 'Completed' || !/\/Image\//.test(thumb.imageUrl) || !/^https:\/\/[a-z0-9.]+\.rbxcdn\.com\//i.test(thumb.imageUrl)) return;
  const image = await get(thumb.imageUrl, {}, 30000);
  if (image.status === 200) offer(id, entry, image.body, { source: 'thumbnail', label: 'Roblox thumbnail, 512 px', link: `https://www.roblox.com/library/${id}` }, ['png', 'jpg']);
}

// The asset's URLs as the Wayback Machine knows them (its index ignores
// "www.", case and query order). Its index is slow (10 to 60 s a query), so
// only the forms places and the old site used.
const WAYBACK_URLS = (id) => [
  `roblox.com/asset/?id=${id}`, `roblox.com/asset?id=${id}`,
  `assetgame.roblox.com/asset/?id=${id}`, `assetdelivery.roblox.com/v1/asset/?id=${id}`,
];
const CDX_TIMEOUT_MS = 60000;

async function waybackCaptures(id) {
  const exact = new RegExp(`[?&]id=${id}(?:&|$)`, 'i');
  const seen = new Set();
  const captures = [];
  for (const url of WAYBACK_URLS(id)) {
    const query = new URLSearchParams({ url, matchType: 'prefix', output: 'json', fl: 'original,timestamp,statuscode,mimetype,digest', collapse: 'digest', limit: '40' });
    const rows = await getJson(`https://web.archive.org/cdx/search/cdx?${query}`, CDX_TIMEOUT_MS);
    for (const row of Array.isArray(rows) ? rows.slice(1) : []) {
      const [original, timestamp, status, mime, digest] = row;
      if (!exact.test(original) || /^[45]/.test(String(status)) || seen.has(digest)) continue;
      seen.add(digest);
      captures.push({ original, timestamp, status: String(status), mime: String(mime) });
    }
  }
  // Files first, then redirects to them (the rbxcdn copy), oldest first.
  const rank = (capture) => (capture.status === '200' ? 0 : /^3/.test(capture.status) ? 1 : 2);
  return captures.sort((a, b) => rank(a) - rank(b) || a.timestamp.localeCompare(b.timestamp));
}

// A capture's bytes, following its redirects inside the Wayback Machine.
async function waybackBytes(capture) {
  let url = `https://web.archive.org/web/${capture.timestamp}id_/${capture.original}`;
  for (let hop = 0; hop < 5; hop++) {
    const response = await get(url, {}, 45000);
    if (response.status >= 300 && response.status < 400 && response.redirect) {
      if (!/^https?:\/\/web\.archive\.org\/web\//i.test(response.redirect)) return null;
      url = response.redirect;
      continue;
    }
    return response.status === 200 ? { bytes: response.body, url } : null;
  }
  return null;
}

async function searchWayback(id, entry, want) {
  const captures = await waybackCaptures(id);
  let tried = 0;
  for (const capture of captures) {
    if (tried >= MAX_CAPTURES || entry.found.filter((item) => item.status === 'pending' && item.source === 'wayback').length >= 2) break;
    tried++;
    const got = await waybackBytes(capture);
    if (!got) continue;
    const date = `${capture.timestamp.slice(0, 4)}-${capture.timestamp.slice(4, 6)}-${capture.timestamp.slice(6, 8)}`;
    offer(id, entry, got.bytes, {
      source: 'wayback', label: `Wayback Machine, ${date}`, date,
      link: `https://web.archive.org/web/${capture.timestamp}/${capture.original}`,
    }, want);
  }
  return captures.length;
}

// A creator's public items of one toolbox category (newest searches cached
// for a while, since one creator usually has many missing assets).
const creatorCache = new Map();
async function creatorItems(creatorType, creatorId, category) {
  const key = `${creatorType}:${creatorId}:${category}`;
  const known = creatorCache.get(key);
  if (known && Date.now() - known.at < 6 * 3600 * 1000) return known.items;
  const ids = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ limit: '100', creatorTargetId: String(creatorId), creatorType: String(creatorType) });
    if (cursor) query.set('cursor', cursor);
    const data = await getJson(`https://apis.roblox.com/toolbox-service/v1/marketplace/${category}?${query}`);
    if (!data || !Array.isArray(data.data)) break;
    for (const item of data.data) if (/^\d{1,20}$/.test(String(item.id))) ids.push(String(item.id));
    cursor = typeof data.nextPageCursor === 'string' ? data.nextPageCursor : '';
    if (!cursor) break;
  }
  const items = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await getJson(`https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${ids.slice(i, i + 50).join(',')}`);
    for (const entry of (data && Array.isArray(data.data)) ? data.data : []) {
      const asset = entry && entry.asset;
      if (!asset) continue;
      items.push({
        id: String(asset.id), name: String(asset.name || ''), created: String(asset.createdUtc || ''),
        approved: asset.isAssetHashApproved !== false, visible: !asset.visibilityStatus,
        creator: entry.creator && entry.creator.name ? String(entry.creator.name) : '',
      });
    }
  }
  creatorCache.set(key, { at: Date.now(), items });
  if (creatorCache.size > 200) creatorCache.delete(creatorCache.keys().next().value);
  return items;
}

// The image a decal shows (its Texture), from the decal's model file.
function decalTexture(bytes) {
  let xml;
  try { xml = require('./rbxbinary').placeXml(bytes).xml; } catch (error) { return null; }
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);
  const match = /name="Texture"[^>]*>\s*(?:<url>)?\s*([^<\s]+)/i.exec(text);
  const id = match && /(?:[?&]id=|rbxassetid:\/\/)(\d{1,20})/i.exec(match[1]);
  return id ? id[1] : null;
}

async function searchCreator(id, entry, info, want) {
  const category = CREATOR_SEARCH[info.type];
  if (!category || !info.creatorId || !normalName(info.name)) return 0;
  const name = normalName(info.name);
  const items = await creatorItems(info.creatorType, info.creatorId, category);
  const matches = items
    .filter((item) => item.id !== String(id) && item.approved && item.visible && !removedName(item.name))
    .map((item) => {
      const other = normalName(item.name);
      const match = other === name ? 'same' : (name.length >= 5 && other.length >= 5 && (other.includes(name) || name.includes(other))) ? 'similar' : null;
      return Object.assign({ match }, item);
    })
    .filter((item) => item.match)
    .sort((a, b) => (a.match === 'same' ? 0 : 1) - (b.match === 'same' ? 0 : 1) || a.created.localeCompare(b.created))
    .slice(0, 3);
  if (!matches.length) return 0;
  const thumbs = await thumbnails(matches.map((item) => item.id));
  for (const item of matches) {
    if ((thumbs.get(item.id) || {}).state === 'Blocked') continue;
    const got = await download(item.id);
    if (!got.ok) continue;
    let bytes = got.body;
    let fileId = item.id;
    // An image re-uploaded: its decal points at the image.
    if (info.type === 'Image') {
      const texture = decalTexture(bytes);
      if (!texture) continue;
      const image = await download(texture);
      if (!image.ok) continue;
      bytes = image.body;
      fileId = texture;
    }
    offer(id, entry, bytes, {
      source: 'creator', label: `${item.match === 'same' ? 'Same name' : 'Similar name'}, uploaded by ${item.creator || info.creatorName}`,
      link: `https://www.roblox.com/library/${item.id}`, date: item.created.slice(0, 10), assetId: fileId, name: item.name, match: item.match,
    }, want);
  }
  return matches.length;
}

// Searches one asset -> the updated entry.
async function search(id) {
  const entry = entryOf(id);
  entry.state = 'searching';
  entry.startedAt = core.isoDate();
  delete entry.error;
  delete entry.skipped;
  saveSoon();
  const missing = missingassets.list().find((item) => item.id === String(id)) || { id: String(id) };
  try {
    const info = await details(id) || { name: missing.name || '', type: missing.type || '', creatorName: missing.creator || '', creatorId: 0, creatorType: 1 };
    entry.name = info.name || missing.name || null;
    entry.type = info.type || missing.type || null;
    entry.creator = info.creatorName || missing.creator || null;
    const thumbs = await thumbnails([String(id)]);
    const thumb = thumbs.get(String(id));
    // Roblox took it down: never look for a copy.
    if (removedName(info.name) || removedName(info.description) || (thumb && thumb.state === 'Blocked') || /moderated/i.test(missing.reason || '')) {
      entry.state = 'skipped';
      entry.skipped = removedName(info.name) || removedName(info.description) ? 'Removed by Roblox' : 'Moderated on Roblox';
      dropPending(id, entry);
      return entry;
    }
    const want = FITS[entry.type] || null;
    if (!await searchRoblox(id, entry, info, want)) {
      if (entry.type === 'Image') await searchThumbnail(id, entry, thumb);
      entry.captures = await searchWayback(id, entry, want);
      entry.reuploads = await searchCreator(id, entry, info, want);
    }
    entry.state = 'done';
  } catch (error) {
    entry.state = 'failed';
    entry.error = error && error.message ? error.message : String(error);
  } finally {
    entry.searchedAt = core.isoDate();
    saveSoon();
  }
  return entry;
}

function dropPending(id, entry) {
  for (const item of entry.found.filter((found) => found.status === 'pending')) {
    try { fs.unlinkSync(fileOf(id, item)); } catch (error) { /* gone */ }
  }
  entry.found = entry.found.filter((found) => found.status !== 'pending');
}

// --- the queue -----------------------------------------------------------------------------

const queue = [];
let running = null;
let started = false;

const pendingOf = (entry) => entry.found.filter((item) => item.status === 'pending').length;

// Sounds and images first: they are the likeliest to have been captured or
// uploaded again. Animations were rarely public.
const TYPE_ORDER = ['Audio', 'Image', 'Decal', 'Model'];
const typeRank = (type) => { const index = TYPE_ORDER.indexOf(type); return index < 0 ? TYPE_ORDER.length : index; };

// Missing assets nobody has replaced that are due for a search.
function refill() {
  const all = load().assets;
  let list;
  try { list = missingassets.list(); } catch (error) { return; }
  list.sort((a, b) => typeRank(a.type) - typeRank(b.type));
  const now = Date.now();
  for (const asset of list) {
    if (asset.replaced || queue.includes(asset.id) || running === asset.id) continue;
    const entry = all[asset.id];
    const age = entry && entry.searchedAt ? now - Date.parse(entry.searchedAt) : Infinity;
    const due = !entry || entry.state === 'new' || entry.state === 'queued'
      || (entry.state === 'failed' && age > RETRY_FAILED_HOURS * 3600 * 1000)
      || (entry.state === 'done' && !pendingOf(entry) && !entry.found.some((item) => item.status === 'approved') && age > RESEARCH_EMPTY_DAYS * 86400 * 1000);
    if (!due) continue;
    entryOf(asset.id).state = 'queued';
    queue.push(asset.id);
  }
  saveSoon();
}

async function pump() {
  if (running !== null || load().paused) return;
  const id = queue.shift();
  if (id === undefined) return;
  running = id;
  try {
    await search(id);
  } finally {
    running = null;
    const timer = setTimeout(pump, 1000);
    if (timer.unref) timer.unref();
  }
}

// Starts the background search (the web server calls it once).
function start() {
  if (started) return;
  started = true;
  const first = setTimeout(() => { refill(); pump(); }, 15000);
  if (first.unref) first.unref();
  const timer = setInterval(() => { refill(); pump(); }, REFILL_MS);
  if (timer.unref) timer.unref();
}

// Searches one asset next (again, if it was searched before).
function searchNow(id) {
  id = String(id);
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
  if (running !== id) {
    entryOf(id).state = 'queued';
    queue.unshift(id);
    saveSoon();
  }
  pump();
}

function setPaused(paused) {
  load().paused = Boolean(paused);
  save();
  if (!paused) { refill(); pump(); }
}

// --- decisions -----------------------------------------------------------------------------

// -> { file } (the new replacement) or { error }
function approve(id, n) {
  const entry = load().assets[id];
  const item = entry && entry.found.find((found) => found.n === Number(n));
  if (!item || item.status !== 'pending') return { error: 'That copy is no longer waiting.' };
  let bytes;
  try { bytes = fs.readFileSync(fileOf(id, item)); } catch (error) { return { error: 'The found file is gone. Search again.' }; }
  const saved = missingassets.saveReplacement(id, bytes);
  if (saved.error) return saved;
  item.status = 'approved';
  item.decidedAt = core.isoDate();
  try { fs.unlinkSync(fileOf(id, item)); } catch (error) { /* copied already */ }
  // The rest are moot now.
  for (const other of entry.found.filter((found) => found.status === 'pending')) {
    try { fs.unlinkSync(fileOf(id, other)); } catch (error) { /* gone */ }
  }
  entry.found = entry.found.filter((found) => found.status !== 'pending');
  save();
  return saved;
}

function reject(id, n) {
  const entry = load().assets[id];
  const item = entry && entry.found.find((found) => found.n === Number(n));
  if (!item || item.status !== 'pending') return false;
  try { fs.unlinkSync(fileOf(id, item)); } catch (error) { /* gone */ }
  entry.rejected.push(item.sha1);
  entry.found = entry.found.filter((found) => found !== item);
  save();
  return true;
}

// The found file, for a preview -> absolute path or null.
function filePath(id, n) {
  const entry = load().assets[id];
  const item = entry && entry.found.find((found) => found.n === Number(n) && found.status === 'pending');
  return item ? fileOf(id, item) : null;
}

// --- views ---------------------------------------------------------------------------------

// Every searched asset: { paused, running, queued, assets: { id: {...} } }
function status() {
  const all = load().assets;
  const out = {};
  for (const [id, entry] of Object.entries(all)) {
    out[id] = {
      state: running === id ? 'searching' : entry.state,
      searchedAt: entry.searchedAt || null,
      skipped: entry.skipped || null,
      error: entry.error || null,
      captures: entry.captures || 0,
      reuploads: entry.reuploads || 0,
      found: entry.found.map(({ n, ext, size, source, label, link, date, status: itemStatus, name, match, assetId, decidedAt }) => (
        { n, ext, size, source, label, link, date, status: itemStatus, name, match, assetId, decidedAt })),
    };
  }
  return { paused: load().paused, running, queued: queue.length, assets: out };
}

function summary() {
  const all = Object.values(load().assets);
  return {
    paused: load().paused,
    running,
    queued: queue.length,
    searched: all.filter((entry) => entry.state === 'done' || entry.state === 'skipped').length,
    pending: all.reduce((sum, entry) => sum + pendingOf(entry), 0),
  };
}

module.exports = { start, search, searchNow, setPaused, approve, reject, filePath, status, summary, decalTexture, normalName };
