'use strict';

// Groups (data/groups.json, emblems in data/group-emblems/):
//   { "nextId": n, "groups": [{ id, name, description, owner, imported, public,
//     emblem: { file, at } | null, created, roles: [{ id, name, rank }],
//     members: [{ userId, roleId, joined }], requests: [{ userId, at }],
//     shout: { text, by, at } | null, wall: [{ id, from, text, at }], nextPostId }] }
//
// Players make groups for 100 R$ (owner = their user ID). The Roblox groups
// that made the imported games (Badimo for Jailbreak...) are copied in with
// their Roblox group ID, name, description, ranks and emblem, owned by
// "Website" (owner 0): server admins run those (lib/groupimport.js). New
// groups get IDs from 1500000000 on, above any Roblox group ID.
//
// Ranks are 1..255 as in Roblox: 255 is the owner's, 254 and up may accept
// requests, change ranks below their own, remove members, shout and delete
// wall posts. Games see these groups (IsInGroup/GetRankInGroup, lib/social.js;
// GroupService, lib/groupapi.js). Kept in memory after the first read; only
// this process writes the file.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'groups.json');
const EMBLEMS = path.join(DATA, 'group-emblems');
const FIRST_ID = 1500000000;
const COST = 100;
const MAX_OWNED = 10;
// How many groups a player can be in, by Builders Club tier (lib/membership.js).
const JOIN_LIMITS = { none: 10, BC: 20, TBC: 50, OBC: 100 };
const maxJoined = (userId) => {
  let tier = null;
  try { tier = require('./membership').tierOf(userId); } catch (error) { /* no memberships */ }
  return JOIN_LIMITS[tier || 'none'];
};
const MAX_ROLES = 10;
const MAX_NAME = 50;
const MAX_DESCRIPTION = 1000;
const MAX_SHOUT = 255;
const MAX_POST = 500;
const MAX_WALL = 300;
const MAX_EMBLEM = 1024 * 1024;
const MANAGER_RANK = 254;
const OWNER_RANK = 255;
const POST_RATE = { count: 5, perMs: 60 * 1000 };
const WEBSITE = 'Website';

let cache = null;
const posted = new Map(); // userId -> [times]

const isoNow = () => core.isoDate();
const oneLine = (text, max) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (text) => String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();

function cleanGroup(g) {
  const roles = (Array.isArray(g.roles) ? g.roles : [])
    .filter((r) => r && Number(r.id) > 0 && Number(r.rank) >= 1 && Number(r.rank) <= OWNER_RANK)
    .map((r) => ({ id: Number(r.id), name: oneLine(r.name, 50) || `Rank ${r.rank}`, rank: Number(r.rank) }));
  return {
    id: Number(g.id),
    name: oneLine(g.name, MAX_NAME + 20),
    description: String(g.description || ''),
    owner: Number(g.owner) || 0,
    imported: Boolean(g.imported),
    public: g.public !== false,
    emblem: g.emblem && g.emblem.file ? { file: String(g.emblem.file), at: g.emblem.at || isoNow() } : null,
    created: g.created || isoNow(),
    roles: roles.length ? roles : defaultRoles(),
    members: (Array.isArray(g.members) ? g.members : []).filter((m) => m && Number(m.userId) > 0)
      .map((m) => ({ userId: Number(m.userId), roleId: Number(m.roleId), joined: m.joined || isoNow() })),
    requests: (Array.isArray(g.requests) ? g.requests : []).filter((r) => r && Number(r.userId) > 0)
      .map((r) => ({ userId: Number(r.userId), at: r.at || isoNow() })),
    shout: g.shout && g.shout.text ? { text: String(g.shout.text), by: Number(g.shout.by) || 0, at: g.shout.at || isoNow() } : null,
    wall: (Array.isArray(g.wall) ? g.wall : []).filter((p) => p && Number(p.id) > 0 && typeof p.text === 'string')
      .map((p) => ({ id: Number(p.id), from: Number(p.from), text: p.text, at: p.at || isoNow() })),
    nextPostId: Number(g.nextPostId) || 1,
    refreshed: g.refreshed || null,
  };
}

function defaultRoles() {
  return [{ id: 1, name: 'Member', rank: 1 }, { id: 2, name: 'Admin', rank: 254 }, { id: 3, name: 'Owner', rank: OWNER_RANK }];
}

