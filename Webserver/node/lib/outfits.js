'use strict';

// Saved avatars ("outfits") of this server's accounts, made in the launcher's
// Avatar tab: what was worn when it was saved, under a name, with the picture
// the launcher drew of it. Wearing one makes it the account's avatar again.
//
//   data/outfits.json                         { "<userId>": [{ id, name, bodyColors, assets, createdAt }] }
//   data/outfit-images/<userId>-<id>.png      the picture

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'outfits.json');
const IMAGES = path.join(DATA, 'outfit-images');
const MAX_OUTFITS = 30;
const MAX_NAME = 40;
const MAX_IMAGE_BYTES = 1536 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function load() {
  const data = core.readJsonFile(FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 1)}\n`)) throw new Error('could not save outfits');
}

const validId = (id) => /^[0-9a-f]{12}$/.test(String(id || ''));
const validUser = (userId) => /^\d{1,15}$/.test(String(userId || ''));

function imagePath(userId, id) {
  return validUser(userId) && validId(id) ? path.join(IMAGES, `${userId}-${id}.png`) : null;
}

function describe(userId, outfit) {
  const file = imagePath(userId, outfit.id);
  return {
    id: outfit.id,
    name: outfit.name,
    bodyColors: outfit.bodyColors,
    assets: outfit.assets,
    createdAt: outfit.createdAt,
    hasImage: Boolean(file && fs.existsSync(file)),
  };
}

function list(userId) {
  const mine = load()[String(userId)];
  return Array.isArray(mine) ? mine.map((outfit) => describe(userId, outfit)) : [];
}

function get(userId, id) {
  const mine = load()[String(userId)];
  const outfit = Array.isArray(mine) ? mine.find((entry) => entry.id === String(id)) : null;
  return outfit ? describe(userId, outfit) : null;
}

function cleanName(name, fallback) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) || fallback;
}

// avatar: { bodyColors, assets: [{ id, typeId, name }] } (already checked);
// image: PNG bytes or null -> { outfit } or { error }
function add(userId, { name, avatar, image }) {
  if (!validUser(userId)) return { error: 'Guests cannot save outfits.' };
  const data = load();
  const mine = Array.isArray(data[String(userId)]) ? data[String(userId)] : [];
  if (mine.length >= MAX_OUTFITS) return { error: `You have ${MAX_OUTFITS} outfits already. Delete one first.` };
  if (image && (!Buffer.isBuffer(image) || image.length > MAX_IMAGE_BYTES || !image.subarray(0, 8).equals(PNG))) {
    return { error: 'The outfit picture must be a PNG under 1.5 MB.' };
  }
  const outfit = {
    id: crypto.randomBytes(6).toString('hex'),
    name: cleanName(name, `Outfit ${mine.length + 1}`),
    bodyColors: avatar.bodyColors,
    assets: avatar.assets.map((asset) => ({ id: String(asset.id), typeId: Number(asset.typeId) || 0, name: String(asset.name || '') })),
    createdAt: new Date().toISOString(),
  };
  if (image) {
    fs.mkdirSync(IMAGES, { recursive: true });
    core.writeFileAtomic(imagePath(userId, outfit.id), image);
  }
  mine.unshift(outfit);
  data[String(userId)] = mine;
  save(data);
  return { outfit: describe(userId, outfit) };
}

function rename(userId, id, name) {
  const data = load();
  const mine = Array.isArray(data[String(userId)]) ? data[String(userId)] : [];
  const outfit = mine.find((entry) => entry.id === String(id));
  if (!outfit) return null;
  outfit.name = cleanName(name, outfit.name);
  save(data);
  return describe(userId, outfit);
}

function remove(userId, id) {
  const data = load();
  const mine = Array.isArray(data[String(userId)]) ? data[String(userId)] : [];
  const index = mine.findIndex((entry) => entry.id === String(id));
  if (index < 0) return false;
  mine.splice(index, 1);
  data[String(userId)] = mine;
  save(data);
  const file = imagePath(userId, id);
  if (file) {
    try { fs.rmSync(file, { force: true }); } catch (error) { /* gone later */ }
  }
  return true;
}

module.exports = { list, get, add, rename, remove, imagePath, MAX_OUTFITS };
