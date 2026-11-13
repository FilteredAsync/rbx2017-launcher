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
const dgram = require('dgram');
const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const core = require('./core');
const proxy = require('./proxy');

const CONFIG = core.rootPath('config', 'host.json');
const RCC_EXE = core.rootPath('Server', 'RCCService.exe');
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

function executeEnvelope(name, script) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://localhost./">'
    + `<SOAP-ENV:Body><ns1:Execute><ns1:jobID>GameServer</ns1:jobID><ns1:script><ns1:name>${name}</ns1:name>`
    + `<ns1:script>${xmlEscape(script)}</ns1:script><ns1:arguments /></ns1:script></ns1:Execute></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
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
function appearanceHook() {
  const file = core.rootPath('Server', 'appearance-hook.lua');
  return core.isFile(file) ? fs.readFileSync(file, 'latin1') : '';
}

// Same job as start-server.ps1: open "GameServer", then run gameserver.lua,
// which loads rbxasset://place.rbxlx (Server/content/place.rbxlx) unless the
// game names another place file.
// cloudEdit: { saveUrl } for a Team Create server (saveUrl: where RCC posts
// the place; it carries the place ID and the token the web server checks).
async function startGameJob(placeId, port, domain, scriptTimeout, log, soapPort = SOAP_PORT, placeFile = 'place.rbxlx', cloudEdit = null) {
  const open = await soap('OpenJob', '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://localhost./">'
    + '<SOAP-ENV:Body><ns1:OpenJob><ns1:job><ns1:id>GameServer</ns1:id><ns1:expirationInSeconds>360000</ns1:expirationInSeconds>'
    + '<ns1:category>0</ns1:category><ns1:cores>4</ns1:cores></ns1:job><ns1:script><ns1:name>Bootstrap</ns1:name>'
    + '<ns1:script>return true</ns1:script><ns1:arguments /></ns1:script></ns1:OpenJob></SOAP-ENV:Body></SOAP-ENV:Envelope>', 15000, soapPort);
  if (open.status < 200 || open.status >= 300) throw new Error(`RCC rejected OpenJob (HTTP ${open.status})`);

  let source = fs.readFileSync(core.rootPath('Server', 'gameserver.lua'), 'latin1');
  if (placeFile !== 'place.rbxlx') source = source.split('rbxasset://place.rbxlx').join(`rbxasset://${placeFile}`);
  if (cloudEdit) {
    const stock = 'game:SetServerSaveUrl(dataUrl .. "/ide/publish/UploadFromCloudEdit")';
    if (!source.includes(stock)) throw new Error('Server/gameserver.lua has no cloud edit save line');
    source = source.split(stock).join(`game:SetServerSaveUrl(${JSON.stringify(cloudEdit.saveUrl)})`);
  }
  // No characters on a Team Create server, so no avatar code.
  const script = `${source}\r\n${creatorCall(placeId)}${startCall(placeId, port, domain, scriptTimeout, Boolean(cloudEdit))}\r\n${cloudEdit ? '' : appearanceHook()}\r\n`;
  soap('Execute', executeEnvelope('GameServer', script), 0, soapPort).then((result) => {
    if (result.status < 200 || result.status >= 300) log(`RCC answered the game job with HTTP ${result.status}`);
  }, (error) => log(`game job connection ended: ${error.code || error.message}`));
}

// Names of the players in the game, or null when RCC does not answer.
async function rccPlayers(soapPort = SOAP_PORT) {
  const lua = 'local n = {} for _, x in pairs(game:GetService("Players"):GetPlayers()) do table.insert(n, x.Name) end return table.concat(n, "\\n")';
  try {
    const result = await soap('Execute', executeEnvelope('Players', lua), 8000, soapPort);
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
      localProxy = await proxy.startProxy(config.centralUrl, log);
      log(`forwarding RCC's web requests to ${config.centralUrl}`);
    }
    try {
      const list = await fetch(`${config.centralUrl}/api/games`, { signal: AbortSignal.timeout(10000) });
      if (!list.ok) throw new Error(`HTTP ${list.status}`);
    } catch (error) {
      throw new Error(`could not reach the web server at ${config.centralUrl}: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
    }
    // RCC builds api.localhost., data.localhost. and similar names itself.
    const missing = [];
    for (const name of ['api.localhost', 'data.localhost', 'versioncompatibility.api.localhost']) {
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
      if (!core.isFile(RCC_EXE)) throw new Error(`RCCService not found at ${RCC_EXE}`);
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
      log(`starting RCCService (place ${placeId}${placeFile !== 'place.rbxlx' ? `, ${placeFile}` : ''}, SOAP port ${soapPort})...`);
      rcc = spawn(RCC_EXE, [String(soapPort), '-Console', '-Start', '-verbose', `-PlaceId:${placeId}`], {
        cwd: path.dirname(RCC_EXE),
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
      // Once RCC has a web address it holds every player as "not
      // authenticated"; patch-rcc-place-auth.ps1 changes that one check in
      // RCC's memory (the .exe on disk is untouched). "patchPlaceAuth": false
      // in host.json skips it.
      if (config.patchPlaceAuth !== false) {
        runMemoryPatch('patch-rcc-place-auth.ps1', rcc.pid, 'place-auth patch',
          'players may stay "not authenticated"', log);
      }
      // RCC sends its LuaWebService calls (IsInGroup, GetRankInGroup,
      // IsFriendsWith...) to https:// and then refuses them in its own trust
      // check ("LuaWebService error"); patch-rcc-http-urls.ps1 fixes both in
      // memory. "patchHttpUrls": false in host.json skips it.
      if (config.patchHttpUrls !== false) {
        runMemoryPatch('patch-rcc-http-urls.ps1', rcc.pid, 'LuaWebService patch',
          'group and friend checks in games will fail with "LuaWebService error"', log);
      }
      const domain = fixedDomain(config);
      const scriptTimeout = config.scriptTimeout === undefined ? 10 : Number(config.scriptTimeout) || 0;
      await startGameJob(placeId, gamePort, domain, scriptTimeout, log, soapPort, placeFile, config.cloudEdit || null);
      log(`game job submitted on UDP port ${gamePort} (RCC web address ${domain === null ? 'not set' : `http://${domain}/`}, script timeout ${scriptTimeout ? `${scriptTimeout} s` : 'off'})`);
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  // 3. List the game (not a Team Create server: only Studio joins those) ----------
  const publicAddress = resolvePublicAddress(config.publicAddress || `${lanAddress()}:${gamePort}`, log);
  const fields = { key: hostKey, name: config.gameName || `${os.hostname()}'s game`, placeId, address: publicAddress };
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
      const result = await soap('Execute', executeEnvelope('Kick', lua), 10000, soapPort);
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
      const result = await soap('Execute', executeEnvelope('Ping', 'return 1'), timeoutMs, soapPort);
      return result.status === 200;
    } catch (error) {
      return false;
    }
  };

  // Team Create: has RCC post the place to the web server now (its save
  // address); true when RCC ran it.
  const saveNow = async (timeoutMs = 60000) => {
    try {
      const result = await soap('Execute', executeEnvelope('Save', 'game:ServerSave() return 1'), timeoutMs, soapPort);
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