function load() {
  if (cache) return cache;
  const raw = core.readJsonFile(FILE);
  cache = { nextId: FIRST_ID, groups: [] };
  for (const g of raw && Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || !(Number(g.id) > 0)) continue;
    const group = cleanGroup(g);
    for (const post of group.wall) group.nextPostId = Math.max(group.nextPostId, post.id + 1);
    cache.groups.push(group);
    if (group.id >= FIRST_ID) cache.nextId = Math.max(cache.nextId, group.id + 1);
  }
  cache.nextId = Math.max(cache.nextId, Number(raw && raw.nextId) || FIRST_ID);
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save groups');
}

const valid = (id) => Number.isInteger(Number(id)) && Number(id) > 0;
const isServerAdmin = (userId) => {
  try {
    const account = require('./accounts').byUserId(userId);
    return Boolean(account && account.admin);
  } catch (error) {
    return false;
  }
};

function get(id) {
  return load().groups.find((g) => g.id === Number(id)) || null;
}

function byName(name) {
  const lower = oneLine(name, 100).toLowerCase();
  return load().groups.find((g) => g.name.toLowerCase() === lower) || null;
}

function roleOf(group, roleId) {
  return group.roles.find((r) => r.id === Number(roleId)) || null;
}

function lowestRole(group) {
  return group.roles.filter((r) => r.rank < OWNER_RANK).sort((a, b) => a.rank - b.rank)[0] || group.roles[0];
}

function ownerRole(group) {
  let role = group.roles.find((r) => r.rank === OWNER_RANK);
  if (!role) {
    role = { id: Math.max(0, ...group.roles.map((r) => r.id)) + 1, name: 'Owner', rank: OWNER_RANK };
    group.roles.push(role);
  }
  return role;
}

function memberOf(group, userId) {
  return group.members.find((m) => m.userId === Number(userId)) || null;
}

// -> { rank, role, roleId } for a member, else null.
function membership(groupId, userId) {
  const group = get(groupId);
  const member = group ? memberOf(group, userId) : null;
  if (!member) return null;
  const role = roleOf(group, member.roleId) || lowestRole(group);
  return { rank: role.rank, role: role.name, roleId: role.id };
}

function rankOf(group, userId) {
  const member = memberOf(group, userId);
  if (!member) return 0;
  return (roleOf(group, member.roleId) || lowestRole(group)).rank;
}

// The owner's powers: the owner, or a server admin for Website's groups.
function canOwn(group, userId) {
  if (!valid(userId)) return false;
  if (group.owner) return group.owner === Number(userId);
  return isServerAdmin(userId);
}

// Accepting, ranking, removing, shouting: rank 254+, or owner powers.
function canManage(group, userId) {
  return canOwn(group, userId) || rankOf(group, userId) >= MANAGER_RANK;
}

// The rank someone acts with when ranking others (owner powers act as 255).
function actingRank(group, userId) {
  return canOwn(group, userId) ? OWNER_RANK + 1 : rankOf(group, userId);
}

function groupsOf(userId) {
  return load().groups.filter((g) => memberOf(g, userId)).map((g) => ({ group: g, membership: membership(g.id, userId) }));
}

function search(text, limit = 50) {
  const query = oneLine(text, 50).toLowerCase();
  const list = load().groups.filter((g) => !query || g.name.toLowerCase().includes(query));
  return list.sort((a, b) => {
    const exact = Number(b.name.toLowerCase() === query) - Number(a.name.toLowerCase() === query);
    return exact || b.members.length - a.members.length || a.name.localeCompare(b.name);
  }).slice(0, limit);
}

