'use strict';

// What players own: assets and game passes they "bought" in a game's
// purchase prompt (free, lib/marketplace.js), in data/ownership.json:
//   { "<userId>": { "<assetId or pass id>": iso } }
// Developer products are bought again and again and are not kept here.
// What a player's avatar wears (lib/avatarstore.js) counts as owned too.
// Guests (negative IDs) own nothing.

const fs = require('fs');
const path = require('path');
const core = require('./core');
const avatarStore = require('./avatarstore');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'ownership.json');

const id = (value) => (/^\d{1,15}$/.test(String(value)) && Number(value) > 0 ? String(Number(value)) : null);

function load() {
  const data = core.readJsonFile(FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function wears(user, item) {
  const avatar = avatarStore.get(user);
  return Boolean(avatar && avatar.assets.some((asset) => asset.id === item));
}

function owns(userId, assetId) {
  const user = id(userId);
  const item = id(assetId);
  if (!user || !item) return false;
  const owned = load()[user];
  return Boolean(owned && typeof owned === 'object' && owned[item]) || wears(user, item);
}

// -> true when the item is new for the player.
function grant(userId, assetId) {
  const user = id(userId);
  const item = id(assetId);
  if (!user || !item) return false;
  const data = load();
  if (!data[user] || typeof data[user] !== 'object') data[user] = {};
  if (data[user][item]) return false;
  data[user][item] = core.isoDate();
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save what players own');
  return true;
}

// Packages (Roblox bundles) bought in the Xbox app's avatar store, kept as
// "bundle:<id>" next to the assets.
const bundleKey = (bundleId) => (id(bundleId) ? `bundle:${id(bundleId)}` : null);

function ownsBundle(userId, bundleId) {
  const user = id(userId);
  const key = bundleKey(bundleId);
  const owned = user && key ? load()[user] : null;
  return Boolean(owned && typeof owned === 'object' && owned[key]);
}

// -> true when the package is new for the player.
function grantBundle(userId, bundleId) {
  const user = id(userId);
  const key = bundleKey(bundleId);
  if (!user || !key) return false;
  const data = load();
  if (!data[user] || typeof data[user] !== 'object') data[user] = {};
  if (data[user][key]) return false;
  data[user][key] = core.isoDate();
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save what players own');
  return true;
}

// -> the package IDs a player owns, newest first.
function bundleIds(userId) {
  const user = id(userId);
  const owned = user ? load()[user] : null;
  if (!owned || typeof owned !== 'object') return [];
  return Object.entries(owned)
    .filter(([key]) => key.startsWith('bundle:'))
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .map(([key]) => key.slice('bundle:'.length));
}

// -> [{ id, at }] the asset (and pass) IDs a player owns, newest first.
function assetIds(userId) {
  const user = id(userId);
  const owned = user ? load()[user] : null;
  if (!owned || typeof owned !== 'object') return [];
  return Object.entries(owned)
    .filter(([key]) => /^\d+$/.test(key))
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .map(([key, at]) => ({ id: key, at: String(at) }));
}

// Grants many assets at once (one write) and, with mark, notes that this was
// done ("_<mark>": date), so it is done once. -> how many were new.
function grantAll(userId, assetIdList, mark) {
  const user = id(userId);
  if (!user) return 0;
  const data = load();
  if (!data[user] || typeof data[user] !== 'object') data[user] = {};
  if (mark && data[user][`_${mark}`]) return 0;
  let added = 0;
  const at = core.isoDate();
  for (const assetId of assetIdList) {
    const item = id(assetId);
    if (item && !data[user][item]) { data[user][item] = at; added++; }
  }
  if (mark) data[user][`_${mark}`] = at;
  if (added === 0 && !mark) return 0;
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save what players own');
  return added;
}

function marked(userId, mark) {
  const user = id(userId);
  const owned = user ? load()[user] : null;
  return Boolean(owned && typeof owned === 'object' && owned[`_${mark}`]);
}

module.exports = { owns, grant, grantAll, marked, assetIds, ownsBundle, grantBundle, bundleIds };
