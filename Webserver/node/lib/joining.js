'use strict';

// Joining a multiplayer game, shared by play.js (playGame.bat) and the
// launcher. A client that only talks to http://localhost./ needs, unless the
// web server runs on this PC, a local proxy on port 80 that forwards its
// requests to the central web server. The 2017 client folder may also hold a
// second client set up for the server's public names (directClient below),
// which talks to them itself and needs no proxy. The game connection goes
// straight to the game server when the server offers that (connect: 'direct'
// in the join answer) and the year's client connects where its join script
// says (lib/engines.js connectsDirectly, the 2017 one); otherwise through a
// local UDP relay on 127.0.0.1 (lib/relay.js).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./core');
const engines = require('./engines');
const proxy = require('./proxy');
const relay = require('./relay');

const CONFIG = core.rootPath('config', 'client.json');
const CLIENT_EXE = core.rootPath('Client', 'RobloxPlayerBeta.exe');

// The client of the game's Roblox version (game.engine from the join answer,
// lib/engines.js): Client/ for 2017, Client<year>/ for the others.
function clientExe(engine) {
  return core.rootPath(engines.clientFolder(engine), 'RobloxPlayerBeta.exe');
}

// Windows 7 and 8: their WinInet may not get through TLS with the VPS's
// certificate, so the client there uses the same names over plain HTTP (the
// VPS serves both; tools/vps/setup-vps.sh --android).
const OLD_TLS = process.platform === 'win32' && /^6\.[12]\./.test(os.release());

// The second client next to the 2017 one, set up for the server's public names
// by tools/patch-0300-client.py --domain: RobloxPlayerBetaDirect.exe (which
// reads AppSettingD.xml), with ClientDirect.txt holding the base address to
// start it with (e.g. https://m.rbx2017.com/; http on Windows 7 and 8).
// Returns { exe, base }, or null to start RobloxPlayerBeta.exe through the
// proxy. Launchers before 1.21.1 always start RobloxPlayerBeta.exe, so the same
// game files work with them.
function directClient(exe) {
  const folder = path.dirname(exe);
  const direct = path.join(folder, 'RobloxPlayerBetaDirect.exe');
  const text = core.readText(path.join(folder, 'ClientDirect.txt'));
  if (text === null || !core.isFile(direct)) return null;
  const base = text.trim();
  if (!/^https?:\/\/m\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\/$/i.test(base)) return null;
  return { exe: direct, base: OLD_TLS ? base.replace(/^https:/i, 'http:') : base };
}

// A client that closes this soon after starting did not get into the game
// (blocked, crashed while loading, or closed by another Roblox).
const EARLY_EXIT_SECONDS = 20;

// Windows exit codes worth a word for the player.
const EXIT_HINTS = {
  0xC0000005: 'It crashed (access violation).',
  0xC0000135: 'Windows could not find a DLL it needs.',
  0xC0000142: 'Windows could not start it (a DLL failed to load).',
  0xC0000409: 'It stopped itself after an internal error.',
};

// 0, 1, ... as is; Windows status codes in hex (3221225477 -> 0xC0000005).
function exitCodeText(code) {
  if (code === null || code === undefined) return 'none';
  const unsigned = code >>> 0;
  return unsigned > 0xffff ? `0x${unsigned.toString(16).toUpperCase()}` : String(code);
}

// What to tell the player when the client closed soon after it started;
// null when it ran normally or was closed from the launcher.
// outcome: { code, seconds, stopped }
function earlyExitProblem({ code, seconds, stopped }) {
  if (stopped || !(seconds < EARLY_EXIT_SECONDS)) return null;
  const hint = code === null || code === undefined ? '' : EXIT_HINTS[code >>> 0] || '';
  const after = Math.round(seconds);
  const when = after < 1 ? 'right after starting' : `${after} second${after === 1 ? '' : 's'} after starting`;
  return `Roblox closed ${when} (exit code ${exitCodeText(code)}).${hint ? ` ${hint}` : ''}`
    + ' If your antivirus put RobloxPlayerBeta.exe in quarantine, restore and allow it. If the real Roblox is open, close it and try again.';
}