function nameProblem(name, except) {
  if (name.length < 2 || name.length > MAX_NAME) return `Group names are 2 to ${MAX_NAME} characters.`;
  if (!/^[A-Za-z0-9 _'.&!-]+$/.test(name)) return 'Use letters, numbers, spaces and . _ \' & ! - in group names.';
  const other = byName(name);
  if (other && other.id !== except) return 'A group with that name already exists.';
  return null;
}

// -> { group } or { error }
function create(ownerId, fields = {}) {
  if (!valid(ownerId)) return { error: 'Guests cannot make groups.' };
  const name = oneLine(fields.name, MAX_NAME + 1);
  const problem = nameProblem(name);
  if (problem) return { error: problem };
  const description = cleanText(fields.description).slice(0, MAX_DESCRIPTION);
  const data = load();
  if (data.groups.filter((g) => g.owner === Number(ownerId)).length >= MAX_OWNED) return { error: `You can own up to ${MAX_OWNED} groups.` };
  if (groupsOf(ownerId).length >= maxJoined(ownerId)) return { error: `You can be in up to ${maxJoined(ownerId)} groups. Builders Club raises that.` };
  const paid = require('./robux').charge(ownerId, COST, `Made the group ${name}`);
  if (!paid.ok) return { error: `Making a group costs R$ ${COST}. You have R$ ${paid.balance}.` };
  const now = isoNow();
  const group = cleanGroup({ id: data.nextId++, name, description, owner: Number(ownerId), public: fields.public !== false, created: now, roles: defaultRoles() });
  group.members.push({ userId: Number(ownerId), roleId: ownerRole(group).id, joined: now });
  data.groups.push(group);
  save();
  return { group, balance: paid.balance };
}

function update(id, by, fields = {}) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canOwn(group, by)) return { error: 'Only the owner can change that.' };
  if (fields.description !== undefined) group.description = cleanText(fields.description).slice(0, MAX_DESCRIPTION);
  if (fields.public !== undefined) group.public = Boolean(fields.public);
  if (fields.name !== undefined && !group.imported) {
    const name = oneLine(fields.name, MAX_NAME + 1);
    const problem = nameProblem(name, group.id);
    if (problem) return { error: problem };
    group.name = name;
  }
  save();
  return { group };
}

// -> { group, joined: true } or { group, requested: true } or { error }
function join(id, userId) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!valid(userId)) return { error: 'Guests cannot join groups.' };
  if (memberOf(group, userId)) return { group, joined: true };
  if (groupsOf(userId).length >= maxJoined(userId)) return { error: `You can be in up to ${maxJoined(userId)} groups. Builders Club raises that.` };
  if (!group.public) {
    if (!group.requests.some((r) => r.userId === Number(userId))) {
      if (group.requests.length >= 500) return { error: 'This group has too many requests waiting.' };
      group.requests.push({ userId: Number(userId), at: isoNow() });
      save();
    }
    return { group, requested: true };
  }
  group.members.push({ userId: Number(userId), roleId: lowestRole(group).id, joined: isoNow() });
  group.requests = group.requests.filter((r) => r.userId !== Number(userId));
  save();
  return { group, joined: true };
}

function leave(id, userId) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  const before = group.requests.length;
  group.requests = group.requests.filter((r) => r.userId !== Number(userId));
  if (!memberOf(group, userId)) {
    if (group.requests.length !== before) save();
    return { group };
  }
  if (group.owner === Number(userId)) return { error: 'Give the group to another member first.' };
  group.members = group.members.filter((m) => m.userId !== Number(userId));
  save();
  return { group };
}

function answerRequest(id, by, userId, accept) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canManage(group, by)) return { error: 'Only the group\'s admins can do that.' };
  const index = group.requests.findIndex((r) => r.userId === Number(userId));
  if (index < 0) return { error: 'That request is no longer there.' };
  group.requests.splice(index, 1);
  if (accept && !memberOf(group, userId)) {
    if (groupsOf(userId).length >= maxJoined(userId)) {
      save();
      return { error: `They are already in ${maxJoined(userId)} groups.` };
    }
    group.members.push({ userId: Number(userId), roleId: lowestRole(group).id, joined: isoNow() });
  }
  save();
  return { group };
}

function setRank(id, by, userId, roleId) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canManage(group, by)) return { error: 'Only the group\'s admins can do that.' };
  const member = memberOf(group, userId);
  if (!member) return { error: 'They are not in the group.' };
  if (group.owner === Number(userId)) return { error: 'The owner keeps the owner\'s rank.' };
  const role = roleOf(group, roleId);
  if (!role || role.rank >= OWNER_RANK) return { error: 'Pick one of the group\'s ranks.' };
  const mine = actingRank(group, by);
  if (rankOf(group, userId) >= mine || role.rank >= mine) return { error: 'You can only set ranks below your own.' };
  member.roleId = role.id;
  save();
  return { group };
}

