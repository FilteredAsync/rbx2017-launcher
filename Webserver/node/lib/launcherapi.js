'use strict';

// What the launcher asks the web server for (all under /api/launcher/):
//
//   POST login            {name, password, mode: "signin"|"signup"} -> {token, account}
//   POST logout           (session)
//   GET  me               (session) -> {account}
//   POST join             {gameId} (session, or none for a guest) -> {ticket, name, userId, guest}
//   GET  players          who is in which game
//   GET  avatar           (session) -> the account's avatar
//   POST avatar           (session) {bodyColors, assets: [{id}]} -> saves it
//   POST avatar/copy      (session) copies the Roblox account with the same name
//   POST avatar/image     (session, or ?guest=1) PNG the launcher drew of the avatar
//   GET  catalog          ?category=&keyword=&cursor= -> items (featured list without a keyword)
//   GET  bundle/<id>      the items in a package
//   GET  friends          (session) friends (and where they play), requests
//   POST friends/request  (session) {name} or {userId}
//   POST friends/accept | decline | cancel | remove   (session) {userId}
//   GET  people           ?search= -> accounts (online first), with where they play
//   GET  profile/<userId> a player's profile: bio, where they play, friends
//   POST profile          (session) {bio} -> your profile
//   GET  outfits          (session) your saved avatars
//   POST outfits          (session) {name, image: PNG as base64} saves what you wear
//   POST outfits/<id>/wear | rename {name} | delete   (session)
//   GET  outfit-image/<userId>/<id>   an outfit's picture
//
// The session is the token from login, sent as "Authorization: Bearer ...",
// the same accounts and sessions Studio uses (lib/accounts.js).
//
// Joining: the launcher asks for a ticket, then starts the client with
// placelauncher.ashx?ticket=... The ticket decides the player's name and user
// ID, so nobody can join as someone else by typing their name. Without a
// ticket (older launchers, playGame.bat) the player joins as a guest:
// "Guest_1234", a negative user ID and the guest look, like 2016's guests.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const assets = require('./assets');
const accounts = require('./accounts');
const avatar = require('./avatar');
const avatarStore = require('./avatarstore');
const games = require('./games');
const friends = require('./friends');
const outfits = require('./outfits');
const announcements = require('./announcements');
const wearables = require('./wearables');

const TICKET_MS = 5 * 60 * 1000;
const tickets = new Map();

// Avatar editor categories -> Roblox asset types (or packages).
const CATEGORIES = {
  hats: { types: [8], label: 'Hats' },
  hair: { types: [41], label: 'Hair' },
  face: { types: [42], label: 'Face accessories' },
  neck: { types: [43], label: 'Neck' },
  shoulder: { types: [44], label: 'Shoulder' },
  front: { types: [45], label: 'Front' },
  back: { types: [46], label: 'Back' },
  waist: { types: [47], label: 'Waist' },
  faces: { types: [18], label: 'Faces' },
  heads: { types: [17], label: 'Heads' },
  shirts: { types: [11], label: 'Shirts' },
  pants: { types: [12], label: 'Pants' },
  tshirts: { types: [2], label: 'T-Shirts' },
  packages: { bundles: true, label: 'Packages' },
};
// Roblox's catalog no longer lists classic faces and heads (faces became
// dynamic-head bundles), so these are fixed lists of Roblox's own classic
// ones, checked against economy.roblox.com. Any other ID can still be worn by
// typing it into the editor.
const CLASSIC = {
  faces: [
    [144075659, 'Smile'], [7074661, 'Classic Goof'], [7074786, 'Check It'], [7074729, 'Glee'], [7074764, 'Chill'],
    [7074893, 'Drool'], [7074836, 'Classic Vampire'], [7075142, 'Fang'], [7076076, 'Hmmm...'], [8329679, 'Stitchface'],
    [9250660, 'Concerned'], [12145366, 'Freckles'], [15432080, ':3'], [16132514, ':D'], [20418658, 'Err...'],
    [20722130, 'Shiny Teeth'], [23219981, 'Nervous'], [25166274, 'Squiggle Mouth'], [27725434, 'Friendly Puppy'],
    [31117267, 'Skeptic'], [86487700, 'Man Face'], [141728790, 'Tired Face'], [162068415, 'YAAAWWN.'],
    [209994875, 'Smiling Girl'], [255827175, 'Serious Scar Face'], [334656210, 'Miss Scarlet'], [616380929, 'The Winning Smile'],
  ],
  heads: [
    [6340101, 'Blockhead'], [6340133, 'Octoblox'], [6340141, 'Hex'], [6340154, 'ROX BOX'], [6340161, 'Eraser Head'],
    [6340192, 'Cylinder Madness'], [6340208, 'Flat Top'], [6340213, 'Roundy'], [6340227, 'Trim'], [6340258, 'Cool Thing'],
    [6340269, 'Perfection'],
  ],
};
const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47]);
const SINGLE_TYPES = new Set([2, 11, 12, 17, 18, 27, 28, 29, 30, 31]);
const BODY_PART_TYPES = new Set([27, 28, 29, 30, 31]);
const MAX_HATS = 3;
const MAX_ACCESSORIES = 10;
// Items Roblox released up to the end of 2017 have IDs below this; the
// featured lists keep to them.
const CLASSIC_MAX_ID = 1300000000;

