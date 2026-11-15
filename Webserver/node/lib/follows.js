'use strict';

// One-way follows between this server's accounts (data/follows.json):
//   { "follows": [{ "from": id, "to": id, "at": iso }] }
// Following someone needs no answer from them, unlike a friend request
// (lib/friends.js). Shown on launcher profiles (lib/launcherapi.js).

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'follows.json');
const MAX_FOLLOWING = 500;

function load() {
  const data = core.readJsonFile(FILE);
  const follows = data && Array.isArray(data.follows) ? data.follows : [];
  return {
    follows: follows.filter((entry) => entry && Number(entry.from) > 0 && Number(entry.to) > 0 && Number(entry.from) !== Number(entry.to))
      .map((entry) => ({ from: Number(entry.from), to: Number(entry.to), at: entry.at || core.isoDate() })),
  };
}

function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save follows');
}

const valid = (id) => Number.isInteger(Number(id)) && Number(id) > 0;

function following(userId, data = load()) {
  return data.follows.filter((entry) => entry.from === Number(userId)).map((entry) => entry.to);
}

function followers(userId, data = load()) {
  return data.follows.filter((entry) => entry.to === Number(userId)).map((entry) => entry.from);
}

function isFollowing(from, to, data = load()) {
  return data.follows.some((entry) => entry.from === Number(from) && entry.to === Number(to));
}

// -> { ok } or { error }
function follow(from, to) {
  if (!valid(from) || !valid(to)) return { error: 'Guests cannot follow anyone.' };
  if (Number(from) === Number(to)) return { error: "You can't follow yourself." };
  if (require('./blocks').between(from, to)) return { error: "You can't follow this player." };
  const data = load();
  if (isFollowing(from, to, data)) return { ok: true };
  if (following(from, data).length >= MAX_FOLLOWING) return { error: `You can follow up to ${MAX_FOLLOWING} players.` };
  data.follows.push({ from: Number(from), to: Number(to), at: core.isoDate() });
  save(data);
  return { ok: true };
}

function unfollow(from, to) {
  const data = load();
  const before = data.follows.length;
  data.follows = data.follows.filter((entry) => !(entry.from === Number(from) && entry.to === Number(to)));
  if (data.follows.length !== before) save(data);
  return { ok: true };
}

// A deleted account's follows go with it (lib/accounts.js remove).
function forget(userId) {
  const data = load();
  const before = data.follows.length;
  data.follows = data.follows.filter((entry) => entry.from !== Number(userId) && entry.to !== Number(userId));
  if (data.follows.length !== before) save(data);
}

module.exports = { MAX_FOLLOWING, following, followers, isFollowing, follow, unfollow, forget, load };
