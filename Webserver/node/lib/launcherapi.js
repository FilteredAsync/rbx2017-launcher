'use strict';

// What the launcher asks the web server for (all under /api/launcher/):
//
//   POST login            {name, password, mode: "signin"|"signup"} -> {token, account}
//   POST logout           (session)
//   GET  me               (session) -> {account}
//   POST join             (session, or none for a guest) one of
//                           {placeId}    any public server of the game with room
//                           {gameId}     that server (its job ID)
//                           {privateId}  a private server you may join
//                         -> {ticket, name, userId, guest, game: {id, name, placeId, address}}
//                         or 202 {starting: true}: a server is starting; ask again in a moment
//   GET  games            the games: each with its public servers and players
//   GET  private-servers  (session) ?placeId= the private servers you may join
//   POST private-servers  (session) {placeId, name} makes one (you own it)
//   POST private-servers/redeem       (session) {code}: join one by its invite code
//   POST private-servers/<id>/rename {name} | friends {on} | code | delete | leave   (session)
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
//   GET  profile/<userId> a player's profile: bio, where they play, friends, follows
//   POST profile          (session) {bio} -> your profile
//   POST presence         (session) {state: "online"|"studio"|"game"|"offline", placeId?}
//                         the launcher is open (every 30 s); lib/presence.js
//   GET  following        (session) who you follow, and who follows you
//   POST follow | unfollow   (session) {userId} -> their profile
//   POST report           (session) {userId, reason, text}: reports a player to the admins
//   POST block | unblock  (session) {userId} -> their profile (lib/blocks.js)
//   POST warm             {placeId}: start a server for a game whose page is open
//   GET  outfits          (session) your saved avatars
//   POST outfits          (session) {name, image: PNG as base64} saves what you wear
//   POST outfits/<id>/wear | rename {name} | delete   (session)
//   GET  outfit-image/<userId>/<id>   an outfit's picture
//   GET  game/<placeId>   a game's page: votes, badges (earned or not) and game passes
//                         (owned or not); badges/passes null while first looked up
//   POST game/<placeId>/vote   (session) {vote: 1 | -1 | 0} -> {votes}
//   GET  robux            (session) your Robux: {balance, earn, history}
//                         (lib/robux.js); also gives the daily bonus
//   GET  picture/<userId> an account's saved avatar picture (PNG), for the website
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
const follows = require('./follows');
const blocks = require('./blocks');
const presence = require('./presence');
const places = require('./places');
const privateservers = require('./privateservers');
const gamethumbs = require('./gamethumbs');
const creators = require('./creators');
const outfits = require('./outfits');
const announcements = require('./announcements');
const wearables = require('./wearables');
const marketplace = require('./marketplace');
const badges = require('./badges');
const ownership = require('./ownership');
const votes = require('./votes');
const robux = require('./robux');

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
  // Roblox's catalog does not list body parts on their own: these come out of
  // its packages, so parts of different packages can be mixed.
  torsos: { types: [27], fromPackages: true, label: 'Torsos' },
  rightarms: { types: [28], fromPackages: true, label: 'Right arms' },
  leftarms: { types: [29], fromPackages: true, label: 'Left arms' },
  leftlegs: { types: [30], fromPackages: true, label: 'Left legs' },
  rightlegs: { types: [31], fromPackages: true, label: 'Right legs' },
};
// A package's parts are named "<package> Torso", "<package> Right Arm"...
const PART_NAMES = { 27: /\btorso$/i, 28: /\bright arm$/i, 29: /\bleft arm$/i, 30: /\bleft leg$/i, 31: /\bright leg$/i };
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
// Request bodies (ctx.body(limit), server.js): the 2017 friend and follow
// calls send a few form fields; pictures are PNGs (lib/avatarstore.js and
// lib/outfits.js check their own sizes), an outfit's as base64 in JSON.
const FORM_LIMIT = 64 * 1024;
const AVATAR_IMAGE_LIMIT = 2 * 1024 * 1024;
const OUTFIT_JSON_LIMIT = 3 * 1024 * 1024;

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

  // gameId: the server it is for (a private server lets in only its tickets).
  function newTicket(identity, gameId = null) {
    pruneTickets();
    const ticket = crypto.randomBytes(16).toString('hex');
    tickets.set(ticket, Object.assign({}, identity, { gameId, expires: Date.now() + TICKET_MS }));
    return ticket;
  }

  // True when the ticket was handed out for that server.
  function ticketAllows(ticket, gameId) {
    pruneTickets();
    const entry = /^[0-9a-f]{32}$/.test(String(ticket || '')) ? tickets.get(ticket) : null;
    return Boolean(entry && entry.gameId && entry.gameId === gameId);
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
    const game = entry && entry.gameId ? games.get(String(entry.gameId)) : null;
    if (remote) players.set(addressKey(remote), Object.assign({ at: Date.now(), placeId: game ? String(game.placeId) : null }, who));
    return who;
  }

  // The Android app's placelauncher (lib/mobile.js): the player is the
  // signed-in account (its cookie), else a guest; body { placeId } or
  // { gameId }. -> { game, identity }, { starting: true } or { status, error }.
  // Its address stands for the player too, as with joinIdentity.
  function mobileJoin(ctx, body) {
    const who = account(ctx);
    const chosen = chooseServer(body, who);
    if (chosen.error || chosen.starting) return chosen;
    const identity = who ? { name: who.name, userId: who.userId, guest: false } : guestIdentity();
    noteJoin(chosen.game.id, identity.name);
    if (ctx.remote) players.set(addressKey(ctx.remote), Object.assign({ at: Date.now(), placeId: String(chosen.game.placeId) }, identity));
    return { game: gameFor(chosen.game), identity };
  }

  // The game the player at that address joined last (missing assets name it), or null.
  function placeAt(remote) {
    const entry = players.get(addressKey(remote));
    return entry && entry.at > Date.now() - PLAYER_MS && entry.placeId ? entry.placeId : null;
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

  // The always-on server's last report, or null when it is not running.
  function runner() {
    const status = places.runnerStatus();
    return status && !status.stale ? status : null;
  }

  // Its game servers by job ID ({ placeId, privateId, state, players, ... }).
  function runnerServers(status = runner()) {
    return status && status.servers && typeof status.servers === 'object' ? status.servers : {};
  }

  // Player names from a status report (older ones held several names in
  // one, XML-escaped).
  function namesIn(list) {
    if (!Array.isArray(list)) return [];
    return [].concat(...list.map((raw) => String(raw).split(/&#xA;|\n/i).map((text) => text.trim()).filter(Boolean)));
  }

  function libraryPlaces() {
    return places.exists() ? places.load().places : {};
  }

  // Who is in which server right now (gameId: the server's job ID).
  function onlinePlayers() {
    const library = libraryPlaces();
    const result = [];
    for (const [jobId, entry] of Object.entries(runnerServers())) {
      if (!entry) continue;
      const place = library[entry.placeId];
      for (const name of namesIn(entry.players)) {
        const known = accounts.byName(name);
        const guestMatch = /^Guest[ _](\d{1,6})$/.exec(name);
        result.push({
          name,
          userId: known ? known.userId : guestMatch ? -Number(guestMatch[1]) : null,
          guest: Boolean(guestMatch),
          placeId: String(entry.placeId),
          gameId: jobId,
          privateServer: Boolean(entry.privateId),
          gameName: place ? place.name : `Place ${entry.placeId}`,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  // The play clock: every minute, each account in a game server (by the
  // servers' own player lists) gets a minute towards its Robux for playing
  // (lib/robux.js), and developer products a game never granted are refunded.
  const playClock = setInterval(() => {
    try {
      robux.playMinute(onlinePlayers().filter((player) => !player.guest && player.userId > 0).map((player) => player.userId));
    } catch (error) { /* tried again next minute */ }
    try { marketplace.expireReceipts(); } catch (error) { /* next minute */ }
  }, 60 * 1000);
  if (playClock.unref) playClock.unref();

  // What presence needs, worked out once per request: who is in which game,
  // and who is editing in Team Create.
  function presenceContext() {
    const status = runner();
    const editing = new Set();
    for (const edit of Object.values(status && status.cloudEdit && typeof status.cloudEdit === 'object' ? status.cloudEdit : {})) {
      for (const name of namesIn(edit && edit.editors)) editing.add(name.toLowerCase());
    }
    return { online: onlinePlayers(), editing };
  }

  // -> { presence: "game"|"studio"|"online"|"offline", online: where they play or null }
  // A game on the always-on server wins (it has the server to join), then
  // what the player's launcher says, then Team Create.
  function presenceOf(userId, name, context) {
    const lower = String(name || '').toLowerCase();
    const where = context.online.find((entry) => entry.userId === userId || entry.name.toLowerCase() === lower) || null;
    if (where) {
      return { presence: 'game', online: { gameId: where.gameId, gameName: where.gameName, placeId: where.placeId, privateServer: where.privateServer } };
    }
    const said = presence.of(userId);
    if (said && said.state === 'game') {
      const place = said.placeId ? libraryPlaces()[said.placeId] : null;
      return { presence: 'game', online: null, gameName: place ? place.name : null };
    }
    if ((said && said.state === 'studio') || context.editing.has(lower)) return { presence: 'studio', online: null };
    return { presence: said ? 'online' : 'offline', online: null };
  }

  // --- choosing a server ----------------------------------------------------------------

  // Players handed a ticket for a server in the last minute, who may not show
  // in its player list yet: they count towards it being full.
  const recentJoins = new Map(); // jobId -> Map(name -> time)
  const RECENT_MS = 60 * 1000;

  function noteJoin(jobId, name) {
    const list = recentJoins.get(jobId) || new Map();
    list.set(name, Date.now());
    recentJoins.set(jobId, list);
  }

  function fillOf(jobId, server) {
    const players = namesIn(server && server.players);
    const list = recentJoins.get(jobId);
    let coming = 0;
    if (list) {
      for (const [name, at] of list) {
        if (Date.now() - at > RECENT_MS) list.delete(name);
        else if (!players.includes(name)) coming++;
      }
      if (list.size === 0) recentJoins.delete(jobId);
    }
    return players.length + coming;
  }

  // The game list (games.listAll) has the address as text already; a server
  // looked up by job ID (games.get, "Join" on a friend) has it as {host, port}.
  function gameFor(game) {
    const address = game.address && typeof game.address === 'object' ? games.addressText(game.address) : game.address;
    return { id: game.id, name: game.name, placeId: String(game.placeId), address, privateId: game.privateId || null };
  }

  // Servers of a game (or a private server) that have room, fullest first.
  function openServers(placeId, privateId) {
    const servers = runnerServers();
    const place = libraryPlaces()[placeId];
    return games.listAll()
      .filter((game) => String(game.placeId) === String(placeId) && (game.privateId || null) === (privateId || null))
      .map((game) => {
        const server = servers[game.id] || null; // null: hosted from another PC
        const max = game.maxPlayers || (place ? places.maxPlayersOf(place) : 100);
        return { game, server, count: fillOf(game.id, server), max };
      })
      .filter((entry) => (!entry.server || entry.server.state === 'running') && entry.count < entry.max)
      .sort((a, b) => b.count - a.count);
  }

  // No server with room: one starting, or ask the always-on server for one.
  const pendingStarts = new Map(); // "placeId" or "placeId/privateId" -> { requestId, at }
  const START_WAIT_MS = 120 * 1000;

  function serverComing(placeId, privateId) {
    const status = runner();
    if (!status) return { status: 503, error: 'The game server PC is not running its games right now. Try again later.' };
    const key = privateId ? `${placeId}/${privateId}` : placeId;
    const pending = pendingStarts.get(key);
    if (pending && Date.now() - pending.at > START_WAIT_MS) pendingStarts.delete(key);
    const failed = pending && (status.startFailures || []).find((entry) => entry.id === pending.requestId);
    if (failed) {
      pendingStarts.delete(key);
      return { status: 503, error: failed.error };
    }
    const mine = Object.values(runnerServers(status)).filter((server) => String(server.placeId) === String(placeId)
      && (server.privateId || null) === (privateId || null) && server.state !== 'stopping');
    if (mine.some((server) => server.state === 'starting' || server.state === 'restarting')) return { starting: true };
    const broken = mine.find((server) => server.state === 'error');
    if (broken) return { status: 503, error: `The game's server could not start (${broken.lastError || 'unknown error'}). Try again in a few minutes.` };
    // Started, but not on the game list yet (it registers as it starts).
    if (mine.some((server) => server.state === 'running' && !games.get(server.jobId))) return { starting: true };
    if (!pendingStarts.has(key)) pendingStarts.set(key, { requestId: places.requestStart(placeId, privateId), at: Date.now() });
    return { starting: true };
  }

  // -> { game } (a server to join), { starting: true } or { status, error }
  function chooseServer(body, who) {
    const library = libraryPlaces();
    const privateCheck = (privateId) => {
      const server = privateservers.get(privateId);
      if (!server) return { status: 404, error: 'That private server no longer exists.' };
      if (!who) return { status: 401, error: 'Sign in to join private servers.' };
      if (!privateservers.canJoin(server, who.userId)) return { status: 403, error: 'That is a private server. Ask its owner for an invite code.' };
      return { server };
    };
    if (body.gameId) {
      const game = games.get(String(body.gameId));
      if (!game) return { status: 404, error: 'That server is no longer running. Press Play to join another one.' };
      if (game.privateId) {
        const check = privateCheck(game.privateId);
        if (check.error) return check;
      }
      const place = library[game.placeId];
      const max = game.maxPlayers || (place ? places.maxPlayersOf(place) : 100);
      if (fillOf(game.id, runnerServers()[game.id]) >= max) return { status: 409, error: 'That server is full. Press Play to join another one.' };
      return { game };
    }
    let placeId;
    let privateId = null;
    if (body.privateId) {
      const check = privateCheck(String(body.privateId));
      if (check.error) return check;
      placeId = check.server.placeId;
      privateId = check.server.id;
    } else {
      placeId = places.placeKey(body.placeId);
      if (placeId === null) return { status: 400, error: 'Which game? (placeId)' };
    }
    const place = library[placeId];
    if (place && !place.enabled) return { status: 404, error: 'This game is not online right now.' };
    const open = openServers(placeId, privateId);
    if (open.length) {
      // A start asked for earlier has done its job: the next full server asks again.
      pendingStarts.delete(privateId ? `${placeId}/${privateId}` : placeId);
      return { game: open[0].game };
    }
    if (!place) {
      // Not in this server's library: hosted from another PC (hostGame.bat).
      const any = !privateId && games.list().some((game) => String(game.placeId) === placeId);
      return any ? { status: 409, error: 'Every server of this game is full right now.' } : { status: 404, error: 'This game is not online right now.' };
    }
    return serverComing(placeId, privateId);
  }

  // --- the game list ------------------------------------------------------------------------

  // Every game players can join: library games that are online (their
  // servers start when someone joins) and games hosted from other PCs.
  function gameList() {
    const library = libraryPlaces();
    creators.fillMissing();
    const status = runner();
    const servers = runnerServers(status);
    const result = new Map();
    const entryFor = (placeId, fields) => Object.assign({
      placeId: String(placeId), name: `Place ${placeId}`, description: '', creator: '', thumbnail: gamethumbs.version(placeId),
      maxPlayers: null, canStart: false, starting: false, playing: 0, servers: [],
    }, fields);
    for (const [placeId, place] of Object.entries(library)) {
      if (!place.enabled) continue;
      const creator = places.creatorOf(place);
      result.set(placeId, entryFor(placeId, {
        name: place.name, description: place.description || '', creator: creator ? creator.name : '',
        maxPlayers: places.maxPlayersOf(place), canStart: Boolean(status),
      }));
    }
    for (const game of games.listAll()) {
      let entry = result.get(String(game.placeId));
      if (!entry) {
        if (library[game.placeId]) continue; // turned off: its servers are stopping
        entry = entryFor(game.placeId, { name: game.name, maxPlayers: game.maxPlayers });
        result.set(entry.placeId, entry);
      }
      const server = servers[game.id] || null;
      const players = namesIn(server && server.players);
      entry.playing += players.length;
      if (game.privateId) continue;
      entry.servers.push({ id: game.id, players, playing: players.length, maxPlayers: game.maxPlayers || entry.maxPlayers, upSeconds: game.upSeconds });
    }
    for (const server of Object.values(servers)) {
      const entry = result.get(String(server.placeId));
      if (entry && !server.privateId && (server.state === 'starting' || server.state === 'restarting')) entry.starting = true;
    }
    for (const entry of result.values()) entry.servers.sort((a, b) => b.playing - a.playing || b.upSeconds - a.upSeconds);
    return [...result.values()].sort((a, b) => b.playing - a.playing || a.name.localeCompare(b.name));
  }

  // --- private servers ----------------------------------------------------------------------

  function privateFor(server, viewer, servers = runnerServers(), library = libraryPlaces()) {
    const owner = accounts.byUserId(server.ownerId);
    const mine = Boolean(viewer && viewer.userId === server.ownerId);
    const running = Object.values(servers).filter((entry) => entry.privateId === server.id);
    const players = [].concat(...running.map((entry) => namesIn(entry.players)));
    const place = library[server.placeId];
    const result = {
      id: server.id,
      placeId: server.placeId,
      gameName: place ? place.name : `Place ${server.placeId}`,
      gameOnline: Boolean(place && place.enabled),
      name: server.name,
      owner: { userId: server.ownerId, name: owner ? owner.name : `User ${server.ownerId}` },
      mine,
      friendsCanJoin: server.friends,
      running: running.some((entry) => entry.state === 'running'),
      players,
      playing: players.length,
    };
    if (mine) Object.assign(result, { code: server.code, members: server.members.length });
    return result;
  }

  async function privateRoute(ctx, who, action, method) {
    if (action === 'private-servers' && method === 'GET') {
      const placeId = ctx.queryLower.placeid ? places.placeKey(ctx.queryLower.placeid) : null;
      const servers = runnerServers();
      const library = libraryPlaces();
      return sendJson(ctx, 200, {
        servers: privateservers.visibleTo(who.userId, placeId).map((server) => privateFor(server, who, servers, library)),
        max: privateservers.MAX_PER_OWNER,
      });
    }
    if (method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
    const body = await jsonBody(ctx);
    if (action === 'private-servers') {
      const placeId = places.placeKey(body.placeId);
      const place = placeId ? libraryPlaces()[placeId] : null;
      if (!place || !place.enabled) return sendJson(ctx, 404, { error: 'This game is not online on this server, so it cannot have private servers.' });
      const result = privateservers.create(who, placeId, body.name || `${who.name}'s server`);
      if (result.error) return sendJson(ctx, 400, { error: result.error });
      return sendJson(ctx, 200, { server: privateFor(result.server, who) });
    }
    if (action === 'private-servers/redeem') {
      const result = privateservers.redeem(body.code, who.userId);
      if (result.error) return sendJson(ctx, 404, { error: result.error });
      return sendJson(ctx, 200, { server: privateFor(result.server, who) });
    }
    const match = /^private-servers\/([0-9a-f]{12})\/(rename|friends|code|delete|leave)$/.exec(action);
    const server = match ? privateservers.get(match[1]) : null;
    if (!server) return sendJson(ctx, 404, { error: 'That private server no longer exists.' });
    const verb = match[2];
    if (verb === 'leave') {
      privateservers.leave(server.id, who.userId);
      return sendJson(ctx, 200, { ok: true });
    }
    if (server.ownerId !== who.userId && !(verb === 'delete' && who.admin)) return sendJson(ctx, 403, { error: 'Only its owner can change this private server.' });
    let result;
    if (verb === 'rename') result = privateservers.rename(server.id, body.name);
    else if (verb === 'friends') result = privateservers.setFriends(server.id, body.on);
    else if (verb === 'code') result = privateservers.resetCode(server.id);
    else result = privateservers.remove(server.id);
    if (result.error) return sendJson(ctx, 400, { error: result.error });
    return sendJson(ctx, 200, result.server ? { server: privateFor(result.server, who) } : { ok: true });
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

  // Wear a package (bundle): its body parts, head and face replace those the
  // account's saved avatar wears; hats, clothes and colors stay.
  async function wearBundle(who, bundleId) {
    const bundle = await bundleItems(String(bundleId));
    if (bundle.error) return bundle;
    if (bundle.items.length === 0) return { error: 'This package has nothing to wear.' };
    const current = await describeAvatar(who);
    const replaced = new Set(bundle.items.map((item) => item.typeId));
    const assets = current.assets.filter((asset) => !replaced.has(asset.typeId)).concat(bundle.items);
    const cleaned = await cleanAvatar({ bodyColors: current.bodyColors, assets });
    if (cleaned.error) return cleaned;
    avatarStore.set(who.userId, cleaned.avatar, 'edited');
    return { ok: true };
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
      price: Number.isInteger(raw.price) ? raw.price : null,
    };
    if (!bundle && item.typeId) rememberDetails(item.id, item.typeId, item.name);
    return item;
  }

  // Package ID -> its assets [{id, name}], filled many packages at a time.
  const packageParts = new Map();
  async function partsFromPackages(category, keyword, cursor, classicOnly) {
    const packages = await search('packages', keyword, cursor, classicOnly);
    if (packages.error) return packages;
    const missing = packages.items.map((item) => item.id).filter((id) => !packageParts.has(id));
    if (missing.length) {
      const answer = await queued(() => robloxJson(`https://catalog.roblox.com/v1/bundles/details?bundleIds=${missing.join(',')}`));
      if (answer.error) return answer;
      for (const bundle of Array.isArray(answer.data) ? answer.data : []) {
        packageParts.set(String(bundle.id), (Array.isArray(bundle.items) ? bundle.items : [])
          .filter((item) => item.type === 'Asset').map((item) => ({ id: String(item.id), name: String(item.name || '').trim() })));
      }
      if (packageParts.size > 3000) packageParts.delete(packageParts.keys().next().value);
    }
    const typeId = category.types[0];
    const items = [];
    for (const pack of packages.items) {
      const part = (packageParts.get(pack.id) || []).find((entry) => PART_NAMES[typeId].test(entry.name));
      if (!part) continue;
      rememberDetails(part.id, typeId, part.name);
      items.push({ id: part.id, kind: 'asset', name: part.name, typeId, creator: 'Roblox' });
    }
    return { items, nextCursor: packages.nextCursor };
  }

  async function search(categoryKey, keyword, cursor, classicOnly) {
    const category = CATEGORIES[categoryKey];
    if (!category) return { error: 'Unknown category.', status: 400 };
    if (category.fromPackages) return partsFromPackages(category, keyword, cursor, classicOnly);
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
    // price: Robux, 0 when free, null when not for sale.
    const product = data.product || {};
    const price = product.isFree ? 0 : product.isForSale && Number.isInteger(product.priceInRobux) ? product.priceInRobux : null;
    const result = { id: String(id), name: String(data.name || ''), description: String(data.description || ''), price, items };
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

  // Online first: in a game, in Studio, launcher open, then offline.
  const PRESENCE_ORDER = { game: 0, studio: 1, online: 2, offline: 3 };
  const byPresence = (a, b) => (PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence]) || a.name.localeCompare(b.name);

  function friendSummary(who) {
    const context = presenceContext();
    const person = (userId) => {
      const account = accounts.byUserId(userId);
      const name = account ? account.name : `User ${userId}`;
      return Object.assign({ userId, name }, presenceOf(userId, name, context));
    };
    const list = friends.friendIds(who.userId).filter((id) => accounts.byUserId(id)).map(person).sort(byPresence);
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

  // The parameters of a friend call: from the address, and for a POST (how
  // RCC's FriendService asks: users/filter-friends) also from the body,
  // form-encoded or JSON. Keys lowercased; a repeated key (otherUserIds once
  // per player) becomes a comma list.
  async function friendParams(ctx) {
    const q = Object.assign({}, ctx.queryLower);
    if (ctx.method !== 'POST') return q;
    const text = (await ctx.body(FORM_LIMIT)).toString('utf8').trim();
    if (!text) return q;
    if (text[0] === '{') {
      try {
        for (const [key, value] of Object.entries(JSON.parse(text))) q[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
      } catch (error) { /* not JSON after all */ }
      return q;
    }
    const seen = new Set();
    for (const [key, value] of new URLSearchParams(text)) {
      const k = key.toLowerCase();
      q[k] = seen.has(k) && q[k] ? `${q[k]},${value}` : value;
      seen.add(k);
    }
    // A body in some other shape: note it in the web log (/manage > Server).
    if (!q.userid && Date.now() - lastOddFriendBody > 60000) {
      lastOddFriendBody = Date.now();
      core.appendLog(core.rootPath('Webserver', 'node', 'logs', 'server.log'),
        `${core.gmdate()}  friends: unreadable ${ctx.req.url} body from ${ctx.remote}: ${JSON.stringify(text.slice(0, 200))}`, 5 * 1024 * 1024);
    }
    return q;
  }
  let lastOddFriendBody = 0;

  function gameFriendRoute(kind) {
    return async (ctx, match) => {
      const q = await friendParams(ctx);
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

  // --- the 2017 player list's Block and Follow --------------------------------------------
  // RCC (for the client): POST userblock/blockuser | unblockuser  blockerId=&blockeeId=
  // Client: GET userblock/getblockedusers?userId=&page=  -> {success, userList}
  // Client: GET user/following-exists?userId=&followerUserId=  -> {success, isFollowing}
  // Client: POST user/follow | user/unfollow  followedUserId=  (the player is who joined from that address)
  // RCC:    POST user/multi-following-exists {userId, otherUserIds}  -> {FollowingDetails}

  // RCC on the server PC, or a game server another PC registered.
  function fromGameServer(remote) {
    const address = String(remote || '').replace(/^::ffff:/i, '');
    if (address === '::1' || /^127\./.test(address)) return true;
    return games.listAll().some((listed) => {
      const game = games.get(listed.id);
      return Boolean(game && String(game.registeredFrom || '').replace(/^::ffff:/i, '') === address);
    });
  }

  function socialRoute(kind) {
    return async (ctx) => {
      if ((kind === 'block' || kind === 'unblock') && !fromGameServer(ctx.remote)) {
        return sendJson(ctx, 403, { success: false, message: 'Only game servers can do that.' });
      }
      const q = await friendParams(ctx);
      const reply = (value) => sendJson(ctx, 200, value);
      if (kind === 'block' || kind === 'unblock') {
        const blocker = Number(q.blockerid);
        const blockee = Number(q.blockeeid);
        if (!accounts.byUserId(blocker) || !accounts.byUserId(blockee)) return reply({ success: false, message: 'Guests cannot block or be blocked.' });
        const result = kind === 'block' ? blocks.block(blocker, blockee) : blocks.unblock(blocker, blockee);
        return reply(result.error ? { success: false, message: result.error } : { success: true });
      }
      if (kind === 'blocked-list') {
        const page = Math.max(1, Number(q.page) || 1);
        return reply({ success: true, userList: page === 1 ? blocks.blockedBy(Number(q.userid)) : [] });
      }
      if (kind === 'following-exists') {
        return reply({ success: true, isFollowing: follows.isFollowing(Number(q.followeruserid), Number(q.userid)) });
      }
      if (kind === 'multi-following') {
        const me = Number(q.userid);
        const data = follows.load();
        return reply({
          FollowingDetails: idList(q.otheruserids).map((other) => ({
            UserId1: me, UserId2: other,
            User1FollowsUser2: follows.isFollowing(me, other, data),
            User2FollowsUser1: follows.isFollowing(other, me, data),
          })),
        });
      }
      const me = playerAt(ctx.remote);
      if (!me) return reply({ success: false, message: 'Only signed-in players can follow.' });
      const target = Number(q.followeduserid);
      if (!accounts.byUserId(target)) return reply({ success: false, message: 'That player cannot be followed.' });
      const result = kind === 'follow' ? follows.follow(me.userId, target) : follows.unfollow(me.userId, target);
      return reply(result.error ? { success: false, message: result.error } : { success: true });
    };
  }

  // --- warming a server -----------------------------------------------------------------------
  // Opening a game's page in the launcher starts a server for it when none is
  // running, so it's usually ready by the time Play is pressed.
  const warmed = new Map(); // placeId -> time asked
  function warm(placeId) {
    const id = String(placeId || '');
    const place = libraryPlaces()[id];
    if (!place || !place.enabled || !runner()) return false;
    if (Date.now() - (warmed.get(id) || 0) < 60 * 1000) return false;
    warmed.set(id, Date.now());
    if (openServers(id, null).length) return false;
    const coming = serverComing(id, null);
    return Boolean(coming.starting);
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
      const who = account(ctx);
      if (!who && !body.guest) return sendJson(ctx, 401, { error: 'Your sign-in ran out. Sign in again, or play as a guest.' });
      const chosen = chooseServer(body, who);
      if (chosen.error) return sendJson(ctx, chosen.status || 400, { error: chosen.error });
      if (chosen.starting) return sendJson(ctx, 202, { starting: true, message: 'Starting a server…', retryMs: 1000 });
      const identity = who ? { name: who.name, userId: who.userId, guest: false } : guestIdentity();
      noteJoin(chosen.game.id, identity.name);
      return sendJson(ctx, 200, Object.assign({ ticket: newTicket(identity, chosen.game.id), game: gameFor(chosen.game) }, identity));
    }
    if (action === 'games' && method === 'GET') {
      return sendJson(ctx, 200, { games: gameList() });
    }
    if (action === 'warm' && method === 'POST') {
      const body = await jsonBody(ctx);
      return sendJson(ctx, 200, { starting: warm(body.placeId) });
    }
    if ((action === 'block' || action === 'unblock') && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return;
      const other = friendTarget(await jsonBody(ctx));
      if (!other) return sendJson(ctx, 404, { error: 'No such player.' });
      const result = action === 'block' ? blocks.block(who.userId, other.userId) : blocks.unblock(who.userId, other.userId);
      if (result.error) return sendJson(ctx, 400, { error: result.error });
      return sendJson(ctx, 200, profileOf(accounts.profile(other.userId), who));
    }
    if (action === 'private-servers' || action.startsWith('private-servers/')) {
      const who = needAccount(ctx);
      if (who) await privateRoute(ctx, who, action, method);
      return;
    }
    const friendsMatch = /^friends(?:\/(request|accept|decline|cancel|remove))?$/.exec(action);
    if (friendsMatch && (friendsMatch[1] ? method === 'POST' : method === 'GET')) {
      const who = needAccount(ctx);
      if (who) await friendsRoute(ctx, who, friendsMatch[1] || null);
      return;
    }
    if (action === 'presence' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return;
      const body = await jsonBody(ctx);
      presence.report(who.userId, String(body.state || ''), body.placeId);
      try { robux.checkIn(who.userId); } catch (error) { /* the next beat */ }
      return sendJson(ctx, 200, { ok: true, everySeconds: 30 });
    }
    // An account's saved avatar picture, for the website (only saved ones:
    // a made-up ID costs a file lookup, never a Roblox one).
    const picture = /^picture\/(\d{1,15})$/.exec(action);
    if (picture && method === 'GET') {
      const image = accounts.byUserId(picture[1]) ? avatarStore.imageFor(picture[1]) : null;
      if (!image) return sendJson(ctx, 404, { error: 'No picture saved for this player yet.' });
      return send(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' }, image);
    }
    if (action === 'robux' && method === 'GET') {
      const who = needAccount(ctx);
      if (!who) return;
      robux.checkIn(who.userId);
      return sendJson(ctx, 200, robux.summary(who.userId));
    }
    if (action === 'following' && method === 'GET') {
      const who = needAccount(ctx);
      if (!who) return;
      const context = presenceContext();
      const people = (ids) => ids.map((id) => accounts.byUserId(id)).filter(Boolean).map((found) => personFor(found, who, context)).sort(byPresence);
      return sendJson(ctx, 200, { following: people(follows.following(who.userId)), followers: people(follows.followers(who.userId)), max: follows.MAX_FOLLOWING });
    }
    if ((action === 'follow' || action === 'unfollow') && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return;
      const other = friendTarget(await jsonBody(ctx));
      if (!other) return sendJson(ctx, 404, { error: 'No such player.' });
      const result = action === 'follow' ? follows.follow(who.userId, other.userId) : follows.unfollow(who.userId, other.userId);
      if (result.error) return sendJson(ctx, 400, { error: result.error });
      return sendJson(ctx, 200, profileOf(accounts.profile(other.userId), who));
    }
    if (action === 'report' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return;
      const body = await jsonBody(ctx);
      const other = friendTarget(body);
      if (!other) return sendJson(ctx, 404, { error: 'No such player.' });
      if (other.userId === who.userId) return sendJson(ctx, 400, { error: "You can't report yourself." });
      const reason = String(body.reason || '').trim();
      if (!reason) return sendJson(ctx, 400, { error: 'Pick a reason.' });
      try {
        require('./reports').add({ source: 'launcher', reporterId: who.userId, reportedId: other.userId, reason, text: String(body.text || '') });
      } catch (error) {
        return sendJson(ctx, 429, { error: error.message });
      }
      return sendJson(ctx, 200, { ok: true });
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
      if (Number.isFinite(declared) && declared > AVATAR_IMAGE_LIMIT) return sendJson(ctx, 413, { error: 'the picture is too big' });
      // Anyone may draw the shared guest picture, but only once it is missing.
      if (guest && avatarStore.imageFor('-1')) return sendJson(ctx, 200, { ok: true, kept: true });
      const result = avatarStore.saveImage(guest ? 'guest' : who.userId, await ctx.body(AVATAR_IMAGE_LIMIT));
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
    const gamePage = await gameRoute(ctx, action, method);
    if (gamePage !== false) return gamePage;
    const people = await peopleRoute(ctx, action, method);
    if (people !== false) return people;
    return sendJson(ctx, 404, { error: 'unknown launcher request' });
  }

  // --- a game's page: votes, badges, game passes ----------------------------------------------

  // Answers game/<placeId>[/vote]; false when the action is not one.
  async function gameRoute(ctx, action, method) {
    const match = /^game\/(\d{1,15})(?:\/(vote))?$/.exec(action);
    if (!match) return false;
    const place = places.exists() ? places.get(match[1]) : null;
    if (!place) return sendJson(ctx, 404, { error: 'There is no game with that place ID.' });
    if (match[2] === 'vote') {
      if (method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
      const who = needAccount(ctx);
      if (!who) return undefined;
      const body = await jsonBody(ctx);
      const vote = Number(body.vote);
      if (![1, -1, 0].includes(vote)) return sendJson(ctx, 400, { error: 'Vote 1, -1 or 0.' });
      return sendJson(ctx, 200, { votes: votes.cast(place.placeId, who.userId, vote) });
    }
    if (method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
    const viewer = account(ctx);
    const userId = viewer ? viewer.userId : 0;
    // The game's Roblox universe (from its upload) has its badges and passes.
    const [passList, badgeList] = await Promise.all([marketplace.universePasses(place.universeId), marketplace.universeBadges(place.universeId)]);
    return sendJson(ctx, 200, {
      placeId: place.placeId,
      votes: votes.of(place.placeId, userId),
      canVote: Boolean(viewer),
      badges: badgeList && badgeList.filter((badge) => badge.enabled).map((badge) => ({
        id: badge.id, name: badge.name, description: badge.description, icon: badge.icon, owned: Boolean(userId && badges.has(userId, badge.id)),
      })),
      passes: passList && passList.map((pass) => ({
        id: pass.id, name: pass.name, description: pass.description, price: pass.price, icon: pass.icon, owned: Boolean(userId && ownership.owns(userId, pass.id)),
      })),
    });
  }

  // --- people, profiles and outfits ----------------------------------------------------------

  // A player as the People tab shows them, seen by viewer (an account or null).
  // `online` (where they play) is what launchers before 1.8.0 read; `presence`
  // adds Studio and "launcher open".
  function personFor(person, viewer, context) {
    const self = Boolean(viewer && viewer.userId === person.userId);
    return Object.assign({
      userId: person.userId,
      name: person.name,
      admin: Boolean(person.admin),
      self,
      friendStatus: viewer && !self ? friends.status(viewer.userId, person.userId) : null,
      following: Boolean(viewer && !self && follows.isFollowing(viewer.userId, person.userId)),
    }, presenceOf(person.userId, person.name, context));
  }

  // A full profile: the person plus bio and counts.
  function profileOf(found, viewer, context = presenceContext()) {
    const data = follows.load();
    const live = (ids) => ids.filter((id) => accounts.byUserId(id)).length;
    return Object.assign(personFor(found, viewer, context), {
      bio: found.bio, joinedAt: found.joinedAt,
      friendCount: live(friends.friendIds(found.userId)),
      followerCount: live(follows.followers(found.userId, data)),
      followingCount: live(follows.following(found.userId, data)),
      followsYou: Boolean(viewer && viewer.userId !== found.userId && follows.isFollowing(found.userId, viewer.userId, data)),
      blocked: Boolean(viewer && viewer.userId !== found.userId && blocks.hasBlocked(viewer.userId, found.userId)),
    });
  }

  // Answers people/profile/outfit requests; false when the action is not one.
  async function peopleRoute(ctx, action, method) {
    if (action === 'people' && method === 'GET') {
      const viewer = account(ctx);
      const context = presenceContext();
      const found = accounts.search(ctx.queryLower.search || '', 60).map((person) => personFor(person, viewer, context)).sort(byPresence);
      return sendJson(ctx, 200, { people: found });
    }
    const profileMatch = /^profile\/(\d{1,15})$/.exec(action);
    if (profileMatch && method === 'GET') {
      const found = accounts.profile(profileMatch[1]);
      if (!found) return sendJson(ctx, 404, { error: 'Nobody on this server has that user ID.' });
      return sendJson(ctx, 200, profileOf(found, account(ctx)));
    }
    if (action === 'profile' && method === 'POST') {
      const who = needAccount(ctx);
      if (!who) return undefined;
      const body = await jsonBody(ctx);
      if (typeof body.bio !== 'string') return sendJson(ctx, 400, { error: 'Send the bio as text.' });
      if (body.bio.length > 2000) return sendJson(ctx, 400, { error: `A bio is at most ${accounts.MAX_BIO} characters.` });
      const saved = accounts.setBio(who.userId, body.bio);
      return saved ? sendJson(ctx, 200, profileOf(saved, who))
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
      const body = await jsonBody(ctx, OUTFIT_JSON_LIMIT);
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
      [/^userblock\/blockuser\/?$/i, socialRoute('block')],
      [/^userblock\/unblockuser\/?$/i, socialRoute('unblock')],
      [/^userblock\/getblockedusers\/?$/i, socialRoute('blocked-list')],
      [/^user\/following-exists\/?$/i, socialRoute('following-exists')],
      [/^user\/multi-following-exists\/?$/i, socialRoute('multi-following')],
      [/^user\/follow\/?$/i, socialRoute('follow')],
      [/^user\/unfollow\/?$/i, socialRoute('unfollow')],
    ],
    joinIdentity,
    playerAt,
    placeAt,
    ticketAllows,
    joinSignature,
    checkJoinSignature,
    guestIdentity,
    mobileJoin,
    gameList,
    // the Xbox app's avatar store (lib/xbox.js)
    packagePage: (cursor) => search('packages', '', cursor || '', true),
    bundleItems: (id) => bundleItems(String(id)),
    wearBundle,
    describeAvatar,
  };
};
