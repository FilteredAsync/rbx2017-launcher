'use strict';

// Badges games award (BadgeService:AwardBadge), in data/badges.json:
//   { "<userId>": { "<badgeId>": iso } }
// Badge IDs are the game's own (its Roblox ones). Guests (negative IDs) get none.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'badges.json');

const id = (value) => (/^\d{1,15}$/.test(String(value)) && Number(value) > 0 ? String(Number(value)) : null);

function load() {
  const data = core.readJsonFile(FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function has(userId, badgeId) {
  const user = id(userId);
  const badge = id(badgeId);
  if (!user || !badge) return false;
  const owned = load()[user];
  return Boolean(owned && typeof owned === 'object' && owned[badge]);
}

// -> true when the badge is new for the player.
function award(userId, badgeId) {
  const user = id(userId);
  const badge = id(badgeId);
  if (!user || !badge) return false;
  const data = load();
  if (!data[user] || typeof data[user] !== 'object') data[user] = {};
  if (data[user][badge]) return false;
  data[user][badge] = core.isoDate();
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save badges');
  return true;
}

module.exports = { has, award };
