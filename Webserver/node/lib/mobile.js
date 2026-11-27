'use strict';

// The rbx2017 Android app: the 2017 Roblox app (2.299), rebuilt by
// tools/build-android-apk.py to use this server. Its names, all this server
// through the VPS (tools/vps/setup-vps.sh --android):
//   m.<domain>    its pages (the Home and Games tabs are web pages) and the
//                 game engine's base address (join.php, assets)
//   api.<domain>  its API calls
//   assetgame.<domain>, clientsettings.api.<domain>, ephemeralcounters.api.<domain>
//                 the game engine's own: PlaceLauncher, its settings, counters
// This answers what only the app asks, its pages, and its game joins.
//
//   const mobile = require('./mobile')({ send, sendUtf8, sendJson, launcher });
//   mobile.routes             the app's API calls (any host)
//   mobile.pageRoutes         its pages, tried first for the m. host
//   mobile.isMobile(ctx)      the request came to m.<domain>
//   mobile.baseUrl(ctx)       "https://m.<domain>/" (join scripts)
//   mobile.directBase(ctx)    "<scheme>://m.<domain>/" on the request's own scheme
//                             (the PC client set up for these names)
//   await mobile.placeLauncher(ctx)
//   mobile.notHerePage(ctx)   any other page the app opens

const net = require('net');
const core = require('./core');
const accounts = require('./accounts');
const publicnet = require('./publicnet');
const robux = require('./robux');

// The app's settings (com.roblox.client.b): Roblox's analytics, reporting
// and ads off. Realtime (SignalR) is on: the Chat tab loads nothing until it
// is connected (lib/mobilechat.js; SignalRUrl is added per host below).
const APP_SETTINGS = {
  EnableRbxAnalytics: false,
  EnableRbxReportingManager: false,
  InfluxThrottleRate: 0,
  EnablePrerollAds: false,
  EnableVideoAdPreCache: false,
  EnableSignalR: true,
  EnableNativeSignalRv3: false,
  // lib/chat.js MAX_MEMBERS, less yourself.
  NumParticipantsInGroupChat: 9,
  NativeSignalRPercentageRollout: 0,
  EnableNotificationStream: false,
  // Its game engine's crash dumps come here (Error/Dmp.ashx, kept in logs/captures).
  EnableBreakpadUploadCrashDump: true,
  AppRatingsEnabled: false,
};

// A route handler's answer meaning "not mine, try the next route" (server.js).
const NEXT = Symbol('next route');

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

