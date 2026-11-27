'use strict';

// Hosting a multiplayer game, shared by host.js (hostGame.bat) and the
// launcher:
//   1. Makes sure RCC can reach the central web server: on this PC directly,
//      or through a local proxy on port 80 when the web server is elsewhere.
//   2. Starts RCCService and submits the game job on a fixed UDP port.
//   3. Lists the game on the web server (with the host key) under its public
//      address and keeps it listed until hosting stops.
//
// startHosting(config, { log }) resolves once the game is listed and returns
// { gameId, publicAddress, players(), stop(reason), stopped }. stop() takes the
// game off the list and stops RCC; "stopped" resolves when hosting has ended
// (stop() called, or RCC exited by itself).

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const core = require('./core');
const engines = require('./engines');
const proxy = require('./proxy');

const CONFIG = core.rootPath('config', 'host.json');
// Place files live in the 2017 server's content folder (Server/content/places);
// other engines' RCCs get a hard link of the game's file (linkPlaceFile).
const CONTENT = core.rootPath('Server', 'content');
// Each game's RCC listens for SOAP on its own port ("soapPort"; the first
// game uses RCC's default). Several games can run on one PC side by side.
const SOAP_PORT = 64989;
// The always-on server (dedicated.js) writes this while it runs.
const DEDICATED_PID = path.join(__dirname, '..', 'dedicated.pid');

// PID of the RCCService listening on a SOAP port, or null.
function rccOnPort(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const match = /^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (!match || Number(match[1]) !== port) continue;
    const pid = Number(match[2]);
    const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /RCCService\.exe/i.test(task.stdout || '') ? pid : null;
  }
  return null;
}

// Memory in use by a process in MB (its working set), or null.
function processMemoryMB(pid) {
  const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const match = /"([\d.,\s]+) K"\s*$/m.exec(task.stdout || '');
  return match ? Math.round(Number(match[1].replace(/[.,\s]/g, '')) / 1024) : null;
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// The always-on server's PID while it runs on this PC, else null.
function dedicatedServerPid() {
  const pid = Number((core.readText(DEDICATED_PID) || '').trim());
  return pid && pid !== process.pid && processAlive(pid) ? pid : null;
}

// "place.rbxlx" or "places/Other.rbxlx" under Server/content -> that path
// with forward slashes, or throws.
function placeFilePath(name) {
  const relative = String(name || 'place.rbxlx').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[\w ()'.-]+(\/[\w ()'.-]+)*\.rbxlx?$/i.test(relative) || relative.split('/').includes('..')) {
    throw new Error(`placeFile "${name}" must be a .rbxlx (or .rbxl) file inside Server\\content`);
  }
  if (!core.isFile(path.join(CONTENT, ...relative.split('/')))) throw new Error(`place file not found: Server\\content\\${relative.replace(/\//g, '\\')}`);
  return relative;
}

// Another engine's RCC loads rbxasset://places/... from its own content
// folder, so the game's place file (kept in Server/content) is put there too
// at every start: a hard link (no copy; the 2016 RCC won't read through a
// folder junction, "Unable to load"), or a copy on another drive. Returns the
// place file name to load: a fresh one when an RCC still holds the old link.
function linkPlaceFile(engine, placeFile) {
  if (engine.server === 'Server') return placeFile;
  const source = path.join(CONTENT, ...placeFile.split('/'));
  let target = core.rootPath(engine.server, 'content', ...placeFile.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let current = null;
  try { current = fs.statSync(target, { bigint: true }); } catch (error) { current = null; }
  const wanted = fs.statSync(source, { bigint: true });
  if (current && current.ino === wanted.ino && current.dev === wanted.dev) return placeFile;
  let name = placeFile;
  try {
    fs.rmSync(target, { force: true });
  } catch (error) {
    name = placeFile.replace(/(\.rbxlx?)$/i, `-${Date.now()}$1`);
    target = core.rootPath(engine.server, 'content', ...name.split('/'));
  }
  try {
    fs.linkSync(source, target);
  } catch (error) {
    fs.copyFileSync(source, target);
  }
  return name;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !/^100\./.test(address.address)) return address.address;
    }
  }
  return '127.0.0.1';
}

function localHostKey() {
  const text = core.readText(core.rootPath('config', 'host-key.txt'));
  if (text === null) return null;
  const line = text.split(/\r\n|\r|\n/).map((value) => value.trim()).find((value) => value !== '' && value[0] !== '#');
  return line || null;
}

function loadConfig() {
  return core.readJsonFile(CONFIG) || {};
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 4) + '\n');
}

function canConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function udpPortFree(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => resolve(false));
    socket.bind(port, () => socket.close(() => resolve(true)));
  });
}

