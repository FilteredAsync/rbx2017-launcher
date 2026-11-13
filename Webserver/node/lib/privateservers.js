'use strict';

// Private servers (data/private-servers.json): a server of a library game
// that only some players may join, started when one of them joins and
// stopped again when it has been empty for a while (dedicated.js).
//   { "servers": { "<id>": { id, placeId, name, ownerId, code, friends, members: [userId], createdAt } } }
// Who may join: the owner, the owner's friends (when "friends" is on) and
// anyone who entered its invite code (they become members). Guests never.
// The launcher manages them (lib/launcherapi.js), /manage can delete them.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const friends = require('./friends');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'private-servers.json');
const MAX_PER_OWNER = 5;
const MAX_MEMBERS = 50;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

function load() {
  const data = core.readJsonFile(FILE);
  const servers = {};
  if (data && data.servers && typeof data.servers === 'object') {
    for (const [id, server] of Object.entries(data.servers)) {
      if (!/^[0-9a-f]{12}$/.test(id) || !server || !(Number(server.ownerId) > 0)) continue;
      servers[id] = {
        id,
        placeId: String(server.placeId || ''),
        name: cleanName(server.name),
        ownerId: Number(server.ownerId),
        code: /^[A-Z2-9]{8}$/.test(String(server.code || '')) ? server.code : newCode(),
        friends: server.friends !== false,
        members: Array.isArray(server.members) ? server.members.map(Number).filter((n) => n > 0) : [],
        createdAt: server.createdAt || core.isoDate(),
      };
    }
  }
  return { servers };
}

function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save private servers');
}

function cleanName(text) {
  const name = String(text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
  return name === '' ? 'Private server' : name;
}

function newCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
  return code;
}

function get(id) {
  return /^[0-9a-f]{12}$/.test(String(id || '')) ? load().servers[id] || null : null;
}

function list() {
  return Object.values(load().servers);
}

function canJoin(server, userId) {
  const id = Number(userId);
  if (!server || !(id > 0)) return false;
  if (server.ownerId === id || server.members.includes(id)) return true;
  return server.friends && friends.areFriends(server.ownerId, id);
}

// The ones a player may join, theirs first.
function visibleTo(userId, placeId = null) {
  const id = Number(userId);
  return list()
    .filter((server) => (placeId === null || server.placeId === String(placeId)) && canJoin(server, id))
    .sort((a, b) => (b.ownerId === id) - (a.ownerId === id) || a.name.localeCompare(b.name));
}

function create(owner, placeId, name) {
  const data = load();
  const mine = Object.values(data.servers).filter((server) => server.ownerId === Number(owner.userId));
  if (mine.length >= MAX_PER_OWNER) return { error: `You can have up to ${MAX_PER_OWNER} private servers. Delete one first.` };
  let id;
  do { id = crypto.randomBytes(6).toString('hex'); } while (data.servers[id]);
  const server = {
    id, placeId: String(placeId), name: cleanName(name), ownerId: Number(owner.userId),
    code: newCode(), friends: true, members: [], createdAt: core.isoDate(),
  };
  data.servers[id] = server;
  save(data);
  return { server };
}

// Changes one server: work(server) returns an error text or nothing.
function change(id, work) {
  const data = load();
  const server = data.servers[id];
  if (!server) return { error: 'That private server no longer exists.' };
  const error = work(server, data);
  if (error) return { error };
  save(data);
  return { server: data.servers[id] || null };
}

const rename = (id, name) => change(id, (server) => { server.name = cleanName(name); });
const setFriends = (id, on) => change(id, (server) => { server.friends = Boolean(on); });
const resetCode = (id) => change(id, (server) => { server.code = newCode(); });
const remove = (id) => change(id, (server, data) => { delete data.servers[server.id]; });
const leave = (id, userId) => change(id, (server) => { server.members = server.members.filter((member) => member !== Number(userId)); });

// An invite code: the player becomes a member (and may join from then on).
function redeem(code, userId) {
  const text = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const found = list().find((server) => server.code === text);
  if (!found) return { error: 'No private server has that code. Check it, or ask for a new one.' };
  if (found.ownerId === Number(userId) || found.members.includes(Number(userId))) return { server: found };
  return change(found.id, (server) => {
    if (server.members.length >= MAX_MEMBERS) return `"${server.name}" already has ${MAX_MEMBERS} members.`;
    server.members.push(Number(userId));
    return null;
  });
}

// A deleted account's servers go too; it leaves the others.
function forget(userId) {
  const data = load();
  const id = Number(userId);
  let changed = false;
  for (const server of Object.values(data.servers)) {
    if (server.ownerId === id) { delete data.servers[server.id]; changed = true; continue; }
    if (server.members.includes(id)) { server.members = server.members.filter((member) => member !== id); changed = true; }
  }
  if (changed) save(data);
}

module.exports = {
  get, list, canJoin, visibleTo, create, rename, setFriends, resetCode, remove, leave, redeem, forget,
  FILE, MAX_PER_OWNER,
};