// A spawn failure, for the player.
function startProblem(error) {
  const code = error && error.code;
  if (code === 'ENOENT') return 'RobloxPlayerBeta.exe is missing from the game files. If your antivirus removed it, restore it, or download the game files again (Settings > Network).';
  if (['EACCES', 'EPERM', 'UNKNOWN', 'EBUSY'].includes(code)) return `Windows or your antivirus did not let RobloxPlayerBeta.exe start (${code}). Check your antivirus's quarantine and allow it.`;
  return `could not start the client: ${error && error.message ? error.message : error}`;
}

// The 2017 client and Studio get a profile folder of their own. They find
// AppData and Documents through USERPROFILE (not LOCALAPPDATA), so with it
// their settings (GlobalBasicSettings_13.xml, GlobalSettings_13.xml, the
// same names the real Roblox uses), logs and autosaves stay out of the real
// Roblox's folders.
const PROFILE = core.rootPath('profile');
const PROFILE_LOCAL_APPDATA = path.join(PROFILE, 'AppData', 'Local');

function isolatedEnv() {
  for (const parts of [['AppData', 'Local'], ['AppData', 'Roaming'], ['Documents']]) {
    try { fs.mkdirSync(path.join(PROFILE, ...parts), { recursive: true }); } catch (error) { /* spawn still works; it just isn't isolated */ }
  }
  return Object.assign({}, process.env, { USERPROFILE: PROFILE });
}

// Studio's plugins folder is AppData\Local\ROBLOX2017 Revival\Plugins under
// the real home folder (its Qt side ignores USERPROFILE). Before Studio files
// had tools/patch-2017-isolation.py's folder patch it was AppData\Local\Roblox\
// Plugins, the current Roblox Studio's, whose plugins don't compile in 2017.
// Settings Studio saved then keep that path; this moves it. True when changed.
function moveStudioPluginsSetting(home = require('os').homedir()) {
  const file = path.join(PROFILE_LOCAL_APPDATA, 'Roblox', 'GlobalSettings_13.xml');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return false; }
  const base = home.replace(/\\/g, '/').replace(/\/+$/, '');
  const old = `${base}/AppData/Local/Roblox/Plugins`.toLowerCase();
  const pattern = /(<QDir name="PluginsDir">)([^<]*)(<\/QDir>)/;
  const match = text.match(pattern);
  if (!match || match[2].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== old) return false;
  const moved = text.replace(pattern, (all, open, value, close) => `${open}${base}/AppData/Local/ROBLOX2017 Revival/Plugins${close}`);
  fs.writeFileSync(file, moved);
  return true;
}

// The last lines of the 2017 client's own log written since startedAt
// (<profile>\AppData\Local\Roblox\logs\log_<hex>_<n>.txt; before 1.9.0 in
// %LOCALAPPDATA%\Roblox\logs), or [].
function clientLogTail(startedAt, lines = 15) {
  const dirs = [path.join(PROFILE_LOCAL_APPDATA, 'Roblox', 'logs')];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Roblox', 'logs'));
  let newest = null;
  try {
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (error) { continue; }
      for (const name of names) {
        if (!/^log_[0-9A-F]{4,8}_\d+\.txt$/i.test(name)) continue;
        const stat = fs.statSync(path.join(dir, name));
        if (stat.mtimeMs >= startedAt - 2000 && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { dir, name, mtimeMs: stat.mtimeMs };
      }
    }
    if (!newest) return [];
    const text = fs.readFileSync(path.join(newest.dir, newest.name), 'utf8');
    // Players share this log: leave out join tickets and signatures.
    const redact = (line) => line.replace(/\b(ticket|sig|t)=[^&\s"\\]+/gi, '$1=…');
    return [`(${newest.name})`, ...text.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).map(redact)];
  } catch (error) {
    return [];
  }
}

function validUsername(name) {
  return /^[A-Za-z0-9_]{3,20}$/.test(String(name || ''));
}

function loadConfig() {
  return core.readJsonFile(CONFIG) || {};
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 4) + '\n');
}

