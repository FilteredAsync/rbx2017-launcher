'use strict';
// The Xbox One app (2016), rebuilt as a Windows app (UWP) from the 2016 engine
// source. It has no Xbox Live here, so it signs in with an account's username
// and password, and it talks to two names:
//   api.<domain>        sign-in (xboxlive/*), presence, balance, outfits
//   assetgame.<domain>  its Lua screens: game sorts and lists, details,
//                       thumbnails, votes, friends; and Game/PlaceLauncher.ashx
//                       (lib/mobile.js, shared with the Android app)
// Game pictures: the screens ask asset-thumbnail/json for a game's ImageId, so
// a game's ImageId is IMAGE_BASE + its place ID (far above real asset IDs).

const accounts = require('./accounts');
const robux = require('./robux');
const votes = require('./votes');
const friends = require('./friends');
const presence = require('./presence');
const gamethumbs = require('./gamethumbs');

const crypto = require('crypto');

const IMAGE_BASE = 9e12;
const SESSION_SECONDS = 30 * 24 * 3600;
// "Play as Guest" signs in with this name (no account can have it: NAME_RE has
// no ':'). Guests get a session for the app's own calls, kept in memory.
const GUEST_LINK_NAME = ':guest';
const GUEST_SECONDS = 24 * 3600;
const MAX_GUEST_SESSIONS = 2000;
const SORTS = [
  { Id: 1, Name: 'Popular' },
  { Id: 2, Name: 'Top Rated' },
  { Id: 3, Name: 'All Games' },
];

