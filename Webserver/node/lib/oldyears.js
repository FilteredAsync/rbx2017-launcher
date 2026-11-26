'use strict';

// Games of the self-hosted years (lib/engines.js selfHosted: 2009, 2011, 2013). No
// RCC survives from before 2015, so a copy of that year's client hosts the
// game (lib/hosting.js): it runs the server script below, which loads the
// place, starts NetworkServer and reports who is playing. Players' clients
// run the join script below, which connects to "localhost": the launcher's
// game relay (lib/relay.js) carries the game traffic from 127.0.0.1 to the
// server, so these clients never connect to another address (which their
// scripts may not do).
//
//   GET  game/oldyears/server.lua?job=&port=&file=&place=&max=&token=   the host's script
//   GET  game/oldyears/join.lua?game=&ticket=&relayport=                a player's script
//   GET  game/oldyears/report?job=&token=&names=a,b                     the host: who is playing
//   POST api/oldyears/players {key, job}                                 -> { players } (lib/hosting.js)
//   GET  game/oldyears/bodycolors?userId=                               a player's body colors (old XML)
//   GET  asset/GetScriptState.ashx?ScriptHash=                           "true": the old clients ask this
//                                                                        before running each script
//
// The clients take scripts signed with our key (Server/rbxsig_private.pem,
// patched into them by tools/make-engine.py) in their old form:
// "%<signature>%" + "\r\n" + script, the signature over "\r\n" + script.
// Their trust check wants "localhost./" right before "game/" in a script's
// address, so every address here is http://www.localhost./game/... (the
// host's and players' www.localhost. is this web server, or their local
// proxy to it).

const crypto = require('crypto');
const fs = require('fs');
const core = require('./core');
const engines = require('./engines');
const games = require('./games');
const places = require('./places');
const avatarStore = require('./avatarstore');

const BASE = 'http://www.localhost./';
// A host that hasn't reported for this long is "unknown" (players null).
const REPORT_MS = 90 * 1000;

let keyCache = { stamp: null, key: null };
function signingKey() {
  const file = core.rootPath('Server', 'rbxsig_private.pem');
  const stamp = core.mtimeMs(file);
  if (stamp !== keyCache.stamp) {
    let key = null;
    try { key = crypto.createPrivateKey(fs.readFileSync(file)); } catch (error) { key = null; }
    keyCache = { stamp, key };
  }
  return keyCache.key;
}

// The old signed form, or null without a key.
function oldSign(script) {
  const key = signingKey();
  if (key === null) return null;
  const body = `\r\n${script}`;
  const signature = crypto.sign('sha1', Buffer.from(body, 'latin1'), key).toString('base64');
  return `%${signature}%${body}`;
}

// The host's proof for a job: an HMAC of the job ID with the host key, which
// the always-on server (lib/hosting.js) and this web server both have.
function hostToken(hostKey, jobId) {
  return crypto.createHmac('sha256', String(hostKey)).update(`oldyears.${jobId}`).digest('hex').slice(0, 32);
}

