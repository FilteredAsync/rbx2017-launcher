'use strict';

// Roblox Studio 2017 (Studio/RobloxStudioBeta.exe) against this server:
// logging in, its start page, opening library places, and publishing.
//
// What 2017 Studio asks for, and what answers it here:
//   /My/Places.aspx...            start page in Studio's web view  -> studio/start.html
//   /IDE/publishas, publishgameas "Publish to Roblox As..." dialog -> studio/publish.html
//   /game/GetCurrentUser.ashx     who is logged in (a user ID)
//   /login/RequestAuth.ashx       an address that logs Studio's web view in
//   /Login/Negotiate.ashx?suggest= sets the session cookie
//   /Game/edit.ashx?PlaceID=      signed Lua that loads a place for editing
//   /studio/place/<id>?t=         the place file itself
//   /Data/Upload.ashx?assetid=    Studio uploads the place here when publishing
//   /studio/api/...               what the two pages call (login, game list, publish)
//
// The pages talk to Studio through window.external (Studio's RbxWorkspace
// object): StartGame(ticket, url, script) logs Studio's own HTTP side in with
// url?suggest=ticket and runs the script; SaveUrl(url) uploads the open place.
// Studio's web view is 2013 WebKit, so the pages use ES5 and XMLHttpRequest.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const core = require('./core');
const accounts = require('./accounts');
const games = require('./games');
const places = require('./places');

const PAGES = path.join(__dirname, '..', 'studio');
const PAGE_FILES = {
  'start.html': 'text/html; charset=utf-8',
  'publish.html': 'text/html; charset=utf-8',
  'studio.css': 'text/css; charset=utf-8',
  'studio.js': 'application/javascript; charset=utf-8',
};
// An empty place: what a newly published game holds until Studio's upload lands.
const EMPTY_PLACE = Buffer.from('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n</roblox>\n');
const MAX_PLACE_BYTES = 200 * 1024 * 1024;

