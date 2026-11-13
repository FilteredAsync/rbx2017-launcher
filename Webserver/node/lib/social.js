'use strict';

// Answers for LuaWebService calls (Game/LuaWebService/HandleSocialRequest.ashx),
// which both the client and RCC make for Player:IsInGroup, GetRankInGroup,
// GetRoleInGroup and IsFriendsWith. Player IDs here are real Roblox user IDs,
// so group membership comes from groups.roblox.com (public; cached for ten
// minutes). IsFriendsWith answers from this server's friends (lib/friends.js).
// Any lookup problem answers "not in the group" rather than an error.
// Roblox's admin group (1200769) is this server's admins instead: the 2017
// player list gives its members the admin star (PlayerPermissionsModule).

const assets = require('./assets');
const friends = require('./friends');

const ROBLOX_ADMINS = '1200769';

function isServerAdmin(userId) {
  try {
    const account = require('./accounts').byUserId(userId);
    return Boolean(account && account.admin);
  } catch (error) {
    return false;
  }
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // userId -> { at, groups: Map(groupId -> { rank, role }) }
const inflight = new Map();

async function groupsOf(userId) {
  const cached = cache.get(userId);
  if (cached && cached.at > Date.now() - CACHE_MS) return cached.groups;
  let pending = inflight.get(userId);
  if (!pending) {
    pending = (async () => {
      const data = await assets.httpGetJson(`https://groups.roblox.com/v2/users/${userId}/groups/roles`, 10000);
      const groups = new Map();
      if (data && Array.isArray(data.data)) {
        for (const entry of data.data) {
          if (entry && entry.group && entry.role) {
            groups.set(String(entry.group.id), { rank: Number(entry.role.rank) || 0, role: String(entry.role.name || 'Member') });
          }
        }
        cache.set(userId, { at: Date.now(), groups });
      }
      return groups;
    })().finally(() => inflight.delete(userId));
    inflight.set(userId, pending);
  }
  return pending;
}

const bool = (value) => `<Value Type="boolean">${value ? 'true' : 'false'}</Value>`;
const int = (value) => `<Value Type="integer">${Math.trunc(value) || 0}</Value>`;

// -> { contentType, body }
async function answer(method, query) {
  const playerId = /^\d{1,15}$/.test(String(query.playerid || '')) ? String(query.playerid) : null;
  const groupId = /^\d{1,15}$/.test(String(query.groupid || '')) ? String(query.groupid) : null;
  const membership = async () => {
    if (!playerId || !groupId) return undefined;
    if (groupId === ROBLOX_ADMINS) return isServerAdmin(playerId) ? { rank: 255, role: 'Admin' } : undefined;
    return (await groupsOf(playerId)).get(groupId);
  };
  switch (String(method || '')) {
    case 'IsInGroup':
      return { contentType: 'application/xml', body: bool(await membership()) };
    case 'GetGroupRank':
    case 'GetRankInGroup':
      return { contentType: 'application/xml', body: int(((await membership()) || { rank: 0 }).rank) };
    case 'GetGroupRole':
    case 'GetRoleInGroup':
      // Read as raw text; an empty answer is an error ("string is empty").
      return { contentType: 'text/plain; charset=utf-8', body: ((await membership()) || { role: 'Guest' }).role };
    case 'IsFriendsWith': {
      // Friends made in the launcher or in game (lib/friends.js).
      const userId = /^\d{1,15}$/.test(String(query.userid || '')) ? String(query.userid) : null;
      return { contentType: 'application/xml', body: bool(playerId && userId && friends.areFriends(playerId, userId)) };
    }
    case 'IsBestFriendsWith':
      return { contentType: 'application/xml', body: bool(false) };
    default:
      return { contentType: 'application/xml', body: '' };
  }
}

module.exports = { answer, groupsOf };
