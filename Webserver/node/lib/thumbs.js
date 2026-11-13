'use strict';

// Thumbnail images behind the 2017 engine's old thumbnail addresses:
//   /Game/Tools/ThumbnailAsset.ashx?fmt=png&wd=420&ht=420&aid=123   pictures in places
//                                                                    (Lumber Tycoon 2's shop items)
//   /Thumbs/Asset.ashx?width=420&height=420&assetId=123
//   /Thumbs/Avatar.ashx?x=100&y=100&userId=123                      settings menu, friend prompts
//   /Thumbs/HeadShot.ashx?x=48&y=48&userId=123
//   /asset-thumbnail/image, /avatar-thumbnail/image, /headshot-thumbnail/image
// Roblox retired these; each is answered with a PNG from thumbnails.roblox.com,
// kept in cache/thumbs so it is fetched once.

const fs = require('fs');
const path = require('path');
const core = require('./core');
const assets = require('./assets');

// The sizes thumbnails.roblox.com accepts for each kind.
const SIZES = {
  asset: ['30x30', '42x42', '50x50', '60x62', '75x75', '110x110', '140x140', '150x150', '160x100', '160x600', '250x250',
    '256x144', '300x250', '304x166', '384x216', '396x216', '420x420', '480x270', '512x512', '576x324', '700x700', '728x90', '768x432'],
  avatar: ['30x30', '48x48', '60x60', '75x75', '100x100', '110x110', '140x140', '150x150', '150x200', '180x180', '250x250',
    '352x352', '420x420', '720x720'],
  headshot: ['48x48', '50x50', '60x60', '75x75', '100x100', '110x110', '150x150', '180x180', '352x352', '420x420', '720x720'],
  bundle: ['150x150', '420x420'],
};

const ENDPOINTS = {
  asset: 'https://thumbnails.roblox.com/v1/assets?assetIds=%ID%&returnPolicy=PlaceHolder&size=%SIZE%&format=Png&isCircular=false',
  avatar: 'https://thumbnails.roblox.com/v1/users/avatar?userIds=%ID%&size=%SIZE%&format=Png&isCircular=false',
  headshot: 'https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=%ID%&size=%SIZE%&format=Png&isCircular=false',
  // Packages in the launcher's avatar editor.
  bundle: 'https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=%ID%&size=%SIZE%&format=Png&isCircular=false',
};

// The requested size if Roblox offers it, else the smallest square at least
// as large, else the largest square.
function pickSize(kind, width, height) {
  const sizes = SIZES[kind];
  const wanted = `${width}x${height}`;
  if (sizes.includes(wanted)) return wanted;
  const squares = sizes.filter((size) => { const [w, h] = size.split('x'); return w === h; })
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const edge = Math.max(width || 0, height || 0) || 420;
  return squares.find((size) => parseInt(size, 10) >= edge) || squares[squares.length - 1];
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const inflight = new Map();

// A place like Lumber Tycoon 2 asks for ~140 shop pictures the moment a
// player joins; all at once, some CDN downloads time out. Six at a time.
const MAX_PARALLEL = 6;
let running = 0;
const waiting = [];
async function limited(task) {
  if (running >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

async function fetchImage(url) {
  let image = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    image = await assets.httpGet(url, {}, 20000);
    if (image.status === 200 && image.body.length >= 8 && image.body.subarray(0, 4).equals(PNG)) return image;
    if (image.status >= 400 && image.status < 500) break;
  }
  return image;
}

async function download(kind, id, size) {
  const url = ENDPOINTS[kind].replace('%ID%', id).replace('%SIZE%', size);
  // Roblox renders a thumbnail nobody asked for recently on demand: the first
  // answer is often "Pending" and a second or two later "Completed".
  let entry = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    const data = await assets.httpGetJson(url, 15000);
    entry = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!entry || entry.state !== 'Pending') break;
  }
  if (!entry) return { ok: false, status: 0, reason: 'thumbnails.roblox.com did not answer' };
  if (entry.state === 'Pending' || entry.state === 'InReview') return { ok: false, status: 0, reason: `thumbnail ${entry.state.toLowerCase()}` };
  if (typeof entry.imageUrl !== 'string' || !/^https:\/\//i.test(entry.imageUrl)) {
    return { ok: false, status: 404, reason: `no thumbnail (${entry.state || 'unknown state'})` };
  }
  const image = await fetchImage(entry.imageUrl);
  if (image.status !== 200 || image.body.length < 8 || !image.body.subarray(0, 4).equals(PNG)) {
    return { ok: false, status: 0, reason: `image download failed (HTTP ${image.status}${image.error ? ` ${image.error}` : ''})` };
  }
  return { ok: true, bytes: image.body };
}

// -> { ok: true, bytes } or { ok: false, message }
async function thumbnail(kind, id, width, height) {
  const size = pickSize(kind, width, height);
  const file = path.join(core.cacheDir('thumbs'), `${kind}-${id}-${size}.png`);
  const missing = `${file}.missing`;
  try {
    if (fs.statSync(file).size > 0) return { ok: true, bytes: fs.readFileSync(file) };
  } catch (error) { /* not cached yet */ }

  // A thumbnail Roblox has none of is not asked for again for a day; a
  // network problem or a pending render is retried after a few minutes.
  if (core.isFile(missing)) {
    const marked = core.readJsonFile(missing);
    const ttl = marked && marked.status === 404 ? 86400000 : 60000;
    if (core.mtimeMs(missing) >= Date.now() - ttl) return { ok: false, message: `no thumbnail: ${marked && marked.reason}` };
    try { fs.unlinkSync(missing); } catch (error) { /* raced */ }
  }

  const key = `${kind}-${id}-${size}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = limited(() => download(kind, id, size)).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const result = await pending;
  if (!result.ok) {
    core.assetLog(`${kind} thumbnail ${id} (${size}): ${result.reason}`);
    try { fs.writeFileSync(missing, JSON.stringify({ status: result.status, reason: result.reason, at: core.isoDate() })); } catch (error) { /* ignore */ }
    return { ok: false, message: `no thumbnail: ${result.reason}` };
  }
  core.writeFileAtomic(file, result.bytes);
  return { ok: true, bytes: result.bytes };
}

module.exports = { thumbnail, pickSize };