module.exports = function studioRoutes({ send, sendUtf8, sendFile, sendJson, jsonBody, sign }) {
  // --- helpers ------------------------------------------------------------------------

  // The address Studio used to reach us ("localhost." for local and proxied
  // players), so cookies and links stay on the host Studio already talks to.
  // Always plain http: Studio's web view loads the start page over https and
  // accepts any certificate, but its own downloads and uploads may not.
  // Studio trusts only its own domain, "localhost." with the dot (anything
  // else fails its "trust check"); WinINet drops the dot from Host, so it
  // goes back on here.
  function baseUrl(ctx) {
    let host = String(ctx.req.headers.host || 'localhost.').replace(/[^A-Za-z0-9.:\-\[\]]/g, '') || 'localhost.';
    host = host.replace(/(^|\.)localhost(?=:\d+$|$)/i, '$1localhost.');
    return `http://${host}`;
  }

  // Like Roblox's own: for the whole domain (".localhost." covers the
  // web view's "localhost." and Studio's other hosts) and not HttpOnly, which
  // Studio could not copy into WinINet, where its own requests look for it.
  function sessionCookie(ctx, token, maxAgeSeconds) {
    const host = String(ctx.req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const named = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/.test(host) && !/^[\d.]+$/.test(host);
    const domain = named ? `; Domain=.${host.replace(/^www\./, '')}` : '';
    const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
    return `.ROBLOSECURITY=${token}; Path=/; Max-Age=${maxAgeSeconds}; Expires=${expires}${domain}`;
  }

  function currentAccount(ctx) {
    return accounts.fromRequest(ctx.req);
  }

  // --- handing a web-view login to Studio's own side ------------------------------------
  // Studio's own requests (WinINet) never get the web view's cookie: WinINet
  // will not take a cookie for a one-word domain like "localhost.". Right
  // after a login in the web view, Studio asks "who am I" from its own side
  // (my/settings/json) from the same address; for a few seconds that answer
  // comes from the login just made, and sets WinINet's own session cookie.
  const HANDOFF_MS = 15000;
  const handoffs = new Map();

  function offerHandoff(ctx, token) {
    handoffs.set(ctx.remote, { token, expires: Date.now() + HANDOFF_MS });
  }

  function isWinInet(ctx) {
    return /WinInet/i.test(String(ctx.req.headers['user-agent'] || ''));
  }

  // -> { account, token } for a cookie-less WinINet request, or null.
  function takeHandoff(ctx) {
    if (!isWinInet(ctx)) return null;
    const offer = handoffs.get(ctx.remote);
    if (!offer || offer.expires < Date.now()) return null;
    const account = accounts.fromToken(offer.token);
    return account ? { account, token: offer.token } : null;
  }

  // The account of a request, from its cookie or a fresh handoff; sets
  // headers['Set-Cookie'] when it came from a handoff.
  function requestAccount(ctx, headers) {
    const account = currentAccount(ctx);
    if (account) return account;
    const handoff = takeHandoff(ctx);
    if (!handoff) return null;
    // WinINet keeps a cookie past the process (each place opens its own
    // Studio window) only with Expires; it ignores Max-Age.
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toUTCString();
    headers['Set-Cookie'] = `.ROBLOSECURITY=${handoff.token}; Path=/; Expires=${expires}`;
    return handoff.account;
  }

  // Studio's own requests say "Roblox/WinInet", its web view is AppleWebKit.
  function isStudio(ctx) {
    return /RobloxStudio|WinInet|QtWebEngine|Qt\/|QtWebKit|AppleWebKit\/538/i.test(String(ctx.req.headers['user-agent'] || ''));
  }

  function canEdit(account, place) {
    if (!account || !place) return false;
    if (account.admin) return true;
    if (place.owner && place.owner.userId === account.userId) return true;
    return place.editors.some((editor) => editor.userId === account.userId);
  }

  function runningGames() {
    const runner = places.runnerStatus();
    return runner && !runner.stale && runner.games ? runner.games : {};
  }

  function gameEntry(place, account, running) {
    const status = running[place.placeId] || null;
    return {
      placeId: Number(place.placeId),
      name: place.name,
      description: place.description,
      online: place.enabled,
      running: Boolean(status && status.state === 'running'),
      players: status && Array.isArray(status.players) ? status.players.length : 0,
      owner: place.owner ? place.owner.name : null,
      editors: place.editors.map((editor) => editor.name),
      isOwner: Boolean(account && place.owner && place.owner.userId === account.userId),
      canEdit: canEdit(account, place),
      version: place.version,
      updatedAt: place.updatedAt,
    };
  }

  function editUrls(ctx, account, placeId) {
    const base = baseUrl(ctx);
    const token = accounts.editToken(account.userId, placeId);
    return {
      token,
      script: `${base}/Game/edit.ashx?PlaceID=${placeId}&upload=${placeId}&t=${encodeURIComponent(token)}`,
      // Studio's game:Load only takes asset addresses (/asset/?id=).
      placeUrl: `${base}/asset/?id=${placeId}&studioplace=1&t=${encodeURIComponent(token)}`,
      uploadUrl: `${base}/Data/Upload.ashx?assetid=${placeId}&t=${encodeURIComponent(token)}`,
    };
  }

  // The account allowed to work on placeId: from an edit token (t=) or the
  // session cookie. -> { account, place } or { status, error }
  function authorize(ctx, placeId) {
    const place = places.get(placeId);
    if (!place) return { status: 404, error: 'There is no game with that place ID on this server.' };
    let account = null;
    const token = ctx.queryLower.t;
    if (token) {
      const checked = accounts.checkEditToken(token);
      if (!checked || String(checked.placeId) !== String(place.placeId)) return { status: 403, error: 'This edit link is no longer valid. Open the game again from the start page.' };
      account = accounts.byUserId(checked.userId);
    } else {
      account = currentAccount(ctx);
    }
    if (!account) return { status: 403, error: 'Log in to Studio first.' };
    if (!canEdit(account, place)) return { status: 403, error: `${account.name} may not edit ${place.name}.` };
    return { account, place };
  }

  // --- pages -----------------------------------------------------------------------------

  function page(name) {
    return (ctx) => sendFile(ctx, path.join(PAGES, name), { 'Content-Type': PAGE_FILES[name], 'Cache-Control': 'no-cache' });
  }

  function pageAsset(ctx, match) {
    const name = match[1].toLowerCase();
    if (!PAGE_FILES[name]) return send(ctx, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    return sendFile(ctx, path.join(PAGES, name), { 'Content-Type': PAGE_FILES[name], 'Cache-Control': 'no-cache' });
  }

  function toolboxPage(ctx) {
    sendUtf8(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/studio/studio.css"></head>'
      + '<body class="toolbox"><p>The Toolbox isn\'t available on this server.</p>'
      + '<p class="hint">Insert models you saved as .rbxm/.rbxmx with right-click &gt; Insert from File.</p></body></html>');
  }

  // --- login (Studio's own requests) ---------------------------------------------------

  // A user ID when logged in. Studio reads anything else as "not logged in";
  // the game client gets the old fixed answer it always had.
  function getCurrentUser(ctx) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
    const account = requestAccount(ctx, headers);
    const body = account ? String(account.userId) : (isStudio(ctx) ? 'null' : '261');
    send(ctx, 200, headers, body);
  }

  function requestAuth(ctx) {
    const token = accounts.cookieToken(ctx.req.headers.cookie);
    if (!token || !accounts.fromToken(token)) {
      return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'User is not authorized.');
    }
    send(ctx, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, `${baseUrl(ctx)}/Login/Negotiate.ashx?suggest=${token}`);
  }

  // Also what the game client calls with its own ticket: it only needs "true".
  function negotiate(ctx) {
    const suggest = String(ctx.query.suggest || ctx.queryLower.suggest || '');
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
    if (accounts.fromToken(suggest)) {
      headers['Set-Cookie'] = sessionCookie(ctx, suggest, 30 * 24 * 3600);
      offerHandoff(ctx, suggest);
    }
    send(ctx, 200, headers, 'true');
  }

  // auth.roblox.com/v2/login, for Studio's built-in login screen.
  async function v2Login(ctx) {
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { errors: [{ code: 0, message: 'use POST' }] });
    const body = await jsonBody(ctx);
    const result = accounts.login(body.cvalue || body.username, body.password, ctx.remote);
    if (result.error) return sendJson(ctx, result.status === 429 ? 429 : 403, { errors: [{ code: result.status === 429 ? 7 : 1, message: result.error }] });
    sendUtf8(ctx, 200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(ctx, result.token, 30 * 24 * 3600),
    }, JSON.stringify({ user: { id: result.account.userId, name: result.account.name, displayName: result.account.name }, isBanned: false }));
  }

  // Studio clears its own (WinINet) side with this before it copies a login
  // from its web view over. The session itself stays valid: the web view
  // still uses it, and RequestAuth.ashx needs it next.
  function gameLogout(ctx) {
    send(ctx, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'OK');
  }

  // www.roblox.com/my/settings/json, which Studio reads once logged in.
  function mySettings(ctx) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    const account = requestAccount(ctx, headers);
    if (!account) return sendJson(ctx, 401, { error: 'not logged in' });
    sendUtf8(ctx, 200, headers, JSON.stringify({
      UserId: account.userId, Name: account.name, DisplayName: account.name,
      IsAnyBuildersClubMember: false, IsAnyBC: false, IsPremium: false, IsAdmin: false,
      UserAbove13: true, IsEmailOnFile: true, IsEmailVerified: true, ChangeUsernameEnabled: false,
    }));
  }

  function signOut(ctx) {
    accounts.logout(accounts.cookieToken(ctx.req.headers.cookie));
    sendUtf8(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(ctx, '', 0) }, '{}');
  }

  // --- the pages' API -------------------------------------------------------------------

  // Online or not, chosen in the publish dialog; applied when the upload lands.
  const pendingOnline = new Map();

  async function api(ctx, match) {
    const action = match[1].toLowerCase();
    const account = currentAccount(ctx);

    if (action === 'me') {
      // Setting the cookie again makes Studio sync its own side (see handoffs).
      const token = accounts.cookieToken(ctx.req.headers.cookie);
      if (!account || !token) return sendJson(ctx, 200, { account: null });
      offerHandoff(ctx, token);
      return sendUtf8(ctx, 200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(ctx, token, 30 * 24 * 3600),
      }, JSON.stringify({ account }));
    }

    if (action === 'login') {
      if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
      const body = await jsonBody(ctx);
      const result = accounts.login(body.name, body.password, ctx.remote);
      if (result.error) return sendJson(ctx, result.status, { error: result.error });
      offerHandoff(ctx, result.token);
      return sendUtf8(ctx, 200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(ctx, result.token, 30 * 24 * 3600),
      }, JSON.stringify({ account: result.account, created: result.created }));
    }

    if (action === 'logout') {
      accounts.logout(accounts.cookieToken(ctx.req.headers.cookie));
      return sendUtf8(ctx, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(ctx, '', 0) }, '{"ok":true}');
    }

    if (!account) return sendJson(ctx, 401, { error: 'Log in first.' });

    if (action === 'games') {
      const running = runningGames();
      const games = places.list().map((place) => gameEntry(place, account, running));
      return sendJson(ctx, 200, { account, games });
    }

    if (action === 'open') {
      // -> what the page hands to window.external.StartGame(ticket, url, script).
      const body = await jsonBody(ctx);
      const placeId = Number(body.placeId) || 0;
      const base = baseUrl(ctx);
      const ticket = accounts.cookieToken(ctx.req.headers.cookie);
      const auth = { ticket, url: `${base}/Login/Negotiate.ashx` };
      // The place opens in a new Studio window, which asks who it is first.
      offerHandoff(ctx, ticket);
      if (placeId === 0) return sendJson(ctx, 200, Object.assign(auth, { script: `${base}/Game/edit.ashx?PlaceID=0&upload=0` }));
      const place = places.get(placeId);
      if (!place) return sendJson(ctx, 404, { error: 'There is no game with that place ID.' });
      if (!canEdit(account, place)) return sendJson(ctx, 403, { error: `You may not edit ${place.name}. Ask its owner to add you as an editor.` });
      return sendJson(ctx, 200, Object.assign(auth, { script: editUrls(ctx, account, place.placeId).script }));
    }

    if (action === 'publish') {
      // { placeId: 0 for a new game, name, description, online } -> { placeId, uploadUrl }
      if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
      const body = await jsonBody(ctx);
      let place;
      if (!Number(body.placeId)) {
        const name = String(body.name || '').trim();
        if (!name) return sendJson(ctx, 400, { error: 'Give the game a name.' });
        place = places.create({
          name, description: body.description, enabled: false, bytes: EMPTY_PLACE,
          notes: [], from: `Studio (${account.name})`, owner: { userId: account.userId, name: account.name },
        });
      } else {
        place = places.get(body.placeId);
        if (!place) return sendJson(ctx, 404, { error: 'There is no game with that place ID.' });
        if (!canEdit(account, place)) return sendJson(ctx, 403, { error: `You may not publish over ${place.name}.` });
        if (body.name !== undefined || body.description !== undefined) {
          places.update(place.placeId, { name: body.name !== undefined ? body.name : place.name, description: body.description !== undefined ? body.description : place.description });
        }
      }
      // Applied once the upload arrives, so a failed upload changes nothing.
      pendingOnline.set(String(place.placeId), body.online !== false);
      return sendJson(ctx, 200, { placeId: Number(place.placeId), name: places.get(place.placeId).name, uploadUrl: editUrls(ctx, account, place.placeId).uploadUrl });
    }

    if (action === 'editors') {
      // { placeId, editors: ["name", ...] } -> the owner (or an admin) picks who else may edit.
      if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
      const body = await jsonBody(ctx);
      const place = places.get(body.placeId);
      if (!place) return sendJson(ctx, 404, { error: 'There is no game with that place ID.' });
      const isOwner = place.owner && place.owner.userId === account.userId;
      if (!isOwner && !account.admin) return sendJson(ctx, 403, { error: 'Only the game\'s owner can choose its editors.' });
      const names = (Array.isArray(body.editors) ? body.editors : []).map((name) => String(name).trim()).filter(Boolean);
      const editors = [];
      for (const name of names) {
        const editor = accounts.byName(name);
        if (!editor) return sendJson(ctx, 400, { error: `There is no account called ${name}. They need to log in to Studio once first.` });
        editors.push({ userId: editor.userId, name: editor.name });
      }
      const updated = places.setAccess(place.placeId, { editors });
      return sendJson(ctx, 200, { editors: updated.editors.map((editor) => editor.name) });
    }

    return sendJson(ctx, 404, { error: 'unknown Studio API call' });
  }

  // --- editing ---------------------------------------------------------------------------

  function lua(value) {
    return JSON.stringify(String(value)).replace(/[\u2028\u2029]/g, '');
  }

  function editScriptFor(ctx, { placeId, universeId, userId, placeUrl, uploadUrl }) {
    const base = baseUrl(ctx);
    return `\r\n-- Opens a place from this server in Studio (Webserver/node/lib/studio.js).
local baseUrl = ${lua(base)}
local placeId = ${Number(placeId) || 0}
local universeId = ${Number(universeId) || 0}
local userId = ${Number(userId) || 0}
local placeUrl = ${lua(placeUrl || '')}
local uploadUrl = ${lua(uploadUrl || '')}

pcall(function() game:GetService("ContentProvider"):SetBaseUrl(baseUrl .. "/") end)
pcall(function() game:GetService("ScriptInformationProvider"):SetAssetUrl(baseUrl .. "/Asset/") end)
pcall(function() game:GetService("InsertService"):SetBaseSetsUrl(baseUrl .. "/Game/Tools/InsertAsset.ashx?nsets=10&type=base") end)
pcall(function() game:GetService("InsertService"):SetUserSetsUrl(baseUrl .. "/Game/Tools/InsertAsset.ashx?nsets=20&type=user&userid=%d") end)
pcall(function() game:GetService("InsertService"):SetCollectionUrl(baseUrl .. "/Game/Tools/InsertAsset.ashx?sid=%d") end)
pcall(function() game:GetService("InsertService"):SetAssetUrl(baseUrl .. "/Asset/?id=%d") end)
pcall(function() game:GetService("InsertService"):SetAssetVersionUrl(baseUrl .. "/Asset/?assetversionid=%d") end)
pcall(function() game:SetCreatorID(userId, Enum.CreatorType.User) end)

local history = game:GetService("ChangeHistoryService")
pcall(function() history:SetEnabled(false) end)

if placeUrl ~= "" then
\tgame:Load(placeUrl)
else
\t-- A new place: a baseplate and a spawn, like Studio's Baseplate template.
\tlocal baseplate = Instance.new("Part")
\tbaseplate.Name = "Baseplate"
\tbaseplate.Anchored = true
\tbaseplate.Locked = true
\tbaseplate.Size = Vector3.new(512, 20, 512)
\tbaseplate.CFrame = CFrame.new(0, -10, 0)
\tbaseplate.BrickColor = BrickColor.new("Dark stone grey")
\tbaseplate.TopSurface = Enum.SurfaceType.Studs
\tbaseplate.Parent = workspace
\tlocal spawn = Instance.new("SpawnLocation")
\tspawn.Anchored = true
\tspawn.Size = Vector3.new(12, 1, 12)
\tspawn.CFrame = CFrame.new(0, 0.5, 0)
\tspawn.Parent = workspace
end

if placeId > 0 then
\tpcall(function() game:SetPlaceId(placeId, false) end)
\tif universeId > 0 then pcall(function() game:SetUniverseId(universeId) end) end
\tpcall(function() game:GetService("Visit"):SetUploadUrl(uploadUrl) end)
end
pcall(function() history:SetEnabled(true) end)
`;
  }

  function editScript(ctx) {
    const placeId = Number(ctx.queryLower.placeid) || 0;
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
    let script;
    if (placeId === 0) {
      const account = currentAccount(ctx);
      script = editScriptFor(ctx, { placeId: 0, universeId: 0, userId: account ? account.userId : 0 });
    } else {
      const allowed = authorize(ctx, placeId);
      if (allowed.error) {
        // Shown in Studio's Output window.
        script = `\r\nerror(${lua(allowed.error)})\r\n`;
      } else {
        const urls = editUrls(ctx, allowed.account, placeId);
        script = editScriptFor(ctx, {
          placeId, universeId: allowed.place.universeId, userId: allowed.account.userId,
          placeUrl: urls.placeUrl, uploadUrl: urls.uploadUrl,
        });
      }
    }
    const signed = sign(script);
    if (signed === null) return send(ctx, 500, headers, 'The server cannot sign scripts (Server/rbxsig_private.pem missing).');
    send(ctx, 200, headers, signed);
  }

  function placeDownload(ctx, match) {
    const allowed = authorize(ctx, match[1]);
    if (allowed.error) return send(ctx, allowed.status, { 'Content-Type': 'text/plain; charset=utf-8' }, allowed.error);
    sendFile(ctx, places.filePath(allowed.place), { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  }

  // Studio posts the whole place (binary .rbxl, sometimes gzipped).
  async function upload(ctx) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
    if (ctx.method !== 'POST') return send(ctx, 405, headers, 'use POST');
    const placeId = ctx.queryLower.assetid;
    const allowed = authorize(ctx, placeId);
    if (allowed.error) return send(ctx, allowed.status, headers, allowed.error);
    let bytes = await ctx.body();
    const declared = Number(ctx.req.headers['content-length']);
    if (Number.isFinite(declared) && declared !== bytes.length) return send(ctx, 413, headers, 'The upload was cut short.');
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try { bytes = zlib.gunzipSync(bytes, { maxOutputLength: MAX_PLACE_BYTES }); } catch (error) { return send(ctx, 400, headers, 'The upload could not be unpacked.'); }
    }
    const head = bytes.subarray(0, 8).toString('latin1');
    if (!head.startsWith('<roblox')) return send(ctx, 400, headers, 'That is not a Roblox place.');
    const place = places.replaceFile(allowed.place.placeId, { bytes, notes: [], from: `Studio (${allowed.account.name})` });
    const key = String(allowed.place.placeId);
    if (pendingOnline.has(key)) {
      places.update(key, { enabled: pendingOnline.get(key) });
      pendingOnline.delete(key);
    }
    core.appendLog(path.join(core.rootPath('Webserver', 'node', 'logs'), 'studio.log'),
      `${core.gmdate()}  ${allowed.account.name} published ${place.name} (place ${key}, version ${place.version}, ${bytes.length} bytes)`, 1024 * 1024);
    send(ctx, 200, headers, String(place.version));
  }

  // --- /manage (host key) ---------------------------------------------------------------
  //   GET    /api/studio/accounts             every account
  //   POST   /api/studio/accounts/<name>      {admin: true|false}
  //   DELETE /api/studio/accounts/<name>      delete it (how a password is reset)
  //   POST   /api/places/<id>/access          {owner: "name" | "", editors: ["name", ...]}

  function hostKeyOk(ctx) {
    const key = ctx.req.headers['x-host-key'] !== undefined ? String(ctx.req.headers['x-host-key']) : '';
    return games.checkHostKey(key);
  }

  async function manageAccounts(ctx, match) {
    if (!hostKeyOk(ctx)) return sendJson(ctx, 403, { error: 'wrong or missing host key (config/host-key.txt on the server)' });
    const name = match[1] ? decodeURIComponent(match[1]) : null;
    if (name === null) {
      if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
      return sendJson(ctx, 200, { accounts: accounts.list() });
    }
    if (ctx.method === 'DELETE') {
      return accounts.remove(name) ? sendJson(ctx, 200, { ok: true }) : sendJson(ctx, 404, { error: 'no such account' });
    }
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST or DELETE' });
    const body = await jsonBody(ctx);
    const account = accounts.setAdmin(name, Boolean(body.admin));
    return account ? sendJson(ctx, 200, { account }) : sendJson(ctx, 404, { error: 'no such account' });
  }

  async function manageAccess(ctx, match) {
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
    if (!hostKeyOk(ctx)) return sendJson(ctx, 403, { error: 'wrong or missing host key (config/host-key.txt on the server)' });
    const place = places.get(match[1]);
    if (!place) return sendJson(ctx, 404, { error: 'no such place' });
    const body = await jsonBody(ctx);
    const change = {};
    if (body.owner !== undefined) {
      const ownerName = String(body.owner || '').trim();
      if (!ownerName) change.owner = null;
      else {
        const owner = accounts.byName(ownerName);
        if (!owner) return sendJson(ctx, 400, { error: `There is no Studio account called ${ownerName}.` });
        change.owner = { userId: owner.userId, name: owner.name };
      }
    }
    if (body.editors !== undefined) {
      change.editors = [];
      for (const raw of Array.isArray(body.editors) ? body.editors : []) {
        const editorName = String(raw).trim();
        if (!editorName) continue;
        const editor = accounts.byName(editorName);
        if (!editor) return sendJson(ctx, 400, { error: `There is no Studio account called ${editorName}.` });
        change.editors.push({ userId: editor.userId, name: editor.name });
      }
    }
    return sendJson(ctx, 200, { place: places.setAccess(place.placeId, change) });
  }

  // /asset/?id=<place>&studioplace=1&t=<edit token>: the place file for
  // game:Load. Called by the asset endpoint; true when it answered.
  function placeAsset(ctx) {
    if (ctx.queryLower.studioplace === undefined) return false;
    placeDownload(ctx, [null, String(ctx.queryLower.id || '')]);
    return true;
  }

  const routes = [
    [/^my\/places\.aspx/i, page('start.html')],
    [/^ide\/(?:publishas|publishgameas|upload\.aspx)\/?$/i, page('publish.html')],
    [/^ide\/clienttoolbox\.aspx/i, toolboxPage],
    [/^studio\/(start\.html|publish\.html|studio\.css|studio\.js)$/i, pageAsset],
    [/^studio\/api\/(me|login|logout|games|open|publish|editors)\/?$/i, api],
    [/^studio\/place\/(\d{1,15})\/?$/i, placeDownload],
    [/^game\/edit\.ashx\/?$/i, editScript],
    [/^data\/upload\.ashx\/?$/i, upload],
    [/^game\/getcurrentuser\.ashx\/?$/i, getCurrentUser],
    [/^login\/requestauth\.ashx\/?$/i, requestAuth],
    [/^login\/negotiate\.ashx(?:\/index\.php)?\/?$/i, negotiate],
    [/^v2\/login\/?$/i, v2Login],
    [/^sign-out\/v1\/?$/i, signOut],
    [/^game\/logout\.aspx\/?$/i, gameLogout],
    [/^my\/settings\/json\/?$/i, mySettings],
    [/^api\/studio\/accounts(?:\/([A-Za-z0-9_]{3,20}))?\/?$/i, manageAccounts],
    [/^api\/places\/(\d{1,15})\/access\/?$/i, manageAccess],
    // Studio's usage statistics: nothing collects them here.
    [/^(?:game\/report-stats|analytics\/measurement\.ashx|game\/report-event)\/?$/i, (ctx) => send(ctx, 200, { 'Content-Type': 'text/plain' }, '')],
  ];

  return { routes, placeAsset };
};
