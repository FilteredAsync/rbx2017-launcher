'use strict';

// Answers for LuaWebService calls (Game/LuaWebService/HandleSocialRequest.ashx),
// which both the client and RCC make for Player:IsInGroup, GetRankInGroup,
// GetRoleInGroup and IsFriendsWith. Groups are this server's (lib/groups.js:
// player-made ones and the copied Roblox groups behind its games, with their
// Roblox group IDs); player IDs are this server's own, so Roblox's groups are
// never asked. IsFriendsWith answers from this server's friends (lib/friends.js).
// Any lookup problem answers "not in the group" rather than an error.
// Roblox's admin group (1200769) is this server's admins instead: the 2017
// player list gives its members the admin star (PlayerPermissionsModule).

const groups = require('./groups');
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

const bool = (value) => `<Value Type="boolean">${value ? 'true' : 'false'}</Value>`;
const int = (value) => `<Value Type="integer">${Math.trunc(value) || 0}</Value>`;

// -> { contentType, body }
async function answer(method, query) {
  const playerId = /^\d{1,15}$/.test(String(query.playerid || '')) ? String(query.playerid) : null;
  const groupId = /^\d{1,15}$/.test(String(query.groupid || '')) ? String(query.groupid) : null;
  const membership = async () => {
    if (!playerId || !groupId) return undefined;
    if (groupId === ROBLOX_ADMINS) return isServerAdmin(playerId) ? { rank: 255, role: 'Admin' } : undefined;
    return groups.membership(groupId, playerId) || undefined;
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

module.exports = { answer };