function kick(id, by, userId) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canManage(group, by)) return { error: 'Only the group\'s admins can do that.' };
  if (!memberOf(group, userId)) return { group };
  if (group.owner === Number(userId)) return { error: 'The owner can\'t be removed.' };
  if (rankOf(group, userId) >= actingRank(group, by)) return { error: 'You can only remove members ranked below you.' };
  group.members = group.members.filter((m) => m.userId !== Number(userId));
  save();
  return { group };
}

function transfer(id, by, userId) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canOwn(group, by)) return { error: 'Only the owner can give the group away.' };
  const member = memberOf(group, userId);
  if (!member) return { error: 'Give it to a member of the group.' };
  if (group.owner === Number(userId)) return { group };
  const previous = group.owner ? memberOf(group, group.owner) : null;
  if (previous) {
    const below = group.roles.filter((r) => r.rank < OWNER_RANK).sort((a, b) => b.rank - a.rank)[0];
    previous.roleId = (below || lowestRole(group)).id;
  }
  member.roleId = ownerRole(group).id;
  group.owner = Number(userId);
  save();
  return { group };
}

// roles: [{ id?, name, rank }] for ranks 1..254 (the owner's rank stays).
function setRoles(id, by, roles) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canOwn(group, by)) return { error: 'Only the owner can change ranks.' };
  const list = (Array.isArray(roles) ? roles : []).map((r) => ({ id: Number(r && r.id) || 0, name: oneLine(r && r.name, 50), rank: Math.trunc(Number(r && r.rank)) }));
  if (!list.length) return { error: 'Keep at least one rank.' };
  if (list.length > MAX_ROLES) return { error: `Groups can have up to ${MAX_ROLES} ranks besides the owner's.` };
  const ranks = new Set();
  for (const role of list) {
    if (!role.name) return { error: 'Every rank needs a name.' };
    if (!(role.rank >= 1 && role.rank <= 254)) return { error: 'Ranks are numbers from 1 to 254.' };
    if (ranks.has(role.rank)) return { error: 'Two ranks have the same number.' };
    ranks.add(role.rank);
  }
  const owner = ownerRole(group);
  let nextId = Math.max(0, ...group.roles.map((r) => r.id)) + 1;
  const kept = list.map((role) => (group.roles.some((r) => r.id === role.id && r.rank < OWNER_RANK) ? role : Object.assign(role, { id: nextId++ })));
  group.roles = [...kept, owner].sort((a, b) => a.rank - b.rank);
  const lowest = lowestRole(group);
  for (const member of group.members) if (!roleOf(group, member.roleId)) member.roleId = lowest.id;
  save();
  return { group };
}

function setShout(id, by, text) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canManage(group, by)) return { error: 'Only the group\'s admins can shout.' };
  const shout = oneLine(text, MAX_SHOUT + 1);
  if (shout.length > MAX_SHOUT) return { error: `Shouts can be up to ${MAX_SHOUT} characters.` };
  group.shout = shout ? { text: shout, by: Number(by), at: isoNow() } : null;
  save();
  return { group };
}

function post(id, by, text) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!memberOf(group, by)) return { error: 'Join the group to post on its wall.' };
  const body = cleanText(text);
  if (!body) return { error: 'Write something first.' };
  if (body.length > MAX_POST) return { error: `Posts can be up to ${MAX_POST} characters.` };
  const now = Date.now();
  const times = (posted.get(Number(by)) || []).filter((t) => now - t < POST_RATE.perMs);
  if (times.length >= POST_RATE.count) return { error: 'Slow down a little.' };
  times.push(now);
  posted.set(Number(by), times);
  const entry = { id: group.nextPostId++, from: Number(by), text: body, at: isoNow() };
  group.wall.push(entry);
  if (group.wall.length > MAX_WALL) group.wall.splice(0, group.wall.length - MAX_WALL);
  save();
  return { group, post: entry };
}

function deletePost(id, by, postId) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  const entry = group.wall.find((p) => p.id === Number(postId));
  if (!entry) return { group };
  if (entry.from !== Number(by) && !canManage(group, by) && !isServerAdmin(by)) return { error: 'You can only delete your own posts.' };
  group.wall = group.wall.filter((p) => p !== entry);
  save();
  return { group };
}

function emblemPath(group) {
  return group && group.emblem ? path.join(EMBLEMS, group.emblem.file) : null;
}