async function api(centralUrl, route, body) {
  const response = await fetch(`${centralUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let data = {};
  try { data = await response.json(); } catch (error) { data = {}; }
  return { status: response.status, data };
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlUnescape(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (all, hex, dec, name) => {
    if (name) return named[name.toLowerCase()];
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

// SOAP call to RCC. The game job's Execute stays open while the game runs, so
// that caller does not wait for it; timeoutMs is for short calls.
function soap(action, envelope, timeoutMs, port = SOAP_PORT) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(envelope, 'utf8');
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers: {
        SOAPAction: `"http://localhost./RCCServiceSoap/${action}"`,
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': body.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    if (timeoutMs) request.setTimeout(timeoutMs, () => request.destroy(new Error('RCC did not answer')));
    request.on('error', reject);
    request.end(body);
  });
}

// SOAP port -> folder of an RCC that runs only JSON jobs (lib/engines.js
// jsonJobs, 2018). There a script runs as a Thumbnail job: RCC runs the file
// internalscripts/thumbnails/<Type>.lua and returns what it returns (its
// loadstring is off once a game runs). So each script is written there once,
// named by its content.
const JSON_JOB_PORTS = new Map();

function jobScript(script, soapPort) {
  const server = JSON_JOB_PORTS.get(soapPort);
  if (!server) return script;
  const type = `RB2017_${crypto.createHash('sha1').update(script, 'latin1').digest('hex').slice(0, 20)}`;
  const file = path.join(server, 'internalscripts', 'thumbnails', `${type}.lua`);
  if (!core.isFile(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, script, 'latin1');
  }
  return JSON.stringify({ Mode: 'Thumbnail', Settings: { Type: type, Arguments: [] } });
}

function executeEnvelope(name, script, soapPort = SOAP_PORT) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://localhost./">'
    + `<SOAP-ENV:Body><ns1:Execute><ns1:jobID>GameServer</ns1:jobID><ns1:script><ns1:name>${name}</ns1:name>`
    + `<ns1:script>${xmlEscape(jobScript(script, soapPort))}</ns1:script><ns1:arguments /></ns1:script></ns1:Execute></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function openJobEnvelope(name, script) {
  return '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://localhost./">'
    + '<SOAP-ENV:Body><ns1:OpenJob><ns1:job><ns1:id>GameServer</ns1:id><ns1:expirationInSeconds>360000</ns1:expirationInSeconds>'
    + `<ns1:category>0</ns1:category><ns1:cores>4</ns1:cores></ns1:job><ns1:script><ns1:name>${name}</ns1:name>`
    + `<ns1:script>${xmlEscape(script)}</ns1:script><ns1:arguments /></ns1:script></ns1:OpenJob></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

// RCC's error text in a SOAP fault, or the HTTP status.
function soapFault(result) {
  const match = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(result.body || '');
  return match ? xmlUnescape(match[1]).trim().slice(0, 300) : `HTTP ${result.status}`;
}

// The start() call for gameserver.lua. Its 10th argument (baseUrl, a domain)
// and 23rd (protocol) set RCC's ContentProvider base URL, which RCC needs
// for every web request it makes (assets, saves, characters, chat); without
// them its requests have no host and fail RCC's trust check.
// domain null ("rccDomain": "none" in host.json) leaves both nil, as the
// stock launch did.
// The 7th argument is the script timeout (ScriptContext:SetTimeout): a game
// script that runs this many seconds without yielding is stopped, and its
// name logged, instead of freezing the whole server. Without it one stuck
// Lumber Tycoon 2 script hung RCC, so nobody could join (players timed out
// with ClientNetwork_ConnectFailed_Timeout). Roblox's own servers used about
// 10 seconds; "scriptTimeout" in host.json changes it (0 = no limit).
// Runs one of the RCC memory patch scripts (RobloxClient\patch-rcc-*.ps1)
// against the running RCC and logs its last line.
function runMemoryPatch(script, pid, label, consequence, log) {
  const patch = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    core.rootPath(script), '-ProcessId', String(pid)], { encoding: 'utf8', windowsHide: true });
  const output = `${patch.stdout || ''}\n${patch.stderr || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = output.length ? output[output.length - 1] : `exit code ${patch.status}`;
  if (patch.status === 0) log(`${label}: ${summary}`);
  else log(`warning: ${label} failed, ${consequence}: ${output.join(' | ').slice(0, 300)}`);
}

// cloudEdit: matchmakingContextId (20th argument) 3 makes gameserver.lua a
// Team Create server: ConfigureAsCloudEditServer, no game scripts or physics,
// and the place saved to the web server every 5 minutes and on close.
function startCall(placeId, port, domain, scriptTimeout, cloudEdit = false) {
  const args = new Array(23).fill('nil');
  args[0] = String(placeId);
  args[1] = String(port);
  if (scriptTimeout > 0) args[6] = String(scriptTimeout);
  if (cloudEdit) args[19] = '3';
  if (domain !== null) {
    args[9] = JSON.stringify(domain);
    args[22] = '"http://"';
  }
  return `start(${args.join(', ')})`;
}

// FriendService: gameserver.lua only creates it inside "if access ~= nil",
// and start() gets no access key here, so it never existed. Without it RCC
// never asks who is friends with whom (users/filter-friends and
// user/multiget-friend-requests on api.<domain>, answered by
// lib/launcherapi.js), and the player list shows no friend icons and offers
// friend requests to friends.
const FRIEND_SERVICE = 'pcall(function() game:GetService("FriendService") end)\r\n';

// Replication speed. RCC sends join data in steps, DataSendRate a second (30
// by default, 120 at most), and big games (Jailbreak) then load at about
// 54 KB/s once the first burst is through. 120 cut a Jailbreak join on this
// PC from 57 to 37 s. Most of the rest is terrain, which RCC caps at
// DFIntMaxClusterKBPerSecond (40 KB/s) from its settings (lib/routes.js).
const NETWORK_SETTINGS = 'pcall(function() settings().Network.DataSendRate = 120 end)\r\n';

// The admins' server console (lib/adminconsole.js); nothing when this PC has
// no accounts or library.
function adminConsoleCall(placeId) {
  try {
    return require('./adminconsole').script(placeId);
  } catch (error) {
    return '';
  }
}

// R15 games (/manage, "Avatars"). The 2017 RCC makes R15 characters only
// through its own avatar loading, which never runs here (see appearanceHook),
// so everyone came out R6. A game set to R15 gets the engine's own R15 rig
// (content/fonts/characterR15_3.rbxm, its joints built from its attachments,
// the classic face) as StarterPlayer.StarterCharacter, unless the place has
// a StarterCharacter of its own. The engine adds the R15 Animate script.
const R15_STARTER = `pcall(function()
local starter = game:GetService("StarterPlayer")
if starter:FindFirstChild("StarterCharacter") then return end
local rig = game:GetObjects("rbxasset://fonts/characterR15_3.rbxm")[1]
rig.Humanoid:BuildRigFromAttachments()
local head = rig:FindFirstChild("Head")
if head and not head:FindFirstChild("face") then
	local face = Instance.new("Decal")
	face.Name = "face"
	face.Texture = "rbxasset://textures/face.png"
	face.Parent = head
end
rig.Name = "StarterCharacter"
rig.Parent = starter
print("[host] R15 characters")
end)\r\n`;

function avatarTypeCall(placeId) {
  try {
    const places = require('./places');
    if (places.exists() && places.avatarTypeOf(places.load().places[String(placeId)]) === 'R15') return R15_STARTER;
  } catch (error) { /* no place library on this PC */ }
  return '';
}

// GamePassService:PlayerHasPass asks this address (answered by
// lib/ownership.js: passes the player bought). gameserver.lua never sets
// it, so RCC had none and every PlayerHasPass failed ("LuaWebService error").
function gamePassCall(domain) {
  if (domain === null) return '';
  const url = `http://${domain}/Game/GamePass/GamePassHandler.ashx?Action=HasPass&UserID=%d&PassID=%d`;
  return `pcall(function() game:GetService("GamePassService"):SetPlayerHasPassUrl(${JSON.stringify(url)}) end)\r\n`;
}

// BadgeService's addresses (answered by lib/badges.js via routes.js).
// gameserver.lua sets them only "if access ~= nil" (start() gets no access
// key here) and empties IsBadgeLegal's, so UserHasBadge and AwardBadge failed
// (Clone Tycoon 2 stopped setting up players). Runs after start().
function badgeCall(domain) {
  if (domain === null) return '';
  const url = (call, query) => JSON.stringify(`http://${domain}/Game/Badge/${call}.ashx?${query}`);
  return 'pcall(function() local b = game:GetService("BadgeService")'
    + ` b:SetHasBadgeUrl(${url('HasBadge', 'UserID=%d&BadgeID=%d')})`
    + ` b:SetAwardBadgeUrl(${url('AwardBadge', 'UserID=%d&BadgeID=%d&PlaceID=%d')})`
    + ` b:SetIsBadgeDisabledUrl(${url('IsBadgeDisabled', 'BadgeID=%d&PlaceID=%d')})`
    + ` b:SetIsBadgeLegalUrl(${url('IsBadgeLegal', 'BadgeID=%d')}) end)\r\n`;
}

// Newer games (2018 on) put their menus in PlayerGui before the player has a
// character; the 2017 engine makes PlayerGui only with the first character.
// In games that spawn characters themselves (CharacterAutoLoads off, e.g.
// after a Play button in a menu) the menu then never shows and nobody can
// spawn. A character is loaded for a moment when such a player joins, which
// gives them a PlayerGui with the game's GUIs, then taken away again.
const PLAYERGUI_HOOK = [
  'pcall(function()',
  '  local players = game:GetService("Players")',
  '  players.PlayerAdded:connect(function(p)',
  '    if players.CharacterAutoLoads then return end',
  '    wait(1)',
  '    if p.Parent and not p.Character and not p:FindFirstChild("PlayerGui") then',
  '      pcall(function() p:LoadCharacter() end)',
  '      local c = p.Character',
  '      if c then c:Destroy() end',
  '    end',
  '  end)',
  'end)',
].join('\r\n');

// game.CreatorId and CreatorType for a library place (places.creatorOf): its
// Studio owner, or the imported game's original Roblox creator, so scripts
// that check the creator (admin commands, "is this the real game") see the
// same one as the client (game/join.php). Nothing for other places.
function creatorCall(placeId) {
  let creator = null;
  try {
    const places = require('./places');
    if (places.exists()) creator = places.creatorOf(places.load().places[String(placeId)]);
  } catch (error) { /* no place library on this PC */ }
  if (!creator || !(creator.id > 0)) return '';
  return `pcall(function() game:SetCreatorID(${Math.floor(creator.id)}, Enum.CreatorType.${creator.type === 'Group' ? 'Group' : 'User'}) end)\r\n`;
}

// Runs after start(): dresses each character in the player's avatar.
// RCC's own appearance loading never runs here: it builds its avatar-fetch
// URL without a host and blocks it ("HTTP 0 (http: Trust check failed)").
// So on every spawn this asks the web server for the legacy appearance list
// (game/characterappearance.ashx: body colors + one URL per worn item) and
// applies each item with LoadCharacterAppearance, as older servers did.
// The Lua lives in Server/appearance-hook.lua, shared with start-server.ps1.
// Each dressed character (or one whose appearance list could not be had) is
// marked with a BoolValue __2017Dressed: RCC never fires
// Player.CharacterAppearanceLoaded here, and lib/luacompat.js has scripts
// wait for that mark instead (Jailbreak gives police their items, and
// prisoners their clothes, in that event).
const DRESSED_MARK = 'pcall(function() local c = player.Character if c and not c:FindFirstChild("__2017Dressed") then '
  + 'local m = Instance.new("BoolValue") m.Name = "__2017Dressed" m.Value = true m.Parent = c end end) ';
function appearanceHook() {
  const file = core.rootPath('Server', 'appearance-hook.lua');
  if (!core.isFile(file)) return '';
  let source = fs.readFileSync(file, 'latin1');
  for (const line of ['print("[host] no appearance list', 'print("[host] dressed ']) {
    if (source.includes(line) && !source.includes(`${DRESSED_MARK}${line}`)) source = source.split(line).join(`${DRESSED_MARK}${line}`);
  }
  return source;
}

// Same job as start-server.ps1: open "GameServer", then run gameserver.lua,
// which loads rbxasset://place.rbxlx (Server/content/place.rbxlx) unless the
// game names another place file.
// cloudEdit: { saveUrl } for a Team Create server (saveUrl: where RCC posts
// the place; it carries the place ID and the token the web server checks).
// maxPlayers: RCC turns away players past it.
async function startGameJob(placeId, port, domain, scriptTimeout, log, soapPort = SOAP_PORT, placeFile = 'place.rbxlx', cloudEdit = null, maxPlayers = null, engine = engines.get(), gameId = null) {
  if (engine.jsonJobs) {
    if (cloudEdit) throw new Error(`Team Create servers run on Roblox 2017 only, not ${engine.label}`);
    return startGameServerJob(placeId, port, domain, maxPlayers, gameId, log, soapPort);
  }
  const open = await soap('OpenJob', openJobEnvelope('Bootstrap', 'return true'), 15000, soapPort);
  if (open.status < 200 || open.status >= 300) throw new Error(`RCC rejected OpenJob (HTTP ${open.status})`);

  let source = fs.readFileSync(core.rootPath('Server', 'gameserver.lua'), 'latin1');
  if (placeFile !== 'place.rbxlx') source = source.split('rbxasset://place.rbxlx').join(`rbxasset://${placeFile}`);
  // The 2016 RCC has SetIsPlayerAuthenticationRequired (the 2017 one ignores
  // the call) and then wants each join ticket signed over the job ID, which
  // our join tickets are not: the player was never installed (no character,
  // "Infinite yield ... PlayerGui"). The call goes for such engines.
  if (!engine.playerAuthentication) {
    source = source.split('pcall(function() game:GetService("NetworkServer"):SetIsPlayerAuthenticationRequired(true) end)').join('');
  }
  if (cloudEdit) {
    const stock = 'game:SetServerSaveUrl(dataUrl .. "/ide/publish/UploadFromCloudEdit")';
    if (!source.includes(stock)) throw new Error('Server/gameserver.lua has no cloud edit save line');
    source = source.split(stock).join(`game:SetServerSaveUrl(${JSON.stringify(cloudEdit.saveUrl)})`);
  }
  // No characters on a Team Create server, so no avatar code.
  // Players.MaxPlayers is read-only to this script; MaxPlayersInternal (set
  // before and after the place loads, in case the place file has its own) is not.
  const limit = !cloudEdit && Number(maxPlayers) >= 1
    ? `pcall(function() game:GetService("Players").MaxPlayersInternal = ${Math.round(Number(maxPlayers))} end)\r\n` : '';
  const script = `${source}\r\n${NETWORK_SETTINGS}${creatorCall(placeId)}${cloudEdit ? '' : FRIEND_SERVICE + gamePassCall(domain)}${limit}${startCall(placeId, port, domain, scriptTimeout, Boolean(cloudEdit))}\r\n${limit}${cloudEdit ? '' : `${badgeCall(domain)}${avatarTypeCall(placeId)}${appearanceHook()}\r\n${PLAYERGUI_HOOK}\r\n${adminConsoleCall(placeId)}`}\r\n`;
  soap('Execute', executeEnvelope('GameServer', script, soapPort), 0, soapPort).then((result) => {
    if (result.status < 200 || result.status >= 300) log(`RCC answered the game job with HTTP ${result.status}`);
  }, (error) => log(`game job connection ended: ${error.code || error.message}`));
}

// A game on an RCC that runs only JSON jobs (2018): a "GameServer" job. That
// RCC has none of the Lua calls gameserver.lua makes to set a game up
// (game:SetPlaceID, the Set...Url calls); it loads the place from
// assetgame.<domain>/asset/?id=<placeId> (lib/routes.js answers with the
// game's place file), sets the game up and starts the server on the game port
// itself. SelfContained: the place's details are all here, so RCC does not ask
// api.<domain>/game/load-place-info for them. RCC stops with "missing ...
// setting" without any of these (GameCode, DatacenterId and VipOwnerId may be
// left out).
function gameServerJob(placeId, port, domain, maxPlayers, gameId) {
  let place = null;
  let creator = null;
  try {
    const places = require('./places');
    if (places.exists()) {
      place = places.load().places[String(placeId)] || null;
      creator = places.creatorOf(place);
    }
  } catch (error) { /* no place library on this PC */ }
  const universeId = place && core.decimal(String(place.universeId || '')) ? Number(place.universeId) : Number(placeId);
  const players = Number(maxPlayers) >= 1 ? Math.round(Number(maxPlayers)) : 50;
  return JSON.stringify({
    Mode: 'GameServer',
    Settings: {
      SelfContained: true,
      PlaceId: Number(placeId),
      UniverseId: universeId,
      CreatorId: creator && creator.id > 0 ? Math.floor(creator.id) : 1,
      CreatorType: creator && creator.type === 'Group' ? 'Group' : 'User',
      PlaceVersion: 1,
      MatchmakingContextId: 1,
      PreferredPort: port,
      MaxPlayers: players,
      PreferredPlayerCapacity: players,
      MaxGameInstances: 1,
      GameId: gameId || crypto.randomUUID(),
      MachineAddress: '127.0.0.1',
      BaseUrl: domain || 'localhost.',
      GsmInterval: 60,
      ApiKey: '',
      PlaceVisitAccessKey: '',
      JobSignature: '',
    },
  });
}

async function startGameServerJob(placeId, port, domain, maxPlayers, gameId, log, soapPort) {
  const reply = soap('OpenJob', openJobEnvelope('GameServer', gameServerJob(placeId, port, domain, maxPlayers, gameId)), 0, soapPort);
  // RCC answers once it has read the settings (a refusal comes then); the
  // place loads on its own thread, which the wait for the game port covers.
  const first = await Promise.race([reply.catch((error) => ({ error })), sleep(15000).then(() => null)]);
  if (first && first.error) throw new Error(`RCC did not take the game job: ${first.error.code || first.error.message}`);
  if (first && (first.status < 200 || first.status >= 300)) throw new Error(`RCC refused the game job: ${soapFault(first)}`);
  if (!first) {
    reply.then((result) => {
      if (result.status < 200 || result.status >= 300) log(`RCC refused the game job: ${soapFault(result)}`);
    }, (error) => log(`game job connection ended: ${error.code || error.message}`));
  }
}

// What start() in gameserver.lua is followed by on the other engines, for a
// GameServer job: run once RCC takes players, before the game is listed. No
// appearance hook: this RCC dresses characters itself (and has no
// game:HttpGet).
function gameServerHooks(placeId, domain, scriptTimeout, build) {
  const timeout = scriptTimeout > 0 ? `pcall(function() game:GetService("ScriptContext"):SetTimeout(${scriptTimeout}) end)\r\n` : '';
  // Outbound HTTP for games is off for now: a place could otherwise reach this
  // PC's own services over 127.0.0.1. gameserver.lua does the same for the 2017
  // engine; here it is best effort (this runs once RCC takes players).
  const noHttp = 'pcall(function() game:GetService("HttpService").HttpEnabled = false end)\r\n';
  return `${noHttp}${NETWORK_SETTINGS}${timeout}${FRIEND_SERVICE}${gamePassCall(domain)}${badgeCall(domain)}${avatarTypeCall(placeId)}`
    + `${serverVersionCall(build)}${PLAYERGUI_HOOK}\r\n${adminConsoleCall(placeId)}\r\n`;
}

// The 2018 client's Esc menu waits for RobloxReplicatedStorage.GetServerVersion,
// which that year's ServerStarterScript makes; its RCC runs the 2017 one.
function serverVersionCall(build) {
  return 'pcall(function() local s = game:GetService("RobloxReplicatedStorage") '
    + 'if not s:FindFirstChild("GetServerVersion") then local f = Instance.new("RemoteFunction") f.Name = "GetServerVersion" '
    + `f.OnServerInvoke = function() return ${JSON.stringify(String(build || ''))} end f.Parent = s end end)\r\n`;
}

// Names of the players in the game, or null when RCC does not answer.
async function rccPlayers(soapPort = SOAP_PORT) {
  const lua = 'local n = {} for _, x in pairs(game:GetService("Players"):GetPlayers()) do table.insert(n, x.Name) end return table.concat(n, "\\n")';
  try {
    const result = await soap('Execute', executeEnvelope('Players', lua, soapPort), 8000, soapPort);
    const match = /<ns1:value>([\s\S]*?)<\/ns1:value>/.exec(result.body);
    if (!match) return result.status === 200 ? [] : null;
    // SOAP escapes the newlines between names as &#xA;.
    return xmlUnescape(match[1]).split('\n').map((name) => name.trim()).filter(Boolean);
  } catch (error) {
    return null;
  }
}

function resolvePublicAddress(address, log) {
  // "tailscale:<port>" stands for this PC's Tailscale address.
  const tailscale = /^tailscale:(\d{1,5})$/i.exec(String(address || ''));
  if (!tailscale) return address;
  const ip = core.tailscaleIPv4();
  if (ip) return `${ip}:${tailscale[1]}`;
  log('warning: Tailscale is not connected, so only this PC can join. Connect Tailscale and start hosting again.');
  return `127.0.0.1:${tailscale[1]}`;
}

function fixedDomain(config) {
  if (String(config.rccDomain).toLowerCase() === 'none') return null;
  return /^[A-Za-z0-9.-]+$/.test(String(config.rccDomain || '')) ? config.rccDomain : 'localhost.';
}

async function startHosting(rawConfig, { log = console.log, startRcc = true, dedicated = false } = {}) {
  const config = Object.assign({}, rawConfig);
  config.centralUrl = proxy.normalizeCentralUrl(config.centralUrl);
  if (config.centralUrl === null) throw new Error('the web server address is not valid');
  const gamePort = Number(config.gamePort) || 53640;
  const soapPort = Number(config.soapPort) || SOAP_PORT;
  const placeId = core.decimal(String(config.placeId || '')) ? String(config.placeId) : '1818';
  const placeFile = placeFilePath(config.placeFile);
  // The game's engine (/manage "Version"); its RCC must be on this PC.
  const engine = engines.get(config.engine);
  // RCC exits at once when started through a junction (sandbox copies link
  // their folders), so it runs from its real path.
  let rccExe = engines.rccExe(engine.id);
  // The place file as this RCC loads it (linkPlaceFile).
  let rccPlaceFile = placeFile;
  if (!dedicated && startRcc && dedicatedServerPid()) {
    throw new Error('the always-on server (startServer.bat) is running on this PC and hosts its games; stop it first to host from here');
  }
  const local = proxy.centralIsLocalPort80(config.centralUrl);
  const hostKey = local ? localHostKey() : config.hostKey;
  if (!hostKey) throw new Error(local ? 'no host key yet: start the web server once so it creates config/host-key.txt' : 'enter the host key from config/host-key.txt on the web server PC');

  let localProxy = null;
  let rcc = null;
  const cleanup = () => {
    if (rcc && rcc.exitCode === null) spawnSync('taskkill', ['/PID', String(rcc.pid), '/T', '/F']);
    if (localProxy) localProxy.close();
  };

  try {
    // 1. Web access for RCC ----------------------------------------------------
    if (local) {
      if (!(await canConnect(80, '127.0.0.1', 1500))) throw new Error('the web server is not running on this PC; start it first');
    } else {
      // The 2018 RCC makes its API calls over https (any certificate does).
      localProxy = await proxy.startProxy(config.centralUrl, log, undefined, { https: Boolean(engine.jsonJobs) });
      log(`forwarding RCC's web requests to ${config.centralUrl}`);
    }
    try {
      const list = await fetch(`${config.centralUrl}/api/games`, { signal: AbortSignal.timeout(10000) });
      if (!list.ok) throw new Error(`HTTP ${list.status}`);
    } catch (error) {
      throw new Error(`could not reach the web server at ${config.centralUrl}: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
    }
    // RCC builds api.localhost., data.localhost. and similar names itself
    // (the 2018 one loads the place from assetgame.localhost.).
    const missing = [];
    for (const name of ['api.localhost', 'data.localhost', 'versioncompatibility.api.localhost', ...(engine.jsonJobs ? ['assetgame.localhost'] : [])]) {
      try {
        const resolved = await dns.lookup(name);
        if (!proxy.isLoopbackHost(resolved.address)) missing.push(`${name} (points at ${resolved.address})`);
      } catch (error) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      log(`warning: ${missing.join(', ')} not set up on this PC, so RCC cannot accept players or load characters.`);
      log('         Add the hosts entries once (Setup, or addHostsEntries.bat).');
    }

    // 2. RCCService ------------------------------------------------------------
    if (startRcc) {
      if (process.platform !== 'win32') throw new Error('RCCService runs on Windows only');
      if (!core.isFile(rccExe)) {
        throw new Error(engine.id === engines.DEFAULT_ENGINE ? `RCCService not found at ${rccExe}`
          : `this game is set to ${engine.label}, but the ${engine.label} game server is not installed (${engine.server}\\RCCService.exe)`);
      }
      rccExe = fs.realpathSync.native(rccExe);
      rccPlaceFile = linkPlaceFile(engine, placeFile);
      // Only an RCC on this game's own SOAP port is replaced; other games'
      // RCCs on this PC keep running.
      const previous = rccOnPort(soapPort);
      if (previous) {
        log(`stopping a previous RCCService (SOAP port ${soapPort})...`);
        spawnSync('taskkill', ['/PID', String(previous), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
      }
      // taskkill returns before the process is gone and its ports are released.
      let portFree = false;
      for (let i = 0; i < 40; i++) {
        portFree = !(previous && processAlive(previous)) && !(await canConnect(soapPort, '127.0.0.1', 300)) && await udpPortFree(gamePort);
        if (portFree) break;
        await sleep(250);
      }
      if (previous && processAlive(previous)) throw new Error('a previous RCCService is still running and could not be stopped (if hostGame.bat started it, close that window)');
      if (await canConnect(soapPort, '127.0.0.1', 300)) throw new Error(`TCP port ${soapPort} (RCC's SOAP port) is already in use by another program`);
      if (!portFree) throw new Error(`UDP port ${gamePort} is already in use by another program`);
      log(`starting RCCService${engine.id === engines.DEFAULT_ENGINE ? '' : ` ${engine.label}`} (place ${placeId}${placeFile !== 'place.rbxlx' ? `, ${placeFile}` : ''}, SOAP port ${soapPort})...`);
      if (engine.jsonJobs) JSON_JOB_PORTS.set(soapPort, path.dirname(rccExe));
      else JSON_JOB_PORTS.delete(soapPort);
      const rccArgs = [String(soapPort), '-Console', '-Start', '-verbose'];
      if (engine.placeIdArgument) rccArgs.push(`-PlaceId:${placeId}`);
      rcc = spawn(rccExe, rccArgs, {
        cwd: path.dirname(rccExe),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(500);
        ready = await canConnect(soapPort, '127.0.0.1', 400);
      }
      if (!ready) throw new Error(`RCCService did not open its SOAP port ${soapPort}`);
      // The engine's RCC memory patches (lib/engines.js; the .exe on disk is
      // untouched), each skipped by its host.json switch set to false. 2017:
      // - patch-rcc-place-auth.ps1: once RCC has a web address it holds every
      //   player as "not authenticated"; this changes that one check.
      // - patch-rcc-http-urls.ps1: RCC sends its LuaWebService calls
      //   (IsInGroup, GetRankInGroup, IsFriendsWith...) to https:// and then
      //   refuses them in its own trust check ("LuaWebService error").
      // - patch-rcc-signature.ps1: a 0.300.0.138971 game client (the same
      //   build as RCC) reports its own broken code signature (every client
      //   here is byte-patched) and RCC disconnects it right after joining;
      //   this makes RCC ignore that one report.
      for (const patch of engine.memoryPatches) {
        if (config[patch.skip] !== false) runMemoryPatch(patch.script, rcc.pid, patch.label, patch.consequence, log);
      }
      const domain = fixedDomain(config);
      const scriptTimeout = config.scriptTimeout === undefined ? 10 : Number(config.scriptTimeout) || 0;
      await startGameJob(placeId, gamePort, domain, scriptTimeout, log, soapPort, rccPlaceFile, config.cloudEdit || null, config.maxPlayers || null, engine, config.jobId || null);
      log(`game job submitted on UDP port ${gamePort} (RCC web address ${domain === null ? 'not set' : `http://${domain}/`}, script timeout ${scriptTimeout ? `${scriptTimeout} s` : 'off'})`);
      // gameserver.lua loads the place first (game:Load) and only then takes
      // players (NetworkServer:Start on the game port): a big place takes a
      // minute or more. Listed before that, the first players to join fail to
      // connect, so the game is listed once RCC holds its game port.
      const loadStarted = Date.now();
      const loadLimit = (Number(config.loadTimeoutSeconds) || 600) * 1000;
      while (await udpPortFree(gamePort)) {
        if (rcc.exitCode !== null) throw new Error(`RCCService stopped while loading the place (exit code ${rcc.exitCode})`);
        if (Date.now() - loadStarted > loadLimit) throw new Error(`RCC did not finish loading the place within ${Math.round(loadLimit / 1000)} seconds`);
        await sleep(500);
      }
      log(`place loaded in ${Math.round((Date.now() - loadStarted) / 1000)} s; RCC takes players on UDP port ${gamePort}`);
      if (engine.jsonJobs) {
        try {
          const hooks = await soap('Execute', executeEnvelope('Hooks', gameServerHooks(placeId, domain, scriptTimeout, engine.build), soapPort), 30000, soapPort);
          if (hooks.status < 200 || hooks.status >= 300) log(`warning: RCC refused the game's extra scripts (avatars, admin console): ${soapFault(hooks)}`);
        } catch (error) {
          log(`warning: RCC did not run the game's extra scripts (avatars, admin console): ${error.code || error.message}`);
        }
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  // 3. List the game (not a Team Create server: only Studio joins those) ----------
  const publicAddress = resolvePublicAddress(config.publicAddress || `${lanAddress()}:${gamePort}`, log);
  const fields = { key: hostKey, name: config.gameName || `${os.hostname()}'s game`, placeId, address: publicAddress };
  // The always-on server's own job ID (kept when it registers again), private
  // server and player limit (lib/games.js).
  if (config.jobId) fields.jobId = config.jobId;
  if (config.privateId) fields.privateId = config.privateId;
  if (config.maxPlayers) fields.maxPlayers = config.maxPlayers;
  const listed = !config.cloudEdit;
  let gameId = null;
  let heartbeatSeconds = 15;
  const registerGame = async () => {
    if (!listed) return;
    const result = await api(config.centralUrl, '/api/games/register', fields);
    if (result.status !== 200) throw new Error(`the web server refused the game: ${result.data.error || `HTTP ${result.status}`}`);
    gameId = result.data.id;
    heartbeatSeconds = result.data.heartbeatSeconds || 15;
  };
  try {
    await registerGame();
  } catch (error) {
    cleanup();
    throw error;
  }
  if (listed) log(`listed "${fields.name}" as game ${gameId}; players join at ${publicAddress}`);

  let stopping = false;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const timer = setInterval(async () => {
    if (!listed) return;
    try {
      const result = await api(config.centralUrl, `/api/games/${gameId}/heartbeat`, { key: hostKey });
      if (result.status === 404) {
        await registerGame();
        log(`listed again as game ${gameId} (the web server had restarted)`);
      } else if (result.status !== 200) {
        log(`web server answered the check-in with HTTP ${result.status}`);
      }
    } catch (error) {
      log(`could not reach the web server: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
    }
  }, heartbeatSeconds * 1000);

  // Kicks everyone with a message so the game saves them as they leave
  // (Lumber Tycoon 2 saves on PlayerRemoving), then waits for those saves.
  const savePlayers = async (message, waitSeconds) => {
    const lua = `local n = 0 for _, p in pairs(game:GetService("Players"):GetPlayers()) do n = n + 1 pcall(function() p:Kick(${JSON.stringify(String(message))}) end) end return n`;
    let kicked = 0;
    try {
      const result = await soap('Execute', executeEnvelope('Kick', lua, soapPort), 10000, soapPort);
      kicked = Number((/<ns1:value>(\d+)<\/ns1:value>/.exec(result.body) || [])[1]) || 0;
    } catch (error) {
      return; // RCC not answering: nothing more to save
    }
    if (kicked === 0) return;
    log(`saving ${kicked} player${kicked === 1 ? '' : 's'} before stopping...`);
    for (let i = 0; i < 20; i++) {
      const left = await rccPlayers(soapPort);
      if (left === null || left.length === 0) break;
      await sleep(1000);
    }
    await sleep(Math.max(0, Number(waitSeconds) || 10) * 1000);
  };

  // stop(reason, { kickMessage, saveWaitSeconds }): with kickMessage, players
  // are saved first. "stopped" resolves with { crashed }: true when RCC ended
  // by itself.
  let crashed = false;
  const stop = async (reason = 'stopping...', options = {}) => {
    if (stopping) return stopped;
    stopping = true;
    log(reason);
    clearInterval(timer);
    if (gameId) {
      try { await api(config.centralUrl, `/api/games/${gameId}/close`, { key: hostKey }); } catch (error) { /* offline */ }
    }
    if (options.kickMessage && rcc && rcc.exitCode === null) await savePlayers(options.kickMessage, options.saveWaitSeconds);
    cleanup();
    resolveStopped({ crashed });
    return stopped;
  };
  if (rcc) {
    rcc.on('exit', (code) => {
      if (stopping) return;
      crashed = true;
      stop(`RCCService stopped by itself (exit code ${code}); taking the game off the list.`);
    });
  }

  // True when RCC answers a trivial script within the time limit.
  const ping = async (timeoutMs = 15000) => {
    try {
      const result = await soap('Execute', executeEnvelope('Ping', 'return 1', soapPort), timeoutMs, soapPort);
      return result.status === 200;
    } catch (error) {
      return false;
    }
  };

  // Team Create: has RCC post the place to the web server now (its save
  // address); true when RCC ran it.
  const saveNow = async (timeoutMs = 60000) => {
    try {
      const result = await soap('Execute', executeEnvelope('Save', 'game:ServerSave() return 1', soapPort), timeoutMs, soapPort);
      return result.status === 200;
    } catch (error) {
      return false;
    }
  };

  return {
    get gameId() { return gameId; },
    saveNow,
    publicAddress,
    placeId,
    soapPort,
    gamePort,
    pid: rcc ? rcc.pid : null,
    players: () => rccPlayers(soapPort),
    memoryMB: () => (rcc ? processMemoryMB(rcc.pid) : null),
    ping,
    stop,
    stopped,
  };
}

module.exports = {
  startHosting, loadConfig, saveConfig, localHostKey, lanAddress, rccPlayers, rccOnPort, processAlive,
  dedicatedServerPid, CONFIG, SOAP_PORT, DEDICATED_PID,
};
