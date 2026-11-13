'use strict';

// Friends between this server's accounts (data/friends.json):
//   { "friends": ["<low id>-<high id>", ...], "requests": [{ "from": id, "to": id, "at": iso }] }
// Used by the launcher's Friends tab (lib/launcherapi.js), the 2017 client's
// friend buttons and Players:GetFriendsAsync, RCC's friend lookups, and
// IsFriendsWith in games (lib/social.js). Guests (negative IDs) have none.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'friends.json');
const MAX_FRIENDS = 200;
const MAX_REQUESTS = 100;

function load() {
  const data = core.readJsonFile(FILE);
  const clean = { friends: [], requests: [] };
  if (data && Array.isArray(data.friends)) clean.friends = data.friends.filter((key) => /^\d+-\d+$/.test(key));
  if (data && Array.isArray(data.requests)) {
    clean.requests = data.requests.filter((request) => request && Number(request.from) > 0 && Number(request.to) > 0)
      .map((request) => ({ from: Number(request.from), to: Number(request.to), at: request.at || core.isoDate() }));
  }
  return clean;
}

function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(data, null, 2)}\n`)) throw new Error('could not save friends');
}

function pairKey(a, b) {
  const [low, high] = [Number(a), Number(b)].sort((x, y) => x - y);
  return `${low}-${high}`;
}

function valid(id) {
  return Number.isInteger(Number(id)) && Number(id) > 0;
}

function friendIds(userId, data = load()) {
  const id = Number(userId);
  const result = [];
  for (const key of data.friends) {
    const [low, high] = key.split('-').map(Number);
    if (low === id) result.push(high);
    else if (high === id) result.push(low);
  }
  return result;
}

function areFriends(a, b) {
  if (!valid(a) || !valid(b) || Number(a) === Number(b)) return false;
  return load().friends.includes(pairKey(a, b));
}

function incoming(userId, data = load()) {
  return data.requests.filter((request) => request.to === Number(userId));
}

function outgoing(userId, data = load()) {
  return data.requests.filter((request) => request.from === Number(userId));
}

// The friend status between two players, as the 2017 engine names it.
function status(me, other) {
  const data = load();
  if (data.friends.includes(pairKey(me, other))) return 'Friend';
  if (data.requests.some((r) => r.from === Number(me) && r.to === Number(other))) return 'FriendRequestSent';
  if (data.requests.some((r) => r.from === Number(other) && r.to === Number(me))) return 'FriendRequestReceived';
  return 'NotFriend';
}

// -> { ok, became: 'friends' | 'requested' } or { error }
// Asking someone who already asked you makes you friends.
function request(from, to) {
  if (!valid(from) || !valid(to)) return { error: 'Guests cannot have friends.' };
  if (Number(from) === Number(to)) return { error: 'That is you.' };
  const data = load();
  const key = pairKey(from, to);
  if (data.friends.includes(key)) return { ok: true, became: 'friends' };
  const reverse = data.requests.findIndex((r) => r.from === Number(to) && r.to === Number(from));
  if (reverse >= 0) return accept(from, to);
  if (data.requests.some((r) => r.from === Number(from) && r.to === Number(to))) return { ok: true, became: 'requested' };
  if (friendIds(from, data).length >= MAX_FRIENDS) return { error: `You already have ${MAX_FRIENDS} friends.` };
  if (outgoing(from, data).length >= MAX_REQUESTS) return { error: 'You have too many friend requests waiting. Wait for some answers first.' };
  data.requests.push({ from: Number(from), to: Number(to), at: core.isoDate() });
  save(data);
  return { ok: true, became: 'requested' };
}

// me accepts the request from requester.
function accept(me, requester) {
  const data = load();
  const index = data.requests.findIndex((r) => r.from === Number(requester) && r.to === Number(me));
  if (index < 0) return { error: 'That friend request is no longer there.' };
  if (friendIds(me, data).length >= MAX_FRIENDS) return { error: `You already have ${MAX_FRIENDS} friends.` };
  data.requests.splice(index, 1);
  const key = pairKey(me, requester);
  if (!data.friends.includes(key)) data.friends.push(key);
  // Any request the other way is answered too.
  data.requests = data.requests.filter((r) => !(r.from === Number(me) && r.to === Number(requester)));
  save(data);
  return { ok: true, became: 'friends' };
}

// Declines a request to me, or takes back mine.
function dropRequest(a, b) {
  const data = load();
  const before = data.requests.length;
  data.requests = data.requests.filter((r) => !((r.from === Number(a) && r.to === Number(b)) || (r.from === Number(b) && r.to === Number(a))));
  if (data.requests.length !== before) save(data);
  return { ok: true };
}

function unfriend(a, b) {
  const data = load();
  const key = pairKey(a, b);
  const before = data.friends.length;
  data.friends = data.friends.filter((entry) => entry !== key);
  data.requests = data.requests.filter((r) => !((r.from === Number(a) && r.to === Number(b)) || (r.from === Number(b) && r.to === Number(a))));
  if (data.friends.length !== before) save(data);
  return { ok: true };
}

// An account was deleted: its friendships and requests go too.
function forget(userId) {
  const data = load();
  const id = Number(userId);
  data.friends = data.friends.filter((key) => !key.split('-').map(Number).includes(id));
  data.requests = data.requests.filter((r) => r.from !== id && r.to !== id);
  save(data);
}

module.exports = { friendIds, areFriends, incoming, outgoing, status, request, accept, dropRequest, unfriend, forget, MAX_FRIENDS };
