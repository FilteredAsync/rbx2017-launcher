'use strict';

// Avatars of this server's accounts, made in the launcher's avatar editor.
//
//   data/avatars.json              { "<userId>": { bodyColors, assets, source, updatedAt } }
//   data/avatar-images/<id>.png    the picture the launcher draws of each avatar,
//                                  shown in the launcher and in games' menus
//
// An account without a saved avatar gets a copy of what the Roblox account
// with the same name wears (lib/avatar.js does the copying). Guests
// (negative user IDs) wear the 2016 guest look, or "guestAppearance" from
// config/assets.json.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'avatars.json');
const IMAGES = path.join(DATA, 'avatar-images');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_KEYS = ['HeadColor', 'TorsoColor', 'LeftArmColor', 'RightArmColor', 'LeftLegColor', 'RightLegColor'];

// From September 2016 guests wore the Robloxian 2.0 body and the ROBLOX 'R'
// Baseball Cap.
const GUEST_DEFAULT = {
  bodyColors: { HeadColor: 24, TorsoColor: 23, LeftArmColor: 24, RightArmColor: 24, LeftLegColor: 119, RightLegColor: 119 },
  assets: [
    { id: '417457461', typeId: 8, name: "ROBLOX 'R' Baseball Cap" },
    { id: '27112025', typeId: 27, name: 'Roblox 2.0 Torso' },
    { id: '27112039', typeId: 28, name: 'Roblox 2.0 Right Arm' },
    { id: '27112052', typeId: 29, name: 'Roblox 2.0 Left Arm' },
    { id: '27112056', typeId: 30, name: 'Roblox 2.0 Left Leg' },
    { id: '27112068', typeId: 31, name: 'Roblox 2.0 Right Leg' },
  ],
};

function load() {
  const data = core.readJsonFile(FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function cleanColors(colors, fallback) {
  const result = {};
  for (const key of COLOR_KEYS) {
    const value = colors && Number(colors[key]);
    result[key] = Number.isInteger(value) && value >= 0 && value < 2000 ? value : fallback[key];
  }
  return result;
}

function cleanAssets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((asset) => ({ id: core.decimal(String(asset && asset.id)), typeId: Math.trunc(Number(asset && asset.typeId)) || 0, name: String((asset && asset.name) || '').slice(0, 100) }))
    .filter((asset) => asset.id !== null && asset.id !== '0' && asset.typeId > 0);
}

function get(userId) {
  const entry = load()[String(userId)];
  if (!entry) return null;
  return {
    bodyColors: cleanColors(entry.bodyColors, GUEST_DEFAULT.bodyColors),
    assets: cleanAssets(entry.assets),
    source: entry.source || 'edited',
    updatedAt: entry.updatedAt || null,
  };
}

function set(userId, avatar, source = 'edited') {
  const data = load();
  data[String(userId)] = {
    bodyColors: cleanColors(avatar.bodyColors, GUEST_DEFAULT.bodyColors),
    assets: cleanAssets(avatar.assets),
    source,
    updatedAt: core.isoDate(),
  };
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save the avatar');
  return get(userId);
}

function guest() {
  const configured = core.assetConfig().guestAppearance;
  const source = configured && typeof configured === 'object' ? configured : GUEST_DEFAULT;
  return { bodyColors: cleanColors(source.bodyColors, GUEST_DEFAULT.bodyColors), assets: cleanAssets(source.assets || GUEST_DEFAULT.assets), source: 'guest' };
}

function isGuestId(userId) {
  return /^-\d{1,9}$/.test(String(userId));
}

// --- pictures ------------------------------------------------------------------------

function imagePath(userId) {
  const id = String(userId);
  return /^-?\d{1,15}$/.test(id) ? path.join(IMAGES, `${id}.png`) : null;
}

// The saved picture for a player of this server, or null. Guests share one
// ("guest.png", saved by any launcher that drew the guest look).
function imageFor(userId) {
  const file = isGuestId(userId) ? path.join(IMAGES, 'guest.png') : imagePath(userId);
  if (!file) return null;
  try {
    return fs.readFileSync(file);
  } catch (error) {
    return null;
  }
}

function saveImage(userId, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < PNG.length || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG)) {
    return { error: 'the picture must be a PNG under 2 MB' };
  }
  const file = userId === 'guest' ? path.join(IMAGES, 'guest.png') : imagePath(userId);
  if (!file) return { error: 'bad user ID' };
  fs.mkdirSync(IMAGES, { recursive: true });
  if (!core.writeFileAtomic(file, bytes)) return { error: 'could not save the picture' };
  return { ok: true };
}

module.exports = { get, set, guest, isGuestId, imageFor, saveImage, COLOR_KEYS, GUEST_DEFAULT };