function tokenOk(jobId, token) {
  const expected = hostToken(games.ensureHostKey(), jobId);
  const given = String(token || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// A Lua string literal (Lua 5.1 long strings can't hold every name safely).
function lua(text) {
  return `"${String(text).replace(/[\\"]/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/[\x00-\x1f\x7f-\xff]/g, (c) => `\\${String(c.charCodeAt(0)).padStart(3, '0')}`)}"`;
}

// --- the host's script ----------------------------------------------------------------------

// Loads the place (from the host's own content folder, where lib/hosting.js
// links it, else from the web server), starts the server on the port, gives
// players characters (the 2009 engine has no CharacterAutoLoads) and reports
// the player list on every change and every 30 s. Its scripts must not wait
// on their main thread (2009 runs a command-line script on the app's own).
function serverScript({ jobId, token, port, file, placeId, maxPlayers }) {
  const report = `${BASE}game/oldyears/report?job=${jobId}&token=${token}`;
  return `-- rbx2017: game server script (lib/oldyears.js)
local port = ${Number(port)}
local reportUrl = ${lua(report)}
local players = game:GetService("Players")

-- 2013 has HttpGet; 2009 only loadfile, which fetches the address too (the
-- answer is an empty signed script) but keeps what it fetched by address:
-- each request gets a number of its own.
local sent = 0
local function get(url)
  sent = sent + 1
  url = url .. "&n=" .. sent
  local ok = pcall(function() game:HttpGet(url, true) end)
  if not ok then pcall(function() loadfile(url) end) end
end

local function encode(text)
  return (string.gsub(tostring(text), "[^%w%-_%.]", function(c) return string.format("%%%02X", string.byte(c)) end))
end

-- The player list, without one who is leaving.
local function report(leaving)
  local names = {}
  for _, p in pairs(players:GetChildren()) do
    if p ~= leaving and p:IsA("Player") then table.insert(names, p.Name) end
  end
  get(reportUrl .. "&names=" .. encode(table.concat(names, ",")))
end

local loaded = pcall(function() game:Load(${lua(`rbxasset://${file}`)}) end)
if not loaded then
  loaded = pcall(function() game:Load(${lua(`${BASE}asset/?id=${placeId}`)}) end)
end
get(reportUrl .. "&event=" .. (loaded and "loaded" or "load-failed"))

pcall(function() players.MaxPlayers = ${Number(maxPlayers) || 12} end)
pcall(function() players.maxPlayers = ${Number(maxPlayers) || 12} end)
local autoLoads = pcall(function() players.CharacterAutoLoads = true end)

-- Per player, on the event's own thread: a character, and a new one 5 s
-- after dying (2009 has no CharacterAutoLoads).
local function playerLoop(p)
  wait(1)
  pcall(function() p:LoadCharacter() end)
  while p.Parent do
    local character = p.Character
    local humanoid = character and character:FindFirstChild("Humanoid")
    if not character or not character.Parent or (humanoid and humanoid.Health <= 0) then
      wait(5)
      if p.Parent then pcall(function() p:LoadCharacter() end) end
    end
    wait(1)
  end
end

-- PlayerAdded (2009 fires no ChildAdded for players who connect).
players.PlayerAdded:connect(function(p)
  report()
  pcall(function() p.Changed:connect(function(property) if property == "Name" then report() end end) end)
  if not autoLoads then playerLoop(p) end
end)
players.PlayerRemoving:connect(function(p) report(p) end)

local ns = game:GetService("NetworkServer")
local started = pcall(function() ns:Start(port) end)
if not started then pcall(function() ns:start(port) end) end
pcall(function() game:GetService("RunService"):Run() end)
report()
-- And every 30 s, on a thread of its own: a 2009 command-line script runs
-- on the app's main thread, where waiting would stop the whole server.
local function every30()
  report()
  delay(30, every30)
end
if not pcall(function() delay(30, every30) end) then pcall(function() Delay(30, every30) end) end
`;
}

// --- a player's script ------------------------------------------------------------------------

// Connects to the game through the launcher's relay (127.0.0.1:relayPort),
// as the player the join ticket names.
function joinScript({ userId, name, relayPort }) {
  return `-- rbx2017: join script (lib/oldyears.js)
local userId = ${Number(userId) || 0}
local name = ${lua(name)}
local port = ${Number(relayPort)}
local client = game:GetService("NetworkClient")
local players = game:GetService("Players")

local function say(text) pcall(function() game:SetMessage(text) end) end
say("Connecting to the game...")

client.ConnectionAccepted:connect(function(url, replicator)
  say("Loading the game...")
  pcall(function() game:GetService("RunService"):Run() end)
  local done = false
  local marked = pcall(function()
    local marker = replicator:SendMarker()
    marker.Received:connect(function() done = true end)
  end)
  local waited = 0
  while marked and not done and waited < 60 do wait(0.5) waited = waited + 0.5 end
  local player = players.LocalPlayer
  if player and not player.Character then pcall(function() replicator:RequestCharacter() end) end
  pcall(function() game:ClearMessage() end)
end)
client.ConnectionRejected:connect(function() say("The game turned you away.") end)
client.ConnectionFailed:connect(function(_, id) say("Couldn't connect to the game (" .. tostring(id) .. ").") end)
pcall(function() client.Disconnection:connect(function() say("You were disconnected.") end) end)

-- 2013 has PlayerConnect. 2009 makes the local player first; only Roblox's
-- own scripts could set a player's ID and name there, a check
-- tools/make-engine.py takes out. A script error there closes the app.
local player
local ok, problem = pcall(function()
  if pcall(function() local f = client.PlayerConnect end) then
    player = client:PlayerConnect(userId, "localhost", port, 0, 20)
    pcall(function() player.Name = name end)
  else
    player = players:CreateLocalPlayer(userId)
    pcall(function() player.Name = name end)
    client:Connect("localhost", port, 0, 20)
  end
end)
if not ok then say("Couldn't join: " .. tostring(problem)) end
pcall(function() player:SetSuperSafeChat(false) end)
pcall(function() player.CharacterAppearance = ${lua(`${BASE}game/oldyears/bodycolors?userId=${Number(userId) || 0}`)} end)
`;
}

// A player's body colors as the old engines read a CharacterAppearance (a
// model file with one BodyColors).
function bodyColorsXml(userId) {
  const saved = avatarStore.get(userId);
  const colors = saved && saved.bodyColors ? saved.bodyColors : avatarStore.GUEST_DEFAULT.bodyColors;
  const ints = avatarStore.COLOR_KEYS.map((key) => `<int name="${key}">${Number(colors[key]) || 194}</int>`).join('');
  return '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    + 'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4"><External>null</External><External>nil</External>'
    + `<Item class="BodyColors">\n<Properties>${ints}<string name="Name">Body Colors</string></Properties>\n</Item></roblox>`;
}

// --- who is playing ---------------------------------------------------------------------------

const reports = new Map(); // jobId -> { names, at, loaded }

// Hosts report every 30 s. A list with players goes stale after REPORT_MS
// without a report (a hung host); "nobody" holds until the next one.
function playersOf(jobId) {
  const entry = reports.get(jobId);
  if (!entry) return null;
  if (entry.names.length === 0) return [];
  return Date.now() - entry.at < REPORT_MS ? entry.names : null;
}

module.exports = function oldYears({ send, sendJson, jsonBody, launcher }) {
  const textNoStore = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

  function sendSigned(ctx, script) {
    const signed = oldSign(script);
    if (signed === null) return send(ctx, 500, textNoStore, 'No script signing key on this server (Server/rbxsig_private.pem).');
    return send(ctx, 200, textNoStore, signed);
  }

  function server(ctx) {
    const q = ctx.queryLower;
    const jobId = /^[0-9a-f]{16,32}$/.test(String(q.job || '')) ? String(q.job) : null;
    if (!jobId || !tokenOk(jobId, q.token)) return send(ctx, 403, textNoStore, 'Not this server\'s game.');
    const port = Number(q.port);
    const file = String(q.file || '');
    const placeId = places.placeKey(q.place);
    if (!(port > 0 && port < 65536) || placeId === null || !/^places\/[\w ()'.\/-]+\.rbxlx?$/i.test(file) || file.includes('..')) {
      return send(ctx, 400, textNoStore, 'Bad server script request.');
    }
    return sendSigned(ctx, serverScript({ jobId, token: String(q.token), port, file, placeId, maxPlayers: Number(q.max) }));
  }

  function join(ctx) {
    const q = ctx.queryLower;
    const game = games.get(String(q.game || ''));
    if (!game) return sendSigned(ctx, 'game:SetMessage("That server is no longer running. Press Play to join another one.")');
    if (game.privateId && !launcher.ticketAllows(q.ticket, game.id)) {
      return sendSigned(ctx, 'game:SetMessage("That is a private server. Join it from the launcher.")');
    }
    const relayPort = Number(q.relayport);
    if (!(relayPort > 0 && relayPort < 65536)) return sendSigned(ctx, 'game:SetMessage("This join is missing its relay port. Update the launcher.")');
    const who = launcher.joinIdentity(q.ticket, ctx.remote);
    return sendSigned(ctx, joinScript({ userId: who.userId, name: who.name, relayPort }));
  }

  function report(ctx) {
    const q = ctx.queryLower;
    const jobId = String(q.job || '');
    if (!/^[0-9a-f]{16,32}$/.test(jobId) || !tokenOk(jobId, q.token)) return send(ctx, 403, textNoStore, '');
    const entry = reports.get(jobId) || { names: [], at: 0, loaded: null };
    if (q.event === 'loaded' || q.event === 'load-failed') entry.loaded = q.event === 'loaded';
    if (q.names !== undefined) {
      entry.names = String(q.names).split(',').map((name) => name.trim()).filter((name) => /^[\w .-]{1,40}$/.test(name)).slice(0, 100);
    }
    entry.at = Date.now();
    reports.set(jobId, entry);
    return sendSigned(ctx, '');
  }

  async function playersApi(ctx) {
    if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
    const body = await jsonBody(ctx);
    if (!games.checkHostKey(body.key)) return sendJson(ctx, 403, { error: 'wrong host key' });
    const jobId = String(body.job || '');
    const entry = reports.get(jobId);
    return sendJson(ctx, 200, { players: playersOf(jobId), loaded: entry ? entry.loaded : null });
  }

  // The old clients ask for each script's approval by its hash ("HashApproval")
  // and skip a script without a "true".
  function scriptState(ctx) {
    return send(ctx, 200, textNoStore, 'true');
  }

  function bodyColors(ctx) {
    const userId = Number(ctx.queryLower.userid);
    return send(ctx, 200, { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' }, bodyColorsXml(Number.isFinite(userId) ? userId : 0));
  }

  return {
    routes: [
      [/^game\/oldyears\/server\.lua\/?$/i, server],
      [/^game\/oldyears\/join\.lua\/?$/i, join],
      [/^game\/oldyears\/report\/?$/i, report],
      [/^game\/oldyears\/bodycolors\/?$/i, bodyColors],
      [/^\/?asset\/getscriptstate\.ashx\/?$/i, scriptState],
      [/^api\/oldyears\/players\/?$/i, playersApi],
    ],
  };
};

module.exports.hostToken = hostToken;
module.exports.oldSign = oldSign;
module.exports.BASE = BASE;
module.exports.selfHostedYears = () => Object.keys(engines.ENGINES).filter((id) => engines.selfHosted(id));