module.exports = function launcherApi({ send, sendJson, jsonBody, assetBytes }) {
  function account(ctx) {
    return accounts.fromRequest(ctx.req);
  }

  function needAccount(ctx) {
    const who = account(ctx);
    if (!who) sendJson(ctx, 401, { error: 'Sign in first.' });
    return who;
  }

  // --- join tickets -------------------------------------------------------------------

  function pruneTickets() {
    const now = Date.now();
    for (const [key, entry] of tickets) if (entry.expires < now) tickets.delete(key);
  }

  function guestNumber() {
    const taken = new Set([...tickets.values()].filter((entry) => entry.guest).map((entry) => entry.userId));
    for (let attempt = 0; attempt < 50; attempt++) {
      const number = 1000 + crypto.randomInt(9000);
      if (!taken.has(-number)) return number;
    }
    return 1000 + crypto.randomInt(9000);
  }

  // 2016's guests were "Guest 1234", but this client turns any name with a
  // space into "Player" on the player's own screen, so guests get an
  // underscore instead.
  function guestIdentity() {
    const number = guestNumber();
    return { name: `Guest_${number}`, userId: -number, guest: true };
  }

  function newTicket(identity) {
    pruneTickets();
    const ticket = crypto.randomBytes(16).toString('hex');
    tickets.set(ticket, Object.assign({}, identity, { expires: Date.now() + TICKET_MS }));
    return ticket;
  }

  // Who a placelauncher request joins as: the ticket's player, or a new guest.
  // The address it came from is remembered: the game client's own web
  // requests (friend buttons) carry no sign-in, so that address stands for
  // the player until another join from it.
  const players = new Map(); // remote address -> { name, userId, guest, at }
  const PLAYER_MS = 24 * 60 * 60 * 1000;
  // A client on the server PC may come in over IPv4 or IPv6 loopback.
  const addressKey = (remote) => (/^(?:127\.|::1$|::ffff:127\.)/.test(String(remote || '')) ? 'loopback' : String(remote || ''));

  function joinIdentity(ticket, remote) {
    pruneTickets();
    const entry = /^[0-9a-f]{32}$/.test(String(ticket || '')) ? tickets.get(ticket) : null;
    const who = entry ? { name: entry.name, userId: entry.userId, guest: entry.guest } : guestIdentity();
    if (remote) players.set(addressKey(remote), Object.assign({ at: Date.now() }, who));
    return who;
  }

  function playerAt(remote) {
    const entry = players.get(addressKey(remote));
    return entry && entry.at > Date.now() - PLAYER_MS && !entry.guest && entry.userId > 0 ? entry : null;
  }

  // join.php gets the name and ID in its address, with this signature so they
  // cannot be changed on the way.
  function joinSignature(userId, name, placeId) {
    return accounts.mac(`join.${userId}.${name}.${placeId}`);
  }

  function checkJoinSignature(userId, name, placeId, signature) {
    return accounts.checkMac(`join.${userId}.${name}.${placeId}`, signature);
  }

  // --- players ------------------------------------------------------------------------

  // From the always-on server's status (runner-status.json): who is in which
  // game right now.
  function onlinePlayers() {
    const status = core.readJsonFile(core.rootPath('Webserver', 'node', 'data', 'runner-status.json'));
    const byPlace = status && status.games && typeof status.games === 'object' ? status.games : {};
    const listed = games.list();
    const result = [];
    for (const [placeId, entry] of Object.entries(byPlace)) {
      if (!entry || !Array.isArray(entry.players)) continue;
      const game = listed.find((item) => String(item.placeId) === String(placeId));
      for (const raw of entry.players) {
        // Older status files hold several names in one, XML-escaped.
        for (const name of String(raw).split(/&#xA;|\n/i).map((text) => text.trim()).filter(Boolean)) {
          const known = accounts.byName(name);
          const guestMatch = /^Guest[ _](\d{1,6})$/.exec(name);
          result.push({
            name,
            userId: known ? known.userId : guestMatch ? -Number(guestMatch[1]) : null,
            guest: Boolean(guestMatch),
            placeId: String(placeId),
            gameId: game ? game.id : null,
            gameName: game ? game.name : `Place ${placeId}`,
          });
        }
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- asset details (types and names, cached) ------------------------------------------------

  const DETAILS_FILE = () => path.join(core.cacheDir(''), 'asset-details.json');
  let detailsCache = null;

  function details() {
    if (!detailsCache) {
      const data = core.readJsonFile(DETAILS_FILE());
      detailsCache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }
    return detailsCache;
  }

  let detailsTimer = null;
  function rememberDetails(id, typeId, name) {
    const table = details();
    const key = String(id);
    if (table[key] && table[key].typeId === typeId && table[key].name === name) return;
    table[key] = { typeId, name };
    if (!detailsTimer) {
      detailsTimer = setTimeout(() => {
        detailsTimer = null;
        core.writeFileAtomic(DETAILS_FILE(), JSON.stringify(details()));
      }, 2000);
    }
  }

  async function assetDetails(id) {
    const known = details()[String(id)];
    if (known) return known;
    const data = await assets.httpGetJson(`https://economy.roblox.com/v2/assets/${id}/details`, 10000);
    if (!data || !Number.isInteger(data.AssetTypeId)) return null;
    rememberDetails(id, data.AssetTypeId, String(data.Name || ''));
    return details()[String(id)];
  }

  // --- avatar ----------------------------------------------------------------------------

  async function describeAvatar(who) {
    let saved = avatarStore.get(who.userId);
    if (!saved) {
      // First visit: start from the Roblox account with the same name.
      const copied = await avatar.robloxCharacter(who.name);
      const found = ['live', 'cache', 'stale-cache'].includes(copied.source);
      saved = { bodyColors: copied.bodyColors, assets: copied.assets, source: found ? 'roblox-copy' : 'default' };
      if (found) avatarStore.set(who.userId, saved, 'roblox-copy');
    }
    for (const asset of saved.assets) rememberDetails(asset.id, asset.typeId, asset.name);
    return { account: who, bodyColors: saved.bodyColors, assets: saved.assets, source: saved.source || 'edited', hasImage: Boolean(avatarStore.imageFor(who.userId)) };
  }

  // Checks what the editor sends: known, wearable items, at most one of each
  // kind (three hats, ten accessories in all).
  async function cleanAvatar(body) {
    const wanted = Array.isArray(body.assets) ? body.assets.slice(0, 40) : [];
    const result = [];
    const counts = new Map();
    let accessories = 0;
    for (const item of wanted) {
      const id = core.decimal(String(item && item.id));
      if (id === null || id === '0' || result.some((asset) => asset.id === id)) continue;
      const info = await assetDetails(id);
      if (!info) return { error: `Could not look up item ${id} on Roblox. Try again in a minute.` };
      const typeId = info.typeId;
      if (!ACCESSORY_TYPES.has(typeId) && !SINGLE_TYPES.has(typeId)) return { error: `"${info.name}" cannot be worn in this version of Roblox.` };
      const count = (counts.get(typeId) || 0) + 1;
      if (SINGLE_TYPES.has(typeId) && count > 1) return { error: `Only one item of each kind: "${info.name}" is the second.` };
      if (typeId === 8 && count > MAX_HATS) return { error: `At most ${MAX_HATS} hats.` };
      if (ACCESSORY_TYPES.has(typeId) && typeId !== 8 && count > 1) return { error: `Only one accessory of each kind: "${info.name}" is the second.` };
      if (ACCESSORY_TYPES.has(typeId) && ++accessories > MAX_ACCESSORIES) return { error: `At most ${MAX_ACCESSORIES} accessories.` };
      counts.set(typeId, count);
      result.push({ id, typeId, name: info.name });
    }
    const colors = {};
    for (const key of avatarStore.COLOR_KEYS) {
      const value = Number(body.bodyColors && body.bodyColors[key]);
      if (!Number.isInteger(value) || value < 0 || value > 1999) return { error: 'Pick each body color from the palette.' };
      colors[key] = value;
    }
    return { avatar: { bodyColors: colors, assets: result } };
  }

  // --- catalog ----------------------------------------------------------------------------

  // Roblox's catalog search answers "429 Too Many Requests" after a few quick
  // searches, so results are kept for 30 minutes and searches go one at a time.
  const searchCache = new Map();
  const SEARCH_TTL_MS = 30 * 60 * 1000;
  let searchQueue = Promise.resolve();
  let lastSearchAt = 0;

  function queued(task) {
    const run = searchQueue.then(async () => {
      const wait = lastSearchAt + 1200 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        return await task();
      } finally {
        lastSearchAt = Date.now();
      }
    });
    searchQueue = run.catch(() => {});
    return run;
  }

  async function robloxJson(url) {
    const response = await assets.httpRequest(url, { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, 15000);
    if (response.status === 429) return { error: "Roblox's catalog is busy. Try again in a minute.", status: 503 };
    if (response.status !== 200) return { error: `Roblox's catalog answered HTTP ${response.status || 0}.`, status: 502 };
    try {
      return { data: JSON.parse(response.body.toString('utf8')) };
    } catch (error) {
      return { error: "Roblox's catalog sent something unreadable.", status: 502 };
    }
  }

  function itemFrom(raw) {
    const bundle = raw.itemType === 'Bundle';
    const item = {
      id: String(raw.id),
      kind: bundle ? 'bundle' : 'asset',
      name: String(raw.name || ''),
      typeId: bundle ? null : Number(raw.assetType) || null,
      creator: String(raw.creatorName || ''),
    };
    if (!bundle && item.typeId) rememberDetails(item.id, item.typeId, item.name);
    return item;
  }

  async function search(categoryKey, keyword, cursor, classicOnly) {
    const category = CATEGORIES[categoryKey];
    if (!category) return { error: 'Unknown category.', status: 400 };
    if (CLASSIC[categoryKey]) {
      const typeId = category.types[0];
      const needle = keyword.toLowerCase();
      const items = CLASSIC[categoryKey]
        .filter(([, name]) => !needle || name.toLowerCase().includes(needle))
        .map(([id, name]) => {
          rememberDetails(String(id), typeId, name);
          return { id: String(id), kind: 'asset', name, typeId, creator: 'Roblox' };
        });
      return { items, nextCursor: null };
    }
    const params = new URLSearchParams({ Limit: '30', SortType: keyword ? '0' : '1' });
    if (category.bundles) params.set('bundleTypeIds', '1');
    else params.set('assetTypeIds', String(category.types[0]));
    if (keyword) params.set('Keyword', keyword.slice(0, 50));
    if (!keyword) params.set('CreatorName', 'Roblox');
    if (cursor) params.set('Cursor', cursor);
    const key = `${categoryKey}|${params.toString()}|${classicOnly}`;
    const hit = searchCache.get(key);
    if (hit && hit.at > Date.now() - SEARCH_TTL_MS) return hit.result;
    const answer = await queued(() => robloxJson(`https://catalog.roblox.com/v2/search/items/details?${params}`));
    if (answer.error) return answer;
    const data = answer.data || {};
    let items = (Array.isArray(data.data) ? data.data : []).map(itemFrom)
      .filter((item) => (category.bundles ? item.kind === 'bundle' : item.kind === 'asset' && category.types.includes(item.typeId)));
    // Featured lists stay with classic items (packages: Roblox's own bundles,
    // which all date from 2017 or later but carry classic R6 parts).
    if (classicOnly && !category.bundles) items = items.filter((item) => Number(item.id) < CLASSIC_MAX_ID);
    const result = { items, nextCursor: data.nextPageCursor || null };
    searchCache.set(key, { at: Date.now(), result });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
    return result;
  }

  const bundleCache = new Map();
  async function bundleItems(id) {
    if (bundleCache.has(id)) return bundleCache.get(id);
    const answer = await queued(() => robloxJson(`https://catalog.roblox.com/v1/bundles/${id}/details`));
    if (answer.error) return answer;
    const data = answer.data || {};
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter((item) => item.type === 'Asset')
      .map((item) => ({ id: String(item.id), name: String(item.name || ''), typeId: Number(item.assetType) || null }))
      .filter((item) => item.typeId && (BODY_PART_TYPES.has(item.typeId) || item.typeId === 17 || item.typeId === 18));
    for (const item of items) rememberDetails(item.id, item.typeId, item.name);
    const result = { id: String(id), name: String(data.name || ''), items };
    bundleCache.set(id, result);
    return result;
  }

  // --- items for the 3D preview (lib/wearables.js) --------------------------------------------

  const WEARABLE_FORMAT = 1;
  const wearableCache = new Map();

  async function wearable(id) {
    if (wearableCache.has(id)) return wearableCache.get(id);
    const file = path.join(core.cacheDir('wearables'), `${id}.json`);
    const cached = core.readJsonFile(file);
    if (cached && cached.format === WEARABLE_FORMAT) {
      wearableCache.set(id, cached);
      return cached;
    }
    const info = await assetDetails(id);
    if (!info) return { error: 'Could not look up this item on Roblox.', status: 502 };
    const bytes = await assetBytes(id);
    if (!bytes) return { error: 'Could not download this item.', status: 502 };
    const description = wearables.describe(info.typeId, bytes);
    const result = { format: WEARABLE_FORMAT, id: String(id), typeId: info.typeId, name: info.name, item: description };
    core.writeFileAtomic(file, JSON.stringify(result));
    wearableCache.set(id, result);
    if (wearableCache.size > 2000) wearableCache.delete(wearableCache.keys().next().value);
    return result;
  }

  // --- friends ---------------------------------------------------------------------------------

  function friendSummary(who) {
    const online = onlinePlayers();
    const where = (userId, name) => online.find((player) => player.userId === userId
      || player.name.toLowerCase() === String(name || '').toLowerCase()) || null;
    const person = (userId) => {
      const account = accounts.byUserId(userId);
      const name = account ? account.name : `User ${userId}`;
      const place = where(userId, name);
      return { userId, name, online: place ? { gameId: place.gameId, gameName: place.gameName, placeId: place.placeId } : null };
    };
    const list = friends.friendIds(who.userId).filter((id) => accounts.byUserId(id)).map(person)
      .sort((a, b) => (Number(Boolean(b.online)) - Number(Boolean(a.online))) || a.name.localeCompare(b.name));
    return {
      friends: list,
      incoming: friends.incoming(who.userId).filter((r) => accounts.byUserId(r.from)).map((r) => Object.assign(person(r.from), { at: r.at })),
      outgoing: friends.outgoing(who.userId).filter((r) => accounts.byUserId(r.to)).map((r) => Object.assign(person(r.to), { at: r.at })),
      max: friends.MAX_FRIENDS,
    };
  }

  function friendTarget(body) {
    if (body.name !== undefined) return accounts.byName(String(body.name).trim());
    return accounts.byUserId(String(body.userId || ''));
  }

  async function friendsRoute(ctx, who, verb) {
    if (!verb) return sendJson(ctx, 200, friendSummary(who));
    const body = await jsonBody(ctx);
    const other = friendTarget(body);
    if (!other) {
      const typed = body.name !== undefined ? String(body.name).trim() : '';
      return sendJson(ctx, 404, { error: typed ? `Nobody on this server is called "${typed}".` : 'No such player.' });
    }
    let result;
    if (verb === 'request') result = friends.request(who.userId, other.userId);
    else if (verb === 'accept') result = friends.accept(who.userId, other.userId);
    else if (verb === 'decline' || verb === 'cancel') result = friends.dropRequest(who.userId, other.userId);
    else if (verb === 'remove') result = friends.unfriend(who.userId, other.userId);
    else return sendJson(ctx, 404, { error: 'unknown friends request' });
    if (result.error) return sendJson(ctx, 400, { error: result.error });
    return sendJson(ctx, 200, Object.assign({ became: result.became || null, name: other.name }, friendSummary(who)));
  }

  // --- the 2017 client's and RCC's friend calls ------------------------------------------
  // Client (Player:RequestFriendship / RevokeFriendship, the player list):
  //   user/request-friendship?recipientUserId=  user/accept-friend-request?requesterUserId=
  //   user/decline-friend-request?requesterUserId=  user/unfriend?friendUserId=
  //   user/get-friendship-count[?userId=]  friends/filter-requests?otherUserIds=
  // RCC (FriendService) and Players:GetFriendsAsync:
  //   users/filter-friends?userId=&otherUserIds=  user/multiget-friend-requests?userId=&otherUserIds=
  //   users/<id>/friends?page=

  function idList(text) {
    return String(text || '').split(',').map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id > 0).slice(0, 200);
  }

  function gameFriendRoute(kind) {
    return (ctx, match) => {
      const q = ctx.queryLower;
      const reply = (value) => sendJson(ctx, 200, value);
      if (kind === 'statuses') {
        // Only edited CoreScripts ask this, and the 2017 client never runs
        // CoreScripts from its content folder (it uses the ones built into
        // the program). Friend icons come from RCC's FriendService instead
        // (filter-friends below), which hosting.js makes sure exists.
        const me = Number(q.userid);
        const statuses = {};
        if (me > 0) for (const id of idList(q.otheruserids)) statuses[id] = friends.status(me, id);
        return reply({ success: true, statuses });
      }
      if (kind === 'filter-friends') {
        const mine = new Set(friends.friendIds(Number(q.userid)));
        return reply(idList(q.otheruserids).filter((id) => mine.has(id)).map((id) => ({ Id: id })));
      }
      if (kind === 'multiget-requests') {
        const me = Number(q.userid);
        const others = new Set(idList(q.otheruserids));
        const list = [...friends.incoming(me), ...friends.outgoing(me)]
          .filter((r) => others.size === 0 || others.has(r.from) || others.has(r.to))
          .map((r) => ({ SenderId: r.from, RecipientId: r.to }));
        return reply(list);
      }
      if (kind === 'friend-list') {
        const page = Math.max(1, Number(q.page) || 1);
        const online = onlinePlayers();
        const list = friends.friendIds(match[1]).map((id) => accounts.byUserId(id)).filter(Boolean)
          .map((account) => ({ Id: account.userId, Username: account.name, IsOnline: online.some((p) => p.userId === account.userId), IsBestFriend: false }));
        return reply(page === 1 ? list : []);
      }
      const me = playerAt(ctx.remote);
      if (kind === 'count') {
        const userId = q.userid !== undefined ? Number(q.userid) : (me ? me.userId : 0);
        return reply({ success: true, count: userId > 0 ? friends.friendIds(userId).length : 0 });
      }
      if (!me) return reply({ success: false, message: 'Only signed-in players have friends.' });
      if (kind === 'filter-requests') {
        const others = new Set(idList(q.otheruserids));
        return reply({ success: true, FriendRequestsToUser: friends.incoming(me.userId).map((r) => r.from).filter((id) => others.has(id)) });
      }
      const target = Number(q.recipientuserid || q.requesteruserid || q.frienduserid);
      if (!(target > 0) || !accounts.byUserId(target)) return reply({ success: false, message: 'That player cannot have friends.' });
      let result = { error: 'unknown friend request' };
      if (kind === 'request') result = friends.request(me.userId, target);
      else if (kind === 'accept') result = friends.accept(me.userId, target);
      else if (kind === 'decline') result = friends.dropRequest(me.userId, target);
      else if (kind === 'unfriend') result = friends.unfriend(me.userId, target);
      return reply(result.error ? { success: false, message: result.error } : { success: true, message: 'Success' });
    };
  }

  // --- routes ------------------------------------------------------------------------------

  async function route(ctx, match) {
    const action = (match[1] || '').toLowerCase();
    const method = ctx.method;

    if (action === 'login' && method === 'POST') {
      const body = await jsonBody(ctx);
      const mode = body.mode === 'signup' ? 'signup' : 'signin';
      const result = accounts.login(body.name, body.password, ctx.remote, mode);
      if (result.error) return sendJson(ctx, result.status || 400, { error: result.error });
      return sendJson(ctx, 200, { token: result.token, account: result.account, created: result.created });
    }
    if (action === 'logout' && method === 'POST') {
      accounts.logout(accounts.bearerToken(ctx.req.headers.authorization));
      return sendJson(ctx, 200, { ok: true });
    }
    if (action === 'me' && method === 'GET') {
      const who = needAccount(ctx);
      if (who) sendJson(ctx, 200, { account: who });
      return;
    }
    if (action === 'join' && method === 'POST') {
      const body = await jsonBody(ctx);
      const game = games.get(String(body.gameId || ''));
      if (!game) return sendJson(ctx, 404, { error: 'That game is no longer online.' });
      const who = account(ctx);
      if (!who && !body.guest) return sendJson(ctx, 401, { error: 'Your sign-in ran out. Sign in again, or play as a guest.' });
      const identity = who ? { name: who.name, userId: who.userId, guest: false } : guestIdentity();
      return sendJson(ctx, 200, Object.assign({ ticket: newTicket(identity) }, identity));
    }
    const friendsMatch = /^friends(?:\/(request|accept|decline|cancel|remove))?$/.exec(action);
    if (friendsMatch && (friendsMatch[1] ? method === 'POST' : method === 'GET')) {
      const who = needAccount(ctx);
      if (who) await friendsRoute(ctx, who, friendsMatch[1] || null);
      return;
    }
    if (action === 'announcements' && method === 'GET') {
      // The host's notices (lib/announcements.js), for every launcher.
      return sendJson(ctx, 200, { announcements: announcements.list() });
    }
    if (action === 'moved' && method === 'GET') {
      // The server moved to another PC (config/moved.json, {"to": "http://100.x.y.z"}):
      // launchers 1.5.2 and newer switch to that address by themselves.
      const moved = core.readJsonFile(core.rootPath('config', 'moved.json'));
      const to = moved && typeof moved.to === 'string' && /^https?:\/\/[^\s\/]+$/i.test(moved.to.replace(/\/+$/, '')) ? moved.to.replace(/\/+$/, '') : null;
      return sendJson(ctx, 200, { movedTo: to });
    }
    if (action === 'players' && method === 'GET') {
      return sendJson(ctx, 200, { players: onlinePlayers() });
    }
    if (action === 'avatar' && method === 'GET') {
      const who = needAccount(ctx);
      if (who) sendJson(ctx, 200, await describeAvatar(who));
      return;
    }
    if (action === 'avatar' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return;
      const cleaned = await cleanAvatar(await jsonBody(ctx));
      if (cleaned.error) return sendJson(ctx, 400, { error: cleaned.error });
      avatarStore.set(who.userId, cleaned.avatar, 'edited');
      return sendJson(ctx, 200, await describeAvatar(who));
    }
    if (action === 'avatar/copy' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return;
      const copied = await avatar.robloxCharacter(who.name);
      if (!['live', 'cache', 'stale-cache'].includes(copied.source)) {
        return sendJson(ctx, 404, { error: `Could not find a Roblox account named ${who.name}.` });
      }
      avatarStore.set(who.userId, { bodyColors: copied.bodyColors, assets: copied.assets }, 'roblox-copy');
      return sendJson(ctx, 200, await describeAvatar(who));
    }
    if (action === 'avatar/image' && method === 'POST') {
      const guest = ctx.queryLower.guest !== undefined;
      const who = guest ? null : needAccount(ctx);
      if (!guest && !who) return;
      const declared = Number(ctx.req.headers['content-length']);
      if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) return sendJson(ctx, 413, { error: 'the picture is too big' });
      // Anyone may draw the shared guest picture, but only once it is missing.
      if (guest && avatarStore.imageFor('-1')) return sendJson(ctx, 200, { ok: true, kept: true });
      const result = avatarStore.saveImage(guest ? 'guest' : who.userId, await ctx.body());
      return sendJson(ctx, result.error ? 400 : 200, result);
    }
    if (action === 'guest-avatar' && method === 'GET') {
      const look = avatarStore.guest();
      return sendJson(ctx, 200, { bodyColors: look.bodyColors, assets: look.assets, hasImage: Boolean(avatarStore.imageFor('-1')) });
    }
    if (action === 'catalog' && method === 'GET') {
      const q = ctx.queryLower;
      const keyword = String(q.keyword || '').trim();
      const result = await search(String(q.category || 'hats'), keyword, String(q.cursor || ''), !keyword);
      if (result.error) return sendJson(ctx, result.status || 502, { error: result.error });
      return sendJson(ctx, 200, result);
    }
    if (action === 'categories' && method === 'GET') {
      return sendJson(ctx, 200, { categories: Object.entries(CATEGORIES).map(([key, value]) => ({ key, label: value.label, types: value.types || [] })) });
    }
    const item = /^item\/(\d{1,19})$/.exec(action);
    if (item && method === 'GET') {
      const result = await wearable(item[1]);
      if (result.error) return sendJson(ctx, result.status || 502, { error: result.error });
      return sendJson(ctx, 200, result);
    }
    const bundle = /^bundle\/(\d{1,12})$/.exec(action);
    if (bundle && method === 'GET') {
      const result = await bundleItems(bundle[1]);
      if (result.error) return sendJson(ctx, result.status || 502, { error: result.error });
      return sendJson(ctx, 200, result);
    }
    const people = await peopleRoute(ctx, action, method);
    if (people !== false) return people;
    return sendJson(ctx, 404, { error: 'unknown launcher request' });
  }

  // --- people, profiles and outfits ----------------------------------------------------------

  // A player as the People tab shows them, seen by viewer (an account or null).
  function personFor(person, viewer, online) {
    const where = online.find((entry) => entry.userId === person.userId
      || entry.name.toLowerCase() === person.name.toLowerCase()) || null;
    const self = Boolean(viewer && viewer.userId === person.userId);
    return {
      userId: person.userId,
      name: person.name,
      admin: Boolean(person.admin),
      self,
      online: where ? { gameId: where.gameId, gameName: where.gameName, placeId: where.placeId } : null,
      friendStatus: viewer && !self ? friends.status(viewer.userId, person.userId) : null,
    };
  }

  // Answers people/profile/outfit requests; false when the action is not one.
  async function peopleRoute(ctx, action, method) {
    if (action === 'people' && method === 'GET') {
      const viewer = account(ctx);
      const online = onlinePlayers();
      const found = accounts.search(ctx.queryLower.search || '', 60).map((person) => personFor(person, viewer, online))
        .sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)));
      return sendJson(ctx, 200, { people: found });
    }
    const profileMatch = /^profile\/(\d{1,15})$/.exec(action);
    if (profileMatch && method === 'GET') {
      const found = accounts.profile(profileMatch[1]);
      if (!found) return sendJson(ctx, 404, { error: 'Nobody on this server has that user ID.' });
      const person = personFor(found, account(ctx), onlinePlayers());
      return sendJson(ctx, 200, Object.assign(person, {
        bio: found.bio, joinedAt: found.joinedAt,
        friendCount: friends.friendIds(found.userId).filter((id) => accounts.byUserId(id)).length,
      }));
    }
    if (action === 'profile' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return undefined;
      const body = await jsonBody(ctx);
      if (typeof body.bio !== 'string') return sendJson(ctx, 400, { error: 'Send the bio as text.' });
      if (body.bio.length > 2000) return sendJson(ctx, 400, { error: `A bio is at most ${accounts.MAX_BIO} characters.` });
      const saved = accounts.setBio(who.userId, body.bio);
      return saved ? sendJson(ctx, 200, Object.assign(personFor(saved, who, onlinePlayers()), { bio: saved.bio, joinedAt: saved.joinedAt }))
        : sendJson(ctx, 404, { error: 'Your account is gone. Sign in again.' });
    }
    const image = /^outfit-image\/(\d{1,15})\/([0-9a-f]{12})$/.exec(action);
    if (image && method === 'GET') {
      const file = outfits.imagePath(image[1], image[2]);
      let bytes = null;
      try { bytes = file ? fs.readFileSync(file) : null; } catch (error) { bytes = null; }
      if (!bytes) return sendJson(ctx, 404, { error: 'no picture' });
      return send(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }, bytes);
    }
    if (action === 'outfits' && method === 'GET') {
      const who = needAccount(ctx);
      if (who) sendJson(ctx, 200, { outfits: outfits.list(who.userId), max: outfits.MAX_OUTFITS });
      return undefined;
    }
    if (action === 'outfits' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return undefined;
      const body = await jsonBody(ctx);
      const wearing = await describeAvatar(who);
      let picture = null;
      if (typeof body.image === 'string' && body.image) {
        picture = Buffer.from(body.image.replace(/^data:image\/png;base64,/, ''), 'base64');
      }
      const result = outfits.add(who.userId, { name: body.name, avatar: wearing, image: picture });
      if (result.error) return sendJson(ctx, 400, { error: result.error });
      return sendJson(ctx, 200, { outfit: result.outfit, outfits: outfits.list(who.userId), max: outfits.MAX_OUTFITS });
    }
    const outfitMatch = /^outfits\/([0-9a-f]{12})\/(wear|rename|delete)$/.exec(action);
    if (outfitMatch && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return undefined;
      const [, id, verb] = outfitMatch;
      const outfit = outfits.get(who.userId, id);
      if (!outfit) return sendJson(ctx, 404, { error: 'That outfit is gone.' });
      if (verb === 'delete') {
        outfits.remove(who.userId, id);
        return sendJson(ctx, 200, { outfits: outfits.list(who.userId), max: outfits.MAX_OUTFITS });
      }
      if (verb === 'rename') {
        const body = await jsonBody(ctx);
        outfits.rename(who.userId, id, body.name);
        return sendJson(ctx, 200, { outfits: outfits.list(who.userId), max: outfits.MAX_OUTFITS });
      }
      // Wear: checked again like an edit (items may have stopped working).
      const cleaned = await cleanAvatar({ bodyColors: outfit.bodyColors, assets: outfit.assets });
      if (cleaned.error) return sendJson(ctx, 400, { error: cleaned.error });
      avatarStore.set(who.userId, cleaned.avatar, 'outfit');
      return sendJson(ctx, 200, Object.assign(await describeAvatar(who), { outfit: outfit.name }));
    }
    return false;
  }

  return {
    routes: [
      [/^api\/launcher\/([a-z0-9/-]+?)\/?$/i, route],
      [/^user\/request-friendship\/?$/i, gameFriendRoute('request')],
      [/^user\/accept-friend-request\/?$/i, gameFriendRoute('accept')],
      [/^user\/decline-friend-request\/?$/i, gameFriendRoute('decline')],
      [/^user\/unfriend\/?$/i, gameFriendRoute('unfriend')],
      [/^user\/get-friendship-count\/?$/i, gameFriendRoute('count')],
      [/^user\/friend-statuses\/?$/i, gameFriendRoute('statuses')],
      [/^friends\/filter-requests\/?$/i, gameFriendRoute('filter-requests')],
      [/^users\/filter-friends\/?$/i, gameFriendRoute('filter-friends')],
      [/^user\/multiget-friend-requests\/?$/i, gameFriendRoute('multiget-requests')],
      [/^users\/(\d{1,15})\/friends\/?$/i, gameFriendRoute('friend-list')],
    ],
    joinIdentity,
    joinSignature,
    checkJoinSignature,
    guestIdentity,
  };
};
