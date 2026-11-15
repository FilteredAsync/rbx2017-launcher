'use strict';

// Blocked players (data/blocks.json): { "blocks": [{ "from": id, "to": id, "at": iso }] }
// Blocking someone ends the friendship and follows both ways, drops friend
// requests, and stops new ones (lib/friends.js, lib/follows.js check here).
// Blocked in game (the 2017 player list's Block, posted by RCC:
// userblock/blockuser) or from a launcher profile (lib/launcherapi.js).

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'blocks.json');
const MAX_BLOCKS = 500;

function load() {
  const data = core.readJsonFile(FILE);
  const blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
  return {
    blocks: blocks.filter((entry) => entry && Number(entry.from) > 0 && Number(entry.to) > 0 && Number(entry.from) !== Number(entry.to))
      .map((entry) => ({ from: Number(entry.from), to: Number(entry.to), at: entry.at || core.isoDate() })),
  };
}

function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save blocks');
}

// Who userId has blocked.
function blockedBy(userId, data = load()) {
  return data.blocks.filter((entry) => entry.from === Number(userId)).map((entry) => entry.to);
}

function hasBlocked(from, to, data = load()) {
  return data.blocks.some((entry) => entry.from === Number(from) && entry.to === Number(to));
}

// Either one blocked the other.
function between(a, b, data = load()) {
  return hasBlocked(a, b, data) || hasBlocked(b, a, data);
}

// -> { ok } or { error }
function block(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!(a > 0) || !(b > 0)) return { error: 'Guests cannot block anyone.' };
  if (a === b) return { error: "You can't block yourself." };
  const data = load();
  if (!hasBlocked(a, b, data)) {
    if (blockedBy(a, data).length >= MAX_BLOCKS) return { error: `You can block up to ${MAX_BLOCKS} players.` };
    data.blocks.push({ from: a, to: b, at: core.isoDate() });
    save(data);
  }
  // No friendship, follows or requests survive a block.
  const friends = require('./friends');
  const follows = require('./follows');
  friends.unfriend(a, b);
  friends.dropRequest(a, b);
  friends.dropRequest(b, a);
  follows.unfollow(a, b);
  follows.unfollow(b, a);
  return { ok: true };
}

function unblock(from, to) {
  const data = load();
  const before = data.blocks.length;
  data.blocks = data.blocks.filter((entry) => !(entry.from === Number(from) && entry.to === Number(to)));
  if (data.blocks.length !== before) save(data);
  return { ok: true };
}

// A deleted account's blocks go with it (lib/accounts.js remove).
function forget(userId) {
  const data = load();
  const before = data.blocks.length;
  data.blocks = data.blocks.filter((entry) => entry.from !== Number(userId) && entry.to !== Number(userId));
  if (data.blocks.length !== before) save(data);
}

module.exports = { MAX_BLOCKS, blockedBy, hasBlocked, between, block, unblock, forget };