module.exports = function mobileApi({ send, sendUtf8, sendJson, launcher, sessionCookie }) {
  function hostOf(ctx) {
    return String(ctx.req.headers['x-forwarded-host'] || ctx.publicHost || ctx.req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  }

  // m.<domain>, and assetgame.<domain>, where the game engine asks for a
  // server (Game/PlaceLauncher.ashx), and www.m.<domain>, where the avatar
  // editor opens item pages. Never the PC client's localhost. names.
  const MOBILE_HOST = /^(?:(?:www\.)?m|assetgame)\.((?!localhost$)[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;
  const isMobile = (ctx) => MOBILE_HOST.test(hostOf(ctx));
  const baseUrl = (ctx) => {
    const match = MOBILE_HOST.exec(hostOf(ctx));
    return `https://m.${match ? match[1] : hostOf(ctx)}/`;
  };
  // The same base on the scheme the request came in on: the PC game client
  // set up for these names (tools/patch-0300-client.py --domain) may use
  // plain HTTP (the VPS serves both; its Caddy says which in
  // X-Forwarded-Proto), and its join script must keep that scheme.
  const directBase = (ctx) => {
    const match = MOBILE_HOST.exec(hostOf(ctx));
    const forwarded = ctx.publicHost ? String(ctx.req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
    const scheme = forwarded === 'http' || forwarded === 'https' ? forwarded : (ctx.req.socket.encrypted ? 'https' : 'http');
    return `${scheme}://m.${match ? match[1] : hostOf(ctx)}/`;
  };
  const json = (value) => (ctx) => sendJson(ctx, 200, value);
  // https://m.<domain>/ from any of the app's names (api., chat., m. ...): the
  // app reads its settings from api.<domain>.
  const APP_PREFIX = /^(?:clientsettings\.api|ephemeralcounters\.api|api|chat|www\.m|avatar\.m|inventory\.m|m|assetgame)\.(?=[a-z0-9-]+\.)/;
  const appBase = (ctx) => `https://m.${hostOf(ctx).replace(APP_PREFIX, '')}/`;

  // --- the app's API calls --------------------------------------------------------------

  function accountInfo(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) return sendJson(ctx, 401, { errors: [{ code: 0, message: 'Authorization has been denied for this request.' }] });
    // AgeBracket 0: 13 or over (1 shows "<13" and locks chat).
    sendJson(ctx, 200, { UserId: who.userId, Username: who.name, AgeBracket: 0, Email: { Value: '', IsVerified: true }, RobuxBalance: robux.balance(who.userId) });
  }

  function balance(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) return sendJson(ctx, 401, { errors: [{ code: 0, message: 'Authorization has been denied for this request.' }] });
    sendJson(ctx, 200, { robux: robux.balance(who.userId), tickets: 0 });
  }

  // Its analytics beacon (ecsv2 pe.png, sent to m. by the APK): nothing kept.
  function beacon(ctx) {
    send(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }, Buffer.alloc(0));
  }

  // --- signing up -------------------------------------------------------------------------
  // The app's Sign Up screen checks the name and password while they are typed
  // (signup/is-*-valid: IsValid, and an ErrorMessage the app shows; "already in
  // use" in it means taken), then posts the account to signup/v1 and carries on
  // signed in with the session cookie from that answer. Same rules as the
  // launcher's sign-up (lib/accounts.js).
  const queryText = (ctx, name) => String(ctx.query[name] || '');

  function nameProblem(name) {
    if (!accounts.NAME_RE.test(name)) return 'Usernames are 3 to 20 letters, numbers or underscores.';
    if (accounts.byName(name)) return 'This username is already in use.';
    return '';
  }

  function passwordProblem(name, password) {
    if (password.length < accounts.MIN_PASSWORD) return `Passwords are at least ${accounts.MIN_PASSWORD} characters.`;
    if (name && password.toLowerCase() === name.toLowerCase()) return "Your password can't be your username.";
    return '';
  }

  function usernameValid(ctx) {
    const problem = nameProblem(queryText(ctx, 'username').trim());
    sendJson(ctx, 200, { IsValid: !problem, ErrorMessage: problem });
  }

  function passwordValid(ctx) {
    const problem = passwordProblem(queryText(ctx, 'username').trim(), queryText(ctx, 'password'));
    sendJson(ctx, 200, { IsValid: !problem, ErrorMessage: problem });
  }

  // Sent as JSON or as a form: username, password, gender, birthday (and
  // perhaps email and deviceHandle, not kept). 200 { userId }, or 403 with the
  // app's reasons (UsernameTaken, UsernameInvalid, PasswordInvalid), or 429.
  async function signUp(ctx) {
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { reasons: [] });
    const text = (await ctx.body(16 * 1024)).toString('utf8');
    let fields = {};
    if (/json/i.test(String(ctx.req.headers['content-type'] || ''))) {
      try { fields = JSON.parse(text || '{}') || {}; } catch (error) { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(text));
    }
    const name = String(fields.username || '').trim();
    const password = String(fields.password || '');
    const reasons = [];
    const badName = nameProblem(name);
    if (badName) reasons.push(/in use/.test(badName) ? 'UsernameTaken' : 'UsernameInvalid');
    if (passwordProblem(name, password)) reasons.push('PasswordInvalid');
    if (reasons.length) return sendJson(ctx, 403, { reasons });
    const result = accounts.login(name, password, ctx.remote, 'signup');
    if (result.status === 429) return sendJson(ctx, 429, { reasons: [] });
    if (result.error) return sendJson(ctx, 403, { reasons: [result.status === 409 ? 'UsernameTaken' : 'UsernameInvalid'] });
    sendUtf8(ctx, 200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(ctx, result.token, 30 * 24 * 3600),
    }, JSON.stringify({ userId: result.account.userId }));
  }

  // --- joining a game -----------------------------------------------------------------------

  // Game/PlaceLauncher.ashx from the app's game engine. The player is the
  // signed-in account (its cookie), else a guest. There is no local relay
  // (as for the PC launcher's 2017 games): the engine connects straight to the game
  // server's public address (the VPS forwards the game ports).
  async function placeLauncher(ctx) {
    const q = ctx.queryLower;
    const reply = (fields) => send(ctx, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, core.phpJson(Object.assign({
      jobId: '', status: 4, joinScriptUrl: null, authenticationUrl: null, authenticationTicket: null, message: null,
    }, fields)));
    const body = String(q.request || '') === 'RequestGameJob' && q.gameid ? { gameId: String(q.gameid) } : { placeId: q.placeid };
    const result = launcher.mobileJoin(ctx, body);
    // Status 0: waiting for a server (the engine asks again); 6: full; 4: an error.
    if (result.starting) return reply({ status: 0, message: 'Starting a server…' });
    if (result.error) return reply({ status: result.status === 409 ? 6 : 4, message: result.error });
    const { game, identity } = result;
    const match = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(publicnet.publicAddress(ctx, String(game.address || '')));
    if (!match) return reply({ jobId: game.id, status: 4, message: 'The game server has no address.' });
    let ip = match[1];
    if (net.isIP(ip) === 0) {
      ip = await publicnet.ipv4Of(match[1]);
      if (!ip) return reply({ jobId: game.id, status: 4, message: `Could not look up ${match[1]}.` });
    }
    const base = baseUrl(ctx);
    const placeId = String(game.placeId);
    const userId = String(identity.userId);
    const app = `${base}v1.1/avatar-fetch/?placeId=${encodeURIComponent(placeId)}&userId=${encodeURIComponent(userId)}`;
    const joinUrl = `${base}game/join.php`
      + `?placeid=${encodeURIComponent(placeId)}`
      + `&ip=${encodeURIComponent(ip)}`
      + `&port=${encodeURIComponent(match[2])}`
      + `&id=${encodeURIComponent(userId)}`
      + `&user=${encodeURIComponent(identity.name)}`
      + `&app=${encodeURIComponent(app)}`
      + `&sig=${launcher.joinSignature(userId, identity.name, placeId)}`;
    reply({ jobId: game.id, status: 2, joinScriptUrl: joinUrl, authenticationUrl: `${base}Login/Negotiate.ashx`, authenticationTicket: 'Test' });
  }

  // --- pages ------------------------------------------------------------------------------------

  const STYLE = `
*{box-sizing:border-box}body{margin:0;font-family:"Source Sans Pro",Roboto,Arial,sans-serif;background:#e3e3e3;color:#191919}
main{padding:12px;max-width:720px;margin:0 auto}h1{font-size:20px;font-weight:600;margin:4px 2px 12px}
.game{display:flex;align-items:center;background:#fff;border-radius:4px;padding:8px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.game img{width:96px;height:54px;object-fit:cover;border-radius:3px;background:#ccc;flex:none;margin-right:12px}
.info{flex:1;min-width:0}.name{font-weight:600;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{color:#757575;font-size:13px}.play{flex:none;margin-left:12px;background:#02b757;color:#fff;text-decoration:none;font-weight:600;padding:9px 16px;border-radius:4px}
.empty,.note{background:#fff;border-radius:4px;padding:16px;text-align:center;color:#555}.note a{color:#00a2ff}`;

  function page(ctx, title, body) {
    sendUtf8(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`);
  }

  // The More tab's catalog, inventory and settings pages (lib/mobileshop.js),
  // and the avatar editor's API (lib/mobileavatar.js).
  const shop = require('./mobileshop')({ page, escapeHtml, send, launcher, hostOf });
  const avatarEditor = require('./mobileavatar')({ send, sendJson, launcher });
  // A JSON body (the chat API's), or {} when it isn't one.
  async function mobileJson(ctx) {
    try {
      const data = JSON.parse((await ctx.body(16 * 1024)).toString('utf8') || '{}');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
      return {};
    }
  }

  // Friends, profiles, search and Messages pages (lib/mobilesocial.js), and the
  // native Chat tab's API and realtime connection (lib/mobilechat.js).
  const social = require('./mobilesocial')({ page, escapeHtml, send, launcher, hostOf, NEXT });
  const groupPages = require('./mobilegroups')({ page, escapeHtml, send, hostOf, NEXT });
  const economyPages = require('./mobileeconomy')({ page, escapeHtml, send, hostOf, NEXT });
  const forumPages = require('./mobileforum')({ page, escapeHtml, send, hostOf, NEXT });
  const chatApi = require('./mobilechat')({ sendJson, jsonBody: mobileJson, launcher, baseUrl: appBase });

  function gameRows() {
    const list = launcher.gameList();
    list.sort((a, b) => b.playing - a.playing || a.name.localeCompare(b.name));
    if (!list.length) return '<p class="empty">No games are online right now.</p>';
    return list.map((game) => {
      const image = `/api/thumbnails/${encodeURIComponent(game.placeId)}${game.thumbnail !== null && game.thumbnail !== undefined ? `?v=${encodeURIComponent(game.thumbnail)}` : ''}`;
      const meta = game.playing > 0 ? `${game.playing} playing` : (game.creator ? `By ${escapeHtml(game.creator)}` : '&nbsp;');
      return `<div class="game"><img src="${image}" alt="" loading="lazy"><div class="info"><div class="name">${escapeHtml(game.name)}</div>`
        + `<div class="meta">${meta}</div></div><a class="play" href="/games/start?placeid=${encodeURIComponent(game.placeId)}">Play</a></div>`;
    }).join('');
  }

  function homePage(ctx) {
    const who = accounts.fromRequest(ctx.req);
    page(ctx, 'Home', `<h1>${who ? `Hi, ${escapeHtml(who.name)}` : 'Games'}</h1>${gameRows()}`);
  }

  function gamesPage(ctx) {
    page(ctx, 'Games', `<h1>Games</h1>${gameRows()}`);
  }

  // The app starts the game itself when its web view opens this; a browser
  // gets a link that opens the app.
  function startPage(ctx) {
    const placeId = /^\d{1,15}$/.test(String(ctx.queryLower.placeid || '')) ? ctx.queryLower.placeid : '';
    page(ctx, 'Play', `<p class="note">${placeId ? `<a href="rbx2017://placeID=${placeId}">Open in the rbx2017 app</a>` : 'Which game?'}</p>`);
  }

  // Tabs and links this server has no phone page for (groups, messages,
  // profile...).
  function notHerePage(ctx) {
    page(ctx, 'rbx2017', '<p class="note">This part isn\'t on the phone yet. Use the launcher on a PC for it.<br><br><a href="/games">Games</a></p>');
  }

  return {
    NEXT,
    upgrade: chatApi.upgrade,
    isMobile,
    baseUrl,
    directBase,
    placeLauncher,
    notHerePage,
    routes: [
      [/^setting\/get\/androidappsettings\/?$/i, (ctx) => sendJson(ctx, 200, Object.assign({}, APP_SETTINGS, { SignalRUrl: `${appBase(ctx)}notifications` }))],
      [/^mobileapi\/check-app-version\/?$/i, json({ data: { UpgradeAction: 'None' } })],
      [/^ab\/v1\/(?:get-enrollments|enroll)\/?$/i, json({ data: [] })],
      [/^sponsoredpage\/list-json\/?$/i, json([])],
      [/^users\/account-info\/?$/i, accountInfo],
      [/^my\/balance\/?$/i, balance],
      [/^notifications\/account\/?$/i, json({})],
      [/^v2\/push-notifications\/[a-z-]+\/?$/i, json({ statusMessage: 'Success' })],
      [/^v2\/stream-notifications\/[a-z-]+\/?$/i, json({ unreadNotifications: 0 })],
      [/^v1\.1\/counters\/increment\/?$/i, json({})],
      [/^pe\.png$/i, beacon],
      [/^signup\/is-username-valid\/?$/i, usernameValid],
      [/^signup\/is-password-valid\/?$/i, passwordValid],
      [/^signup\/v1\/?$/i, signUp],
      [/^v1\/validators\/username\/?$/i, (ctx) => sendJson(ctx, 200, { didGenerateNewUsername: false, suggestedUsername: queryText(ctx, 'username') })],
      [/^v1\/validators\/email\/?$/i, json({ isEmailValid: true })],
      // The game engine's report after a crash (the dump itself goes to
      // Error/Dmp.ashx), and its join statistics: nothing kept.
      [/^game\/(?:sessions\/report|joinrate\.ashx)\/?$/i, (ctx) => send(ctx, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'OK')],
      ...avatarEditor.routes,
      ...chatApi.routes,
    ],
    pageRoutes: [
      [/^(?:home)?\/?$/i, homePage],
      [/^games\/?$/i, gamesPage],
      [/^games\/start\/?$/i, startPage],
      ...shop.pageRoutes,
      ...social.pageRoutes,
      ...groupPages.pageRoutes,
      ...economyPages.pageRoutes,
      ...forumPages.pageRoutes,
    ],
  };
};