module.exports = function xboxApi({ send, sendUtf8, sendJson, launcher, sessionCookie }) {
  const hostOf = (ctx) => String(ctx.req.headers['x-forwarded-host'] || ctx.publicHost || ctx.req.headers.host || '')
    .replace(/:\d+$/, '').toLowerCase();
  const baseOf = (ctx) => `https://${hostOf(ctx)}/`;
  const json = (value) => (ctx) => sendJson(ctx, 200, value);
  const q = (ctx, name) => String(ctx.queryLower[name.toLowerCase()] ?? '');
  const int = (ctx, name, fallback = 0) => {
    const value = parseInt(q(ctx, name), 10);
    return Number.isFinite(value) ? value : fallback;
  };
  // The sign-in calls tell the app what went wrong with a word in the body
  // (XboxService.cpp httpErrorToAccountLinkResult).
  const word = (ctx, status, text) => send(ctx, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, text);
  const signedIn = (ctx, value, token) => sendUtf8(ctx, 200, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(ctx, token, SESSION_SECONDS),
  }, JSON.stringify(value));

  // --- guests -------------------------------------------------------------------------------
  const guests = new Map(); // session token -> { name, userId, until }
  function newGuest() {
    const now = Date.now();
    for (const [token, guest] of guests) if (guest.until < now) guests.delete(token);
    if (guests.size >= MAX_GUEST_SESSIONS) guests.delete(guests.keys().next().value);
    const identity = typeof launcher.guestIdentity === 'function'
      ? launcher.guestIdentity()
      : (() => { const number = 1000 + crypto.randomInt(9000); return { name: `Guest_${number}`, userId: -number }; })();
    const token = crypto.randomBytes(32).toString('hex');
    guests.set(token, { name: identity.name, userId: identity.userId, until: now + GUEST_SECONDS * 1000 });
    return token;
  }
  function guestOf(ctx) {
    const token = accounts.cookieToken(ctx.req.headers.cookie);
    const guest = token ? guests.get(token) : null;
    return guest && guest.until > Date.now() ? { name: guest.name, userId: guest.userId, guest: true } : null;
  }
  // The signed-in account, else this app's guest session, else null.
  const viewerOf = (ctx) => accounts.fromRequest(ctx.req) || guestOf(ctx);

  // --- signing in -------------------------------------------------------------------------
  // "Link" an account: ?username=&password= (the app sends them in the query;
  // server.js keeps password out of the access log). Then xboxlive/connect and
  // xboxlive/get-roblox-userInfo with the cookie this answer sets.
  function linkExistingUser(ctx) {
    if (q(ctx, 'username') === GUEST_LINK_NAME) {
      const token = newGuest();
      return signedIn(ctx, { success: true, userId: guests.get(token).userId }, token);
    }
    const result = accounts.login(q(ctx, 'username').trim(), q(ctx, 'password'), ctx.remote, 'signin');
    if (result.status === 429) return word(ctx, 429, 'Flooded');
    if (result.error) return word(ctx, 403, result.status === 404 || result.status === 400 ? 'InvalidRobloxUser' : 'InvalidPassword');
    signedIn(ctx, { success: true, userId: result.account.userId }, result.token);
  }

  // A new account from the app's "set a username and password" screen.
  function setUsernamePassword(ctx) {
    const name = q(ctx, 'username').trim();
    const password = q(ctx, 'password');
    if (!accounts.NAME_RE.test(name)) return word(ctx, 400, 'InvalidRobloxUser');
    if (password.length < accounts.MIN_PASSWORD) return word(ctx, 400, 'InvalidPassword');
    const result = accounts.login(name, password, ctx.remote, 'signup');
    if (result.status === 429) return word(ctx, 429, 'Flooded');
    if (result.status === 409) return word(ctx, 409, 'Already Taken');
    if (result.error) return word(ctx, 400, 'InvalidCredentials');
    signedIn(ctx, { success: true, userId: result.account.userId }, result.token);
  }

  function connect(ctx) {
    const who = viewerOf(ctx);
    if (!who) return word(ctx, 403, 'UsernamePasswordNotSet');
    sendJson(ctx, 200, { success: true, userId: who.userId });
  }

  function userInfo(ctx) {
    const who = viewerOf(ctx);
    if (!who) return sendJson(ctx, 401, { errors: [{ code: 0, message: 'Not signed in.' }] });
    sendJson(ctx, 200, { userId: who.userId, username: who.name, robuxBalance: who.guest ? 0 : robux.balance(who.userId), isGuest: Boolean(who.guest) });
  }

  function disconnect(ctx) {
    const token = accounts.cookieToken(ctx.req.headers.cookie);
    guests.delete(token);
    accounts.logout(token);
    sendUtf8(ctx, 200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(ctx, '', 0),
    }, JSON.stringify({ success: true }));
  }

  // --- games ------------------------------------------------------------------------------
  const creatorId = (name) => {
    const account = name ? accounts.byName(name) : null;
    return account ? account.userId : 0;
  };
  const imageId = (placeId) => IMAGE_BASE + Number(placeId);
  const placeImage = (ctx, placeId) => {
    const version = gamethumbs.version(placeId);
    return `${baseOf(ctx)}api/thumbnails/${encodeURIComponent(placeId)}${version !== null && version !== undefined ? `?v=${encodeURIComponent(version)}` : ''}`;
  };
  const findGame = (placeId) => launcher.gameList().find((game) => game.placeId === String(placeId)) || null;

  function tile(game, viewer) {
    const tally = votes.of(game.placeId, viewer && viewer.userId);
    return {
      CreatorID: creatorId(game.creator), CreatorName: game.creator || '', CreatorUrl: '',
      Plays: 0, Price: 0, ProductID: 0, IsOwned: false, IsVotingEnabled: true,
      TotalUpVotes: tally.up, TotalDownVotes: tally.down, TotalBought: 0,
      UniverseID: Number(game.placeId), HasErrorOcurred: false, Name: game.name,
      PlaceID: Number(game.placeId), PlayerCount: game.playing, ImageId: imageId(game.placeId),
    };
  }

  function sorted(sortId, viewer) {
    const list = launcher.gameList();
    if (sortId === 2) {
      const score = (game) => { const t = votes.of(game.placeId); return t.up - t.down; };
      list.sort((a, b) => score(b) - score(a) || b.playing - a.playing || a.name.localeCompare(b.name));
    } else if (sortId === 3) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list.map((game) => tile(game, viewer));
  }

  function page(ctx, items) {
    const start = Math.max(0, int(ctx, 'startRows', int(ctx, 'startIndex')));
    const count = Math.min(100, Math.max(1, int(ctx, 'maxRows', int(ctx, 'pageSize', 40))));
    return items.slice(start, start + count);
  }

  function listJson(ctx) {
    const viewer = accounts.fromRequest(ctx.req);
    const keyword = q(ctx, 'keyword').trim().toLowerCase();
    let items = sorted(int(ctx, 'sortFilter', 1), viewer);
    if (keyword) items = items.filter((game) => game.Name.toLowerCase().includes(keyword));
    sendJson(ctx, 200, page(ctx, items));
  }

  function usersGames(ctx) {
    const owner = accounts.byUserId(q(ctx, 'userid'));
    const viewer = accounts.fromRequest(ctx.req);
    const items = owner ? launcher.gameList().filter((game) => game.creator === owner.name).map((game) => tile(game, viewer)) : [];
    sendJson(ctx, 200, page(ctx, items));
  }

  function details(ctx) {
    const placeId = q(ctx, 'assetId') || q(ctx, 'placeId');
    const game = findGame(placeId);
    if (!game) return sendJson(ctx, 404, { message: 'No such game.' });
    const viewer = accounts.fromRequest(ctx.req);
    const tally = votes.of(game.placeId, viewer && viewer.userId);
    const builderId = creatorId(game.creator);
    sendJson(ctx, 200, {
      AssetId: Number(game.placeId), Name: game.name, Description: game.description || '',
      Created: '1/1/2017', Updated: '1/1/2017', FavoritedCount: 0,
      Url: `/games/${game.placeId}/`, ReportAbuseUrl: '', IsFavoritedByUser: false,
      IsCreatedByUser: Boolean(viewer && builderId && viewer.userId === builderId), VisitedCount: 0,
      MaxPlayers: game.maxPlayers || 0, Builder: game.creator || '', BuilderId: builderId, BuilderUrl: '',
      IsPlayable: Boolean(game.canStart || game.servers.length), ReasonProhibited: 'None', ReasonProhibitedMessage: '',
      IsBuildersClubOnly: false, IsCopyLocked: true, IsPersonalServer: false, IsPersonalServerOverlay: false,
      BuildersClubOverlay: null, PlayButtonType: 'Play', AssetGenre: 'All', AssetGenreViewModel: { DisplayName: 'All', Id: 0 },
      OnlineCount: game.playing, UniverseId: Number(game.placeId), UniverseRootPlaceId: Number(game.placeId),
      TotalUpVotes: tally.up, TotalDownVotes: tally.down, UserVote: tally.mine === 0 ? null : tally.mine === 1,
      OverridesDefaultAvatar: false,
    });
  }

  function icon(ctx) {
    const placeId = q(ctx, 'placeId');
    sendJson(ctx, 200, {
      Id: Number(placeId) || 0, PlaceId: Number(placeId) || 0, ImageId: imageId(placeId),
      IconUrl: placeImage(ctx, placeId), IconFinal: true, WikiUrl: '', ReleaseDate: '', IconUpdateSuccess: true, IconUpdateMessage: '',
    });
  }

  function placeThumbnails(ctx) {
    const placeId = q(ctx, 'placeId');
    sendJson(ctx, 200, {
      IsMobile: false, IsVideoAutoplayedOnReady: false, thumbnailCount: 1,
      thumbnails: [{ AssetId: imageId(placeId), AssetTypeId: 1, Url: placeImage(ctx, placeId), IsFinal: true, AssetHash: null }],
    });
  }

  function votingModel(placeId, viewer) {
    const tally = votes.of(placeId, viewer && viewer.userId);
    return {
      ShowVotes: true, UpVotes: tally.up, DownVotes: tally.down, CanVote: Boolean(viewer && viewer.userId > 0),
      UserVote: tally.mine === 0 ? null : tally.mine === 1, ReasonForNotVoteable: viewer ? '' : 'InvalidAssetOrUser',
    };
  }

  function votingPanel(ctx) {
    sendJson(ctx, 200, { ShowVotes: true, VotingModel: votingModel(q(ctx, 'placeId'), accounts.fromRequest(ctx.req)) });
  }

  function vote(ctx) {
    const viewer = accounts.fromRequest(ctx.req);
    const placeId = q(ctx, 'assetId');
    if (!viewer || !findGame(placeId)) return sendJson(ctx, 200, { Success: false, ModalType: 'InvalidAssetOrUser', Model: votingModel(placeId, viewer) });
    const value = q(ctx, 'vote').toLowerCase();
    try {
      votes.cast(placeId, viewer.userId, value === 'true' ? 1 : value === 'false' ? -1 : 0);
    } catch (error) {
      return sendJson(ctx, 200, { Success: false, Model: votingModel(placeId, viewer) });
    }
    sendJson(ctx, 200, { Success: true, Model: votingModel(placeId, viewer) });
  }

  function recommended(ctx) {
    const current = q(ctx, 'currentPlaceId');
    const list = launcher.gameList().filter((game) => game.placeId !== current).slice(0, 6);
    sendJson(ctx, 200, list.map((game) => ({
      PlaceId: Number(game.placeId), GameName: game.name, GameSeoUrl: `/games/${game.placeId}/`,
      Creator: { CreatorName: game.creator || '', CreatorTargetId: creatorId(game.creator), CreatorType: 1 },
      GameThumbnail: { Url: placeImage(ctx, game.placeId), IsFinal: true, AssetId: imageId(game.placeId), AssetType: 1, AssetHash: null },
      ImageId: imageId(game.placeId),
    })));
  }

  function instances(ctx) {
    const game = findGame(q(ctx, 'placeId'));
    const servers = game ? game.servers : [];
    const start = Math.max(0, int(ctx, 'startIndex'));
    sendJson(ctx, 200, {
      PlaceId: Number(q(ctx, 'placeId')) || 0, TotalCollectionSize: servers.length, ShowShutdownAllButton: false,
      Collection: servers.slice(start, start + 10).map((server) => ({
        PlaceId: Number(game.placeId), Capacity: server.maxPlayers || game.maxPlayers || 0, UserCanJoin: true,
        ServerIpAddress: '', Fps: 60, Guid: server.id, JoinScript: '', ShowSlowGameMessage: false, Ping: 0,
        CurrentPlayers: server.players.map((name) => {
          const account = accounts.byName(name);
          const userId = account ? account.userId : 0;
          return { Id: userId, Username: name, Thumbnail: { AssetId: 0, AssetTypeId: 0, Url: `${baseOf(ctx)}Thumbs/Avatar.ashx?userId=${userId}&width=48&height=48`, IsFinal: true, AssetHash: null } };
        }),
      })),
    });
  }

  // --- pictures ---------------------------------------------------------------------------
  function assetThumbnail(ctx) {
    const assetId = Number(q(ctx, 'assetId'));
    const width = int(ctx, 'width', 420);
    const height = int(ctx, 'height', width);
    const url = assetId >= IMAGE_BASE
      ? placeImage(ctx, String(assetId - IMAGE_BASE))
      : `${baseOf(ctx)}Thumbs/Asset.ashx?assetId=${encodeURIComponent(q(ctx, 'assetId'))}&width=${width}&height=${height}`;
    sendJson(ctx, 200, { Url: url, Final: true });
  }

  function avatarThumbnail(ctx) {
    const width = int(ctx, 'width', 420);
    const height = int(ctx, 'height', width);
    sendJson(ctx, 200, { Url: `${baseOf(ctx)}Thumbs/Avatar.ashx?userId=${encodeURIComponent(q(ctx, 'userId'))}&width=${width}&height=${height}`, Final: true });
  }

  // --- people -----------------------------------------------------------------------------
  function onlineStatus(userId) {
    const seen = presence.of(userId);
    return {
      GameId: null, IsOnline: Boolean(seen), LastOnline: '', LastLocation: seen ? (seen.placeId ? 'Playing' : 'Online') : 'Offline',
      LocationType: seen ? (seen.placeId ? 4 : 0) : 2, PlaceId: seen && seen.placeId ? Number(seen.placeId) : null,
    };
  }

  function friendsJson(ctx) {
    const userId = q(ctx, 'userId');
    const type = int(ctx, 'friendsType', 1);
    const ids = type === 3 ? friends.incoming(userId).map((request) => request.from) : friends.friendIds(userId);
    const size = Math.min(100, Math.max(1, int(ctx, 'pageSize', 20)));
    const current = Math.max(1, int(ctx, 'currentPage', 1));
    const people = ids.map((id) => accounts.byUserId(id)).filter(Boolean);
    sendJson(ctx, 200, {
      UserId: Number(userId) || 0, TotalFriends: people.length, CurrentPage: current, PageSize: size,
      TotalPages: Math.max(1, Math.ceil(people.length / size)),
      Friends: people.slice((current - 1) * size, current * size).map((person) => {
        const status = onlineStatus(person.userId);
        return {
          UserId: person.userId, Username: person.name, AvatarUri: `${baseOf(ctx)}Thumbs/Avatar.ashx?userId=${person.userId}&width=110&height=110`,
          AvatarFinal: true, InvitationId: 0, FriendshipStatus: type === 3 ? 2 : 1,
          OnlineStatus: { LocationOrLastSeen: status.LastLocation, ImageUrl: '', AlternateText: status.LastLocation },
        };
      }),
    });
  }

  function friendsOnline(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) return sendJson(ctx, 200, []);
    sendJson(ctx, 200, friends.friendIds(who.userId)
      .map((id) => Object.assign({ VisitorId: Number(id) }, onlineStatus(id)))
      .filter((entry) => entry.IsOnline));
  }

  async function onlineStatuses(ctx) {
    let ids = [];
    try { ids = JSON.parse((await ctx.body(64 * 1024)).toString('utf8') || '[]'); } catch (error) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    sendJson(ctx, 200, { UserPresences: ids.slice(0, 200).map((id) => Object.assign({ VisitorId: Number(id) || 0 }, onlineStatus(id))) });
  }

  function balance(ctx) {
    const who = accounts.fromRequest(ctx.req);
    sendJson(ctx, 200, { robux: who ? robux.balance(who.userId) : 0, tickets: 0 });
  }

  return {
    IMAGE_BASE,
    routes: [
      // sign-in (api.)
      [/^xboxlive\/link-existing-user\/?$/i, linkExistingUser],
      [/^xboxlive\/set-roblox-username-password\/?$/i, setUsernamePassword],
      [/^xboxlive\/connect\/?$/i, connect],
      [/^xboxlive\/get-roblox-userinfo\/?$/i, userInfo],
      [/^xboxlive\/has-linked-account\/?$/i, (ctx) => sendJson(ctx, 200, { hasLinkedAccount: Boolean(viewerOf(ctx)) })],
      [/^xboxlive\/has-set-username-password\/?$/i, (ctx) => sendJson(ctx, 200, { hasSetUsernameAndPassword: Boolean(viewerOf(ctx)) })],
      [/^xboxlive\/disconnect\/?$/i, disconnect],
      [/^xboxlive\/get-inventory\/?$/i, json({ data: [] })],
      [/^xboxlive\/consume-all\/?$/i, json({ success: true })],
      [/^xbox\/translate\/?$/i, json([])],
      [/^xbox\/get-login-consecutive-days\/?$/i, json({ count: 1 })],
      [/^xbox\/catalog\/contents\/?$/i, json({ data: [], total: 0 })],
      [/^xbox\/currently-wearing\/?$/i, json({ assetIds: [] })],
      [/^appearance\/get-my-user-outfits\/?$/i, json({ data: [], total: 0 })],
      [/^appearance\/wear-user-outfit\/?$/i, json({ success: false })],
      [/^user\/get-vote-count\/?$/i, json({ VoteCount: 0 })],
      [/^users\/(\d{1,15})\/onlinestatus\/?$/i, (ctx, match) => sendJson(ctx, 200, onlineStatus(match[1]))],
      [/^users\/online-status\/?$/i, onlineStatuses],
      [/^my\/friendsonline\/?$/i, friendsOnline],
      [/^(?:my\/platform-currency-budget|currency\/balance)\/?$/i, balance],
      // the Lua screens (assetgame.)
      [/^games\/default-sorts\/?$/i, json(SORTS.map((sort) => Object.assign({ TimeOptionsAvailable: false, DefaultTimeOption: 0, GenresOptionsAvailable: false }, sort)))],
      [/^games\/list-json\/?$/i, listJson],
      [/^games\/moreresultsuncached-json\/?$/i, json([])],
      [/^games\/list-users-games-json\/?$/i, usersGames],
      [/^places\/api-get-details\/?$/i, details],
      [/^places\/icons\/json\/?$/i, icon],
      [/^placeitem\/gamedetailsvotingpaneljson\/?$/i, votingPanel],
      [/^voting\/vote\/?$/i, vote],
      [/^favorite\/toggle\/?$/i, json({ success: false, message: 'Favorites are not on this server yet.' })],
      [/^games\/getrecommendedgamesjson\/?$/i, recommended],
      [/^thumbnail\/place-thumbnails\/?$/i, placeThumbnails],
      [/^badges\/list-badges-for-place\/json\/?$/i, (ctx) => sendJson(ctx, 200, { PlaceId: Number(q(ctx, 'placeId')) || 0, GameBadges: [] })],
      [/^games\/getgamepassespaged\/?$/i, (ctx) => sendJson(ctx, 200, { PlaceId: Number(q(ctx, 'placeId')) || 0, totalItems: 0, IsViewerPlaceOwner: false, data: [] })],
      [/^games\/getplaceproductpromotions\/?$/i, (ctx) => sendJson(ctx, 200, { PlaceId: Number(q(ctx, 'placeId')) || 0, totalItems: 0, IsViewerPlaceOwner: false, data: [] })],
      [/^games\/getgameinstancesjson\/?$/i, instances],
      [/^asset-thumbnail\/json\/?$/i, assetThumbnail],
      [/^avatar-thumbnail\/json\/?$/i, avatarThumbnail],
      [/^avatar-thumbnails\/?$/i, json({ Url: '', Final: true })],
      [/^friends\/json\/?$/i, friendsJson],
      [/^users\/inventory\/list-json\/?$/i, json({ IsValid: true, Data: { TotalItems: 0, Start: 0, End: 0, Page: 1, Items: [] } })],
      [/^api\/item\.ashx$/i, json({ success: false, status: 'Purchases from the Xbox app are not on this server yet.' })],
    ],
  };
};
