'use strict';

// Favorite games, in data/favorites.json:
//   { "<userId>": ["<placeId>", ...] }   newest first
// Accounts only (guests have negative IDs). The Xbox app's heart button and
// its "My Favorites" row use it.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'favorites.json');
const MAX_PER_USER = 500;

const id = (value) => (/^\d{1,15}$/.test(String(value)) && Number(value) > 0 ? String(Number(value)) : null);

function load() {
  const data = core.readJsonFile(FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

// -> the place IDs userId favorited, newest first.
function list(userId, data = load()) {
  const user = id(userId);
  const places = user && Array.isArray(data[user]) ? data[user] : [];
  return places.filter((place) => id(place));
}

function isFavorite(placeId, userId, data = load()) {
  const place = id(placeId);
  return Boolean(place) && list(userId, data).includes(place);
}

// -> how many accounts favorited placeId.
function count(placeId, data = load()) {
  const place = id(placeId);
  if (!place) return 0;
  let total = 0;
  for (const places of Object.values(data)) if (Array.isArray(places) && places.includes(place)) total++;
  return total;
}

// Favorite or unfavorite. -> true when it is now a favorite.
function toggle(placeId, userId) {
  const place = id(placeId);
  const user = id(userId);
  if (!place || !user) throw new Error('bad favorite');
  const data = load();
  const places = list(user, data);
  const now = !places.includes(place);
  const next = now ? [place, ...places].slice(0, MAX_PER_USER) : places.filter((entry) => entry !== place);
  if (next.length > 0) data[user] = next;
  else delete data[user];
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save favorites');
  return now;
}

module.exports = { list, isFavorite, count, toggle };