async function fetchGames(centralUrl) {
  let response;
  try {
    response = await fetch(`${centralUrl}/api/games`, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw new Error(`could not reach the web server at ${centralUrl}: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
  }
  if (!response.ok) throw new Error(`the web server at ${centralUrl} answered HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.games) ? data.games : [];
}

// Asks the web server for a join ticket (lib/launcherapi.js): with a session
// token the player joins as that account, without one as a guest.
// request: { placeId } (any server of the game with room), { gameId } (that
// server) or { privateId } (a private server); a plain string is a game ID.
// When the game has no server with room, the web server starts one and
// answers 202 { starting }: this asks again every few seconds (onWait is
// told each time) until the server is up, cancelled() is true, or waitMs.
// -> { ticket, name, userId, guest, game: { id, name, placeId, address } }
async function joinTicket(centralUrl, request, token, { onWait = null, cancelled = () => false, waitMs = 180000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = JSON.stringify(Object.assign({}, request && typeof request === 'object' ? request : { gameId: request }, { guest: !token }));
  const until = Date.now() + waitMs;
  for (;;) {
    let response;
    try {
      response = await fetch(`${centralUrl}/api/launcher/join`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    } catch (error) {
      throw new Error(`could not reach the web server at ${centralUrl}: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
    }
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    if (response.status === 404 && !data.error) throw new Error('this server is too old for launcher sign-in; update its server files');
    if (!response.ok) throw new Error(data.error || `the web server answered HTTP ${response.status}`);
    if (!data.starting) return data;
    if (Date.now() > until) throw new Error('The game server took too long to start. Try again in a minute.');
    if (onWait) onWait(data.message || 'Starting a server…');
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(1000, Number(data.retryMs) || 2000))));
    if (cancelled()) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
  }
}

// Starts the client in game ({ id, name, address }). Resolves once the client
// is running, with { exited, stop() }; "exited" resolves when the client
// closes (proxy and relay are closed then too).
// With a ticket (from joinTicket) the server decides who joins; a bare
// username works only on servers with "allowNamedJoins" (otherwise the
// player becomes a guest).
async function joinGame({ centralUrl, username, ticket = null, name = null, game, log = console.log, dryRun = false }) {
  if (process.platform !== 'win32') throw new Error('the 2017 client runs on Windows only');
  const exe = clientExe(game && game.engine);
  if (!core.isFile(exe)) throw new Error(`The game client is missing (${exe}). If your antivirus removed it, restore it, or download the game files again (Settings > Network).`);
  if (!ticket && !validUsername(username)) throw new Error('the username needs 3-20 letters, digits or _');
  const userId = ticket ? null : core.localUserId(username);

  // Shared with Studio (both need port 80); closed when neither runs. A client
  // set up for the public names goes there itself.
  const direct = game && game.joinMode === 'direct' ? null : directClient(exe);
  const home = direct ? direct.base : 'http://localhost./';
  let localProxy = null;
  if (direct) {
    log(`The client talks to ${direct.base} itself.`);
  } else if (!proxy.centralIsLocalPort80(centralUrl)) {
    localProxy = await proxy.acquireProxy(centralUrl, log);
    log(`Forwarding the client's web requests to ${centralUrl}.`);
  }
  // The game connection: straight to the game server when the server offers
  // it and this year's client connects there itself; else through a local
  // relay. A client that always connects to one port (the 2018 one) gets the
  // relay there.
  const year = engines.known(game && game.engine);
  const engine = year ? engines.ENGINES[year] : null;
  const connectDirect = game.connect === 'direct' && game.joinMode !== 'direct' && Boolean(engine && engine.connectsDirectly);
  const connectPort = engine ? engine.clientConnectPort || 0 : 0;
  let gameRelay = null;
  if (connectDirect) {
    log(`The client connects to the game server (${game.address}) itself.`);
  } else {
    try {
      gameRelay = await relay.startRelay(game.address, log, connectPort ? { port: connectPort } : {});
    } catch (error) {
      if (localProxy) localProxy.release();
      if (error.code === 'EADDRINUSE') throw new Error(`${error.message}. Close other Roblox games and game servers on this PC, then try again.`);
      throw new Error(`could not reach the game address ${game.address}: ${error.message}`);
    }
    log(`Relaying the game connection to ${gameRelay.target}.`);
  }
  const closeAll = () => {
    if (gameRelay) gameRelay.close();
    if (localProxy) localProxy.release();
  };

  const who = ticket ? `ticket=${ticket}` : `username=${encodeURIComponent(username)}&id=${userId}`;
  const connect = connectDirect ? 'connect=direct' : `relayport=${gameRelay.port}`;
  let joinUrl = `${home}game/placelauncher.ashx/?gameId=${encodeURIComponent(game.id)}&${who}&${connect}`;
  // Clients before 2016 (lib/engines.js directJoin) run their -j address as
  // the join script itself instead of following placelauncher's answer, so
  // they get the join script address it names.
  if (game.joinMode === 'direct') {
    try {
      const answer = await (await fetch(`${centralUrl}${joinUrl.slice(home.length - 1)}`, { signal: AbortSignal.timeout(15000) })).json();
      if (!answer || !answer.joinScriptUrl) throw new Error(answer && answer.message ? answer.message : 'no join script address');
      joinUrl = answer.joinScriptUrl;
    } catch (error) {
      closeAll();
      throw new Error(`could not get the join script: ${error.message}`);
    }
  }
  if (dryRun) {
    log(`Would start the client with -j ${joinUrl}`);
    closeAll();
    return { userId, exited: Promise.resolve(), stop() {} };
  }

  log(`Joining "${game.name}" as ${ticket ? name || 'your account' : `${username} (user ID ${userId})`}.`);
  const startedAt = Date.now();
  let stopped = false;
  let child;
  try {
    child = spawn(direct ? direct.exe : exe, ['--play', '-a', `${home}Login/Negotiate.ashx/`, '-t', 'Test', '-j', joinUrl], {
      cwd: path.dirname(exe),
      stdio: 'ignore',
      env: isolatedEnv(),
    });
  } catch (error) {
    // Windows refuses some files at once (spawn UNKNOWN: blocked, damaged or
    // not a program) instead of through the 'error' event.
    closeAll();
    const problem = startProblem(error);
    log(`${problem} [${error.message}]`);
    throw Object.assign(new Error(problem), { code: error.code });
  }
  if (child.pid) log(`The client started (process ${child.pid}).`);
  // Resolves with { code, seconds, stopped, problem }: problem says what went
  // wrong when the client closed soon after it started (else null).
  const exited = new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      closeAll();
      const seconds = (Date.now() - startedAt) / 1000;
      const outcome = { code, signal, seconds, stopped, problem: null };
      log(`The client closed after ${seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`} (exit code ${exitCodeText(code)}${stopped ? ', closed from the launcher' : ''}).`);
      outcome.problem = earlyExitProblem(outcome);
      if (outcome.problem) {
        log(outcome.problem);
        for (const line of clientLogTail(startedAt)) log(`  client log: ${line}`);
      }
      resolve(outcome);
    });
    child.on('error', (error) => {
      closeAll();
      const problem = startProblem(error);
      log(`${problem} [${error.message}]`);
      reject(Object.assign(new Error(problem), { code: error.code }));
    });
  });
  return {
    userId,
    pid: child.pid,
    exited,
    stop() {
      stopped = true;
      if (child.exitCode === null) {
        try { child.kill(); } catch (error) { /* already gone */ }
      }
    },
  };
}

module.exports = {
  joinGame, joinTicket, fetchGames, validUsername, loadConfig, saveConfig, CONFIG, CLIENT_EXE, clientExe,
  earlyExitProblem, startProblem, exitCodeText, clientLogTail, EARLY_EXIT_SECONDS, isolatedEnv, PROFILE, PROFILE_LOCAL_APPDATA,
  moveStudioPluginsSetting,
};
