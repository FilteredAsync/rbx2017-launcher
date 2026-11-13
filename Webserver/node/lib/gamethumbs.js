'use strict';

// Custom game thumbnails: one picture per place ID, shown on the game's tile
// in every player's launcher. Hosts upload them from the launcher's Host tab
// (with the host key, like listing a game); they are kept in
// Webserver/node/data/thumbnails and survive restarts.
//
//   GET    /api/thumbnails/<placeId>   the picture
//   POST   /api/thumbnails/<placeId>   body: the image file; X-Host-Key header
//   DELETE /api/thumbnails/<placeId>   X-Host-Key header
// /api/games lists each game's "thumbnail" (a version number, or null).

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DIR = core.rootPath('Webserver', 'node', 'data', 'thumbnails');
const MAX_BYTES = 4 * 1024 * 1024;

// Recognized by their first bytes, never by a file name.
const TYPES = [
  { ext: 'png', type: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', type: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

function placeKey(placeId) {
  const id = core.decimal(String(placeId === undefined || placeId === null ? '' : placeId));
  return id !== null && id !== '0' && id.length <= 15 ? id : null;
}

// -> { file, type, version } or null
function get(placeId) {
  const id = placeKey(placeId);
  if (id === null) return null;
  for (const t of TYPES) {
    const file = path.join(DIR, `${id}.${t.ext}`);
    if (core.isFile(file)) return { file, type: t.type, version: Math.round(core.mtimeMs(file)) };
  }
  return null;
}

function version(placeId) {
  const found = get(placeId);
  return found ? found.version : null;
}

function remove(placeId) {
  const id = placeKey(placeId);
  if (id === null) return false;
  let removed = false;
  for (const t of TYPES) {
    try { fs.unlinkSync(path.join(DIR, `${id}.${t.ext}`)); removed = true; } catch (error) { /* none of this type */ }
  }
  return removed;
}

// -> { version } or { error }
function save(placeId, bytes) {
  const id = placeKey(placeId);
  if (id === null) return { error: 'the place ID must be a number' };
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { error: 'no image was sent' };
  if (bytes.length > MAX_BYTES) return { error: 'the image is larger than 4 MB' };
  const type = TYPES.find((t) => t.test(bytes));
  if (!type) return { error: 'use a PNG, JPEG, GIF or WebP image' };
  fs.mkdirSync(DIR, { recursive: true });
  remove(id);
  const file = path.join(DIR, `${id}.${type.ext}`);
  if (!core.writeFileAtomic(file, bytes)) return { error: 'could not save the image on the web server' };
  return { version: Math.round(core.mtimeMs(file)) };
}

module.exports = { get, version, save, remove, MAX_BYTES };