// PNG or JPEG bytes -> { group } or { error }. byImport skips the checks on who.
function setEmblem(id, by, bytes, byImport = false) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!byImport && !canOwn(group, by)) return { error: 'Only the owner can change the picture.' };
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { error: 'Pick a picture.' };
  if (bytes.length > MAX_EMBLEM) return { error: 'Pictures can be up to 1 MB.' };
  const png = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) return { error: 'Use a PNG or JPG picture.' };
  fs.mkdirSync(EMBLEMS, { recursive: true });
  const file = `${group.id}-${Date.now().toString(36)}.${png ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(EMBLEMS, file), bytes);
  const old = emblemPath(group);
  group.emblem = { file, at: isoNow() };
  save();
  if (old) fs.rm(old, { force: true }, () => {});
  return { group };
}

// The owner, or a server admin (taking a picture down).
function removeEmblem(id, by) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  if (!canOwn(group, by) && !isServerAdmin(by)) return { error: 'Only the owner or a server admin can remove the picture.' };
  const old = emblemPath(group);
  group.emblem = null;
  save();
  if (old) fs.rm(old, { force: true }, () => {});
  return { group };
}

// A server admin, or the owner while nobody else is in it.
function remove(id, by) {
  const group = get(id);
  if (!group) return { error: 'No such group.' };
  const alone = group.owner === Number(by) && group.members.every((m) => m.userId === Number(by));
  if (!alone && !isServerAdmin(by)) return { error: 'Only a server admin can delete a group with members.' };
  const old = emblemPath(group);
  const data = load();
  data.groups = data.groups.filter((g) => g !== group);
  save();
  if (old) fs.rm(old, { force: true }, () => {});
  return { ok: true };
}

// A Roblox group copied in (lib/groupimport.js): name, description and ranks
// follow Roblox; members, wall and shout are this server's.
function upsertImported({ id, name, description, roles }) {
  const data = load();
  let group = get(id);
  const now = isoNow();
  // Roblox can list two roles with one rank number; the first one stays.
  const seen = new Set();
  const ranks = (Array.isArray(roles) ? roles : []).filter((r) => Number(r.rank) >= 1 && Number(r.rank) <= OWNER_RANK)
    .filter((r) => !seen.has(Number(r.rank)) && seen.add(Number(r.rank)))
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .map((r, index) => ({ id: index + 1, name: oneLine(r.name, 50) || `Rank ${r.rank}`, rank: Number(r.rank) }));
  if (!group) {
    group = cleanGroup({ id, name, description, owner: 0, imported: true, public: true, created: now, roles: ranks.length ? ranks : defaultRoles() });
    data.groups.push(group);
  } else {
    group.name = oneLine(name, MAX_NAME + 20) || group.name;
    group.description = String(description || '');
    if (ranks.length) {
      // Keep members on the rank with the same number (or the lowest).
      const byRank = new Map(group.members.map((m) => [m.userId, (roleOf(group, m.roleId) || {}).rank]));
      group.roles = ranks;
      const lowest = lowestRole(group);
      for (const member of group.members) {
        const role = group.roles.find((r) => r.rank === byRank.get(member.userId));
        member.roleId = (role || lowest).id;
      }
    }
  }
  group.refreshed = now;
  save();
  return group;
}

// A deleted account leaves its groups; groups it owned go to Website.
function forget(userId) {
  const id = Number(userId);
  const data = load();
  let changed = false;
  for (const group of data.groups) {
    const before = group.members.length + group.requests.length;
    group.members = group.members.filter((m) => m.userId !== id);
    group.requests = group.requests.filter((r) => r.userId !== id);
    if (group.owner === id) group.owner = 0;
    if (before !== group.members.length + group.requests.length) changed = true;
  }
  if (changed) save();
}

module.exports = {
  COST, WEBSITE, OWNER_RANK, MANAGER_RANK, MAX_NAME, MAX_DESCRIPTION, MAX_SHOUT, MAX_POST, FIRST_ID,
  get, byName, search, groupsOf, membership, rankOf, canOwn, canManage, memberOf, roleOf, lowestRole,
  create, update, join, leave, answerRequest, setRank, kick, transfer, setRoles, setShout, post, deletePost,
  emblemPath, setEmblem, removeEmblem, remove, upsertImported, forget, isServerAdmin,
};
