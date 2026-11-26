'use strict';

// RobloxClient Launcher: one window for playing, hosting and running the web
// server. The work is done by the same modules as playGame.bat, hostGame.bat
// and startWeb.bat (RobloxClient/Webserver/node/lib), so the console scripts
// and the launcher behave the same. Node scripts run on Electron's own Node,
// so players do not need Node.js installed.

// Fills in what Electron 22 (the Windows 7 build) lacks; first, before anything uses fetch.
const legacy = require('./legacy');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol, screen, globalShortcut, Notification } = require('electron');
const { spawn, spawnSync } = require('child_process');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// Menu music is the player's own file (config/menu-music.mp3), served to the
// window as launcher-media://menu-music; it is not part of the app.
// launcher-net:// brings the window pictures, meshes and item data from the
// web server and the client's own content files (account.js), the menu's
// sound effects too (stream: audio loads fail at random without it).
protocol.registerSchemesAsPrivileged([
  { scheme: 'launcher-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  { scheme: 'launcher-net', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

// The RobloxClient folder: the first folder above this app that has the client.
function findRoot() {
  const start = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const hasWeb = (dir) => fs.existsSync(path.join(dir, 'Webserver', 'node', 'lib'));
  let firstWeb = null;
  let dir = start;
  for (let i = 0; i < 8; i++) {
    // A server-only folder (no Client) works too: it can run the web server
    // and host, just not play.
    const hasGame = fs.existsSync(path.join(dir, 'Client', 'RobloxPlayerBeta.exe')) || fs.existsSync(path.join(dir, 'Server', 'RCCService.exe'));
    if (hasWeb(dir)) {
      if (hasGame) return dir;
      if (firstWeb === null) firstWeb = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A fresh install of the small installer has no game files yet: its own
  // folder is the root, and the setup screen downloads them into it.
  return firstWeb;
}

const ROOT = findRoot();
const lib = (name) => require(path.join(ROOT, 'Webserver', 'node', 'lib', name));
const account = ROOT === null ? null : require('./account')({ ROOT, lib });

let win = null;
// Set once quitting with Studio open was asked (or an update restart needs no asking).
let quitWithStudioConfirmed = false;
let hostSession = null;
let playSession = null;
let webChild = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- launcher log ---------------------------------------------------------------
// What the window's game log shows (joining, game files, Studio) also goes to
// launcher.log in the launcher's app data folder, which updates keep: a
// player can send it when the game does not start (Settings > About > Open
// launcher log). 1 MB, then it moves to launcher.old.log. The host and web
// server logs have their own files in Webserver\node\logs.
const LOG_FILE_AREAS = new Set(['play', 'launcher']);
const LOG_MAX_BYTES = 1024 * 1024;
let logFilePath = null;

function launcherLogFile() {
  if (!logFilePath) logFilePath = path.join(app.getPath('logs'), 'launcher.log');
  return logFilePath;
}

function writeLogFile(area, line) {
  try {
    const file = launcherLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, path.join(path.dirname(file), 'launcher.old.log'));
    } catch (error) { /* no log yet */ }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    fs.appendFileSync(file, `${stamp}  ${area.padEnd(8)} ${line}\n`);
  } catch (error) {
    // Logging must never break anything.
  }
}

function logger(area) {
  return (line) => {
    if (LOG_FILE_AREAS.has(area)) writeLogFile(area, String(line));
    send('log', { area, line: String(line), time: new Date().toLocaleTimeString() });
  };
}

function canConnect(port, host, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Runs a Node script (relative to RobloxClient) on Electron's own Node.
function nodeScript(relative, args, options = {}) {
  return spawn(process.execPath, [...legacy.nodeFlags, path.join(ROOT, relative), ...args], Object.assign({
    cwd: ROOT,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    windowsHide: true,
  }, options));
}

// --- web server -----------------------------------------------------------------

async function webStatus() {
  const core = lib('core');
  const running = await canConnect(80, '127.0.0.1');
  const tailscale = core.tailscaleIPv4();
  return {
    running,
    managed: Boolean(webChild && webChild.exitCode === null),
    localUrl: 'http://127.0.0.1',
    tailscaleUrl: tailscale ? `http://${tailscale}` : null,
  };
}

async function webStart() {
  if (await canConnect(80, '127.0.0.1')) return webStatus();
  const log = logger('web');
  webChild = nodeScript(path.join('Webserver', 'node', 'server.js'), []);
  const forward = (data) => String(data).split(/\r?\n/).filter(Boolean).forEach((line) => log(line.replace(/^\S+ \S+\s+/, '')));
  webChild.stdout.on('data', forward);
  webChild.stderr.on('data', forward);
  webChild.on('exit', (code) => { log(`web server stopped (exit code ${code})`); send('status-changed'); });
  for (let i = 0; i < 20; i++) {
    if (await canConnect(80, '127.0.0.1')) break;
    if (webChild.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  send('status-changed');
  return webStatus();
}

async function webStop() {
  const log = logger('web');
  if (webChild && webChild.exitCode === null) {
    webChild.kill();
  } else {
    // Started outside the launcher (startWeb.bat): stop it through its PID file.
    const pidFile = path.join(ROOT, 'Webserver', 'node', 'server.pid');
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
    if (/^\d+$/.test(pid)) {
      const result = spawnSync('taskkill', ['/PID', pid, '/F'], { encoding: 'utf8', windowsHide: true });
      log(result.status === 0 ? `stopped the web server (PID ${pid})` : `could not stop the web server: ${(result.stderr || '').trim()}`);
    } else {
      log('no web server started by RobloxClient is running');
    }
  }
  for (let i = 0; i < 20 && await canConnect(80, '127.0.0.1'); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  send('status-changed');
  return webStatus();
}

// What this install can do. A player install (Setup.exe) has the client
// only; hosting and running the web server need the server files too.
const STUDIO_EXE = () => path.join(ROOT, 'Studio', 'RobloxStudioBeta.exe');

function capabilities() {
  return {
    canStudio: fs.existsSync(STUDIO_EXE()),
    canPlay: fs.existsSync(path.join(ROOT, 'Client', 'RobloxPlayerBeta.exe')),
    canHost: fs.existsSync(path.join(ROOT, 'Server', 'RCCService.exe')) && fs.existsSync(path.join(ROOT, 'Webserver', 'www')),
  };
}

// --- game files (downloader installer) ---------------------------------------------
// Installs from the small Setup.exe download the game client from the server
// on first run (and when the server has a newer version): see gamefiles.js.

let gameFilesModule = null;
function gameFiles() {
  if (!gameFilesModule) {
    gameFilesModule = require('./gamefiles')({
      root: ROOT,
      normalizeUrl: (url) => lib('proxy').normalizeCentralUrl(url),
      canPlay: () => capabilities().canPlay,
      onProgress: (info) => send('files-progress', info),
      log: logger('play'),
    });
  }
  return gameFilesModule;
}

function installedFiles() {
  return gameFiles().installed();
}

async function downloadGameFiles(centralUrl) {
  if (playSession) throw new Error('Close the game first.');
  const result = await gameFiles().download(centralUrl);
  send('status-changed');
  return result;
}

function filesUpdate(centralUrl) {
  return gameFiles().update(centralUrl);
}

// A /manage token from this PC's host key (config/host-key.txt: the server
// PC, or one it was moved from), or null.
async function hostKeyManageToken(url) {
  let key = null;
  try {
    key = fs.readFileSync(path.join(ROOT, 'config', 'host-key.txt'), 'utf8').split(/\r?\n/).map((line) => line.trim()).find((line) => line && line[0] !== '#') || null;
  } catch (error) {
    return null;
  }
  if (!key) return null;
  try {
    const response = await fetch(`${url}/api/manage/token`, { method: 'POST', headers: { 'X-Host-Key': key }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    return /^[0-9a-f]{64}$/.test(String(data.token || '')) ? data.token : null;
  } catch (error) {
    return null;
  }
}

// Before each game, a player install takes the server's newer game files
// (client fixes and flags reach everyone without a visit to Setup). Progress
// goes out as 'files-progress'. A host install plays from its own Client/.
async function updateFilesBeforePlay(centralUrl, log) {
  const { canPlay, canHost } = capabilities();
  if (canHost || !canPlay) return;
  const files = gameFiles();
  if (files.isBusy()) throw new Error('The game files are downloading. Try again when that is done.');
  const update = await files.update(centralUrl);
  if (!update) return;
  log(`Updating the game files to version ${update.available} (${Math.round(update.size / 1e6)} MB)...`);
  try {
    await files.download(centralUrl);
  } catch (error) {
    throw new Error(`Could not update the game files: ${error.message}`);
  }
  log(`Game files updated to version ${update.available}.`);
  send('status-changed');
}

// Games on another Roblox version (lib/engines.js; /manage "Roblox version")
// need that year's client: Client2016/ for 2016, downloaded from the server
// (client-files-2016) the first time the player joins such a game and
// updated like the 2017 files after that. Progress goes out as
// 'files-progress' with the engine named.
const engineFilesModules = new Map();
function engineFiles(engine) {
  if (!engineFilesModules.has(engine)) {
    const folder = lib('engines').clientFolder(engine);
    engineFilesModules.set(engine, require('./gamefiles')({
      root: ROOT,
      kind: `client${engine}`,
      normalizeUrl: (url) => lib('proxy').normalizeCentralUrl(url),
      canPlay: () => fs.existsSync(path.join(ROOT, folder, lib('engines').clientExeName(engine))),
      onProgress: (info) => send('files-progress', Object.assign({ engine }, info)),
      log: logger('play'),
    }));
  }
  return engineFilesModules.get(engine);
}

// The Roblox versions this launcher can play (sent with each join): the ones
// it knows, and with anyYear any other year the server names (its client
// comes as client-files-<year> into Client<year>/).
function playableEngines() {
  return Object.keys(lib('engines').ENGINES);
}

// Makes sure the client of a game's engine is here and current. True when it
// downloaded something.
async function engineFilesBeforePlay(centralUrl, engine, log) {
  const engines = lib('engines');
  if (!engine || engine === engines.DEFAULT_ENGINE) return false;
  if (!/^\d{4}$/.test(engine)) throw new Error(`This game runs on Roblox ${engine}. Update the launcher to play it.`);
  const exe = path.join(ROOT, engines.clientFolder(engine), engines.clientExeName(engine));
  // A host plays from the folder it packs (tools/make-engine.py), when it has one.
  if (capabilities().canHost && fs.existsSync(exe)) return false;
  const files = engineFiles(engine);
  if (files.isBusy()) throw new Error(`The ${engine} game files are downloading. Try again when that is done.`);
  if (files.installed() && fs.existsSync(exe)) {
    const update = await files.update(centralUrl);
    if (!update) return false;
    log(`Updating the ${engine} game files to version ${update.available} (${Math.round(update.size / 1e6)} MB)...`);
  } else {
    log(`Downloading the ${engine} game files (first ${engine} game on this PC)...`);
  }
  try {
    await files.download(centralUrl);
  } catch (error) {
    throw new Error(`Could not get the ${engine} game files: ${error.message}`);
  }
  log(`The ${engine} game files are ready.`);
  return true;
}

// --- menu music ----------------------------------------------------------------------
// The host's music (config/menu-music.mp3 on the server PC) is downloaded from
// its web server into this launcher's config folder, and fetched again when
// the host changes it. An MP3 the player put there themselves (no
// menu-music.json beside it) is theirs and is never replaced.
const MUSIC_MAX_BYTES = 50 * 1024 * 1024;
let musicSync = null;

function musicFile() {
  return path.join(ROOT, 'config', 'menu-music.mp3');
}

function musicStamp() {
  try {
    return Math.floor(fs.statSync(musicFile()).mtimeMs);
  } catch (error) {
    return null;
  }
}

async function downloadMenuMusic(centralUrl) {
  const url = lib('proxy').normalizeCentralUrl(centralUrl || (lib('joining').loadConfig() || {}).centralUrl || '');
  if (url === null) return false;
  const file = musicFile();
  const infoFile = path.join(ROOT, 'config', 'menu-music.json');
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch (error) {
    info = null;
  }
  const have = fs.existsSync(file);
  if (have && !info) return false;
  const headers = have && info.etag && info.server === url ? { 'If-None-Match': info.etag } : {};
  const response = await fetch(`${url}/download/menu-music.mp3`, { headers, signal: AbortSignal.timeout(120000) });
  if (!response.ok) return false; // 304 (unchanged) or a server without music
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MUSIC_MAX_BYTES) return false;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024 || bytes.length > MUSIC_MAX_BYTES) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, bytes);
  fs.renameSync(`${file}.tmp`, file);
  fs.writeFileSync(infoFile, JSON.stringify({ server: url, etag: response.headers.get('etag') || null }, null, 2));
  return true;
}

function syncMenuMusic(centralUrl) {
  if (!musicSync) {
    musicSync = downloadMenuMusic(centralUrl)
      .then((changed) => { if (changed) send('status-changed'); return changed; })
      .catch(() => false)
      .finally(() => { musicSync = null; });
  }
  return musicSync;
}

// --- moved servers --------------------------------------------------------------------
// When the host moves the server to another PC, the old one answers
// /api/launcher/moved with the new address (config/moved.json there). The
// launcher switches to it once the new server answers, and stays signed in:
// accounts and their sessions move with the server.
let movedCheck = null;

async function followMovedServer() {
  const joining = lib('joining');
  const proxy = lib('proxy');
  const url = proxy.normalizeCentralUrl((joining.loadConfig() || {}).centralUrl || '');
  if (url === null) return false;
  let movedTo = null;
  try {
    const response = await fetch(`${url}/api/launcher/moved`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return false;
    movedTo = (await response.json()).movedTo;
  } catch (error) {
    return false;
  }
  const target = typeof movedTo === 'string' ? proxy.normalizeCentralUrl(movedTo) : null;
  if (!target || target === url) return false;
  try {
    const check = await fetch(`${target}/api/games`, { signal: AbortSignal.timeout(8000) });
    if (!check.ok) return false;
  } catch (error) {
    return false; // not reachable (yet): try again later
  }
  // movedFrom: a server move wins over the address built into the launcher (fixedServer).
  joining.saveConfig(Object.assign({}, joining.loadConfig() || {}, { centralUrl: target, movedFrom: url }));
  account.carrySession(url, target);
  syncMenuMusic(target);
  send('server-moved', { from: url, to: target });
  send('status-changed');
  return true;
}

// --- Tailscale --------------------------------------------------------------------------
// Players reach the server through the VPS relay; Tailscale is only for a
// server still on a Tailscale address (100.64.0.0/10).
function tailscaleAddress(url) {
  const match = /^https?:\/\/100\.(\d{1,3})\.\d{1,3}\.\d{1,3}(?::\d+)?\/?$/i.exec(String(url || ''));
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

// --- the built-in server address ---------------------------------------------------------
// Release builds play on one server: Launcher/default-server.txt, packed into
// the build on the PC that makes it and kept out of the public repository.
// Players then never see or change the address. Running from source (no such
// file), it is set in Settings as before.
let fixedServerUrl;
function fixedServer() {
  if (fixedServerUrl === undefined) {
    fixedServerUrl = null;
    try {
      fixedServerUrl = lib('proxy').normalizeCentralUrl(fs.readFileSync(path.join(__dirname, 'default-server.txt'), 'utf8').trim());
    } catch (error) { /* not a release build */ }
  }
  return fixedServerUrl;
}

// At start: play on the built-in server, unless the server moved players on.
function applyFixedServer() {
  const fixed = fixedServer();
  if (!fixed) return;
  const joining = lib('joining');
  const config = joining.loadConfig() || {};
  const current = config.centralUrl ? lib('proxy').normalizeCentralUrl(config.centralUrl) : null;
  if (current === fixed || (current && config.movedFrom)) return;
  joining.saveConfig(Object.assign({}, config, { centralUrl: fixed }));
  logger('launcher')(`Server set to the built-in address${current ? ` (was ${current})` : ''}.`);
}

// --- presence -------------------------------------------------------------------------------
// Every 30 s, and whenever it changes, the server hears that this launcher is
// open and whether Studio or a game is running (Webserver/node/lib/presence.js),
// so friends see a blue (online), orange (Studio) or green (in game) ring.
let studioPid = null;
let presenceTimer = null;

function studioAlive() {
  if (!studioPid) return false;
  try {
    process.kill(studioPid, 0);
    return true;
  } catch (error) {
    studioPid = null;
    return false;
  }
}

function presenceNow() {
  if (playSession) return { state: 'game', placeId: playSession.placeId || null };
  if (studioAlive() || (studioWatchModule && studioWatchModule.held())) return { state: 'studio' };
  return { state: 'online' };
}

function sendPresence(state) {
  let url;
  try { url = account.serverUrl(); } catch (error) { return Promise.resolve(); }
  return account.presence(url, state || presenceNow()).catch(() => {}); // signed out, or the server is older
}

function startPresence() {
  if (presenceTimer) return;
  sendPresence();
  presenceTimer = setInterval(() => { sendPresence(); checkFriendNews(); checkTalkNews(); }, 30000);
}

// --- friend notifications -------------------------------------------------------------------
// A Windows notification when someone sends you a friend request or accepts
// yours (checked with the presence beat), unless you're looking at the launcher.
let friendSnapshot = null; // { url, incoming: Set, outgoing: Set, friends: Set } of the last check (reset on sign-in/out)

async function checkFriendNews() {
  let url;
  try { url = account.serverUrl(); } catch (error) { return; }
  let data;
  try { data = await account.friends(url); } catch (error) { friendSnapshot = null; return; } // signed out
  const ids = (list) => new Set((list || []).map((person) => person.userId));
  const now = { url, incoming: ids(data.incoming), outgoing: ids(data.outgoing), friends: ids(data.friends) };
  const before = friendSnapshot && friendSnapshot.url === url ? friendSnapshot : null;
  friendSnapshot = now;
  if (!before) return; // the first look only remembers
  const looking = win && !win.isDestroyed() && win.isFocused() && !win.isMinimized() && embedState !== 'embedded';
  if (looking || !Notification.isSupported()) return;
  const named = (list, id) => ((list || []).find((person) => person.userId === id) || {}).name || 'Someone';
  for (const id of now.incoming) {
    if (!before.incoming.has(id)) notify('Friend request', `${named(data.incoming, id)} wants to be your friend.`);
  }
  for (const id of now.friends) {
    if (!before.friends.has(id) && before.outgoing.has(id)) notify('New friend', `${named(data.friends, id)} accepted your friend request.`);
  }
}

// New chat lines and messages (same beat): a notification when you're not
// looking, and the counts for the Chat tab's badge either way.
let talkSnapshot = null; // { url, last: Map(conversation id -> seq), newest: message id }

async function checkTalkNews() {
  let url;
  try { url = account.serverUrl(); } catch (error) { return; }
  let chats;
  let inbox;
  try {
    [chats, inbox] = await Promise.all([account.talk(url, 'GET', 'chat'), account.talk(url, 'GET', 'messages')]);
  } catch (error) { talkSnapshot = null; return; } // signed out, or a server without chat
  send('talk-news', chats.counts || null);
  const now = { url, last: new Map(), newest: 0 };
  for (const c of chats.conversations || []) now.last.set(c.id, c.last ? c.last.seq : 0);
  for (const m of inbox.messages || []) now.newest = Math.max(now.newest, m.id);
  const before = talkSnapshot && talkSnapshot.url === url ? talkSnapshot : null;
  talkSnapshot = now;
  if (!before) return;
  const looking = win && !win.isDestroyed() && win.isFocused() && !win.isMinimized() && embedState !== 'embedded';
  if (looking || !Notification.isSupported()) return;
  const fresh = (chats.conversations || []).filter((c) => c.last && !c.last.mine && c.unread > 0 && c.last.seq > (before.last.get(c.id) || 0));
  for (const c of fresh.slice(0, 3)) {
    const who = c.type === 'group' ? `${c.last.name} in ${c.title}` : c.last.name;
    notify(who, c.last.text.slice(0, 120), 'chat');
  }
  const letters = (inbox.messages || []).filter((m) => m.id > before.newest && !m.read && !m.mine);
  for (const m of letters.slice(0, 2)) notify(`Message from ${m.from.name}`, m.subject, 'chat');
}

function notify(title, body, viewName = 'players') {
  const note = new Notification({ title, body, silent: false });
  note.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (embedState !== 'embedded') send('open-view', viewName);
  });
  note.show();
}

function checkMovedServer() {
  if (!movedCheck) {
    movedCheck = followMovedServer().catch(() => false).finally(() => { movedCheck = null; });
  }
  return movedCheck;
}

// --- announcements --------------------------------------------------------------------
// Notices for players: the host's, from their server (posted on its /manage
// page), and the project's, from announcements.json in the GitHub repository,
// which still reach players while their server is down.
const PROJECT_NEWS_URL = 'https://raw.githubusercontent.com/FilteredAsync/rbx2017-launcher/main/announcements.json';

function cleanNews(list, source) {
  if (!Array.isArray(list)) return [];
  const now = Date.now();
  return list.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim())
    .filter((item) => !item.expiresAt || !(Date.parse(item.expiresAt) <= now))
    .slice(0, 20)
    .map((item) => ({
      id: `${source}:${item.id.slice(0, 40)}`,
      source,
      title: String(item.title || '').slice(0, 80),
      text: item.text.slice(0, 1000),
      level: item.level === 'important' ? 'important' : 'info',
      postedAt: typeof item.postedAt === 'string' ? item.postedAt : null,
    }));
}

async function listAnnouncements() {
  const [server, project] = await Promise.all([
    account.announcements().then((data) => cleanNews(data.announcements, 'server'), () => null),
    fetch(PROJECT_NEWS_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : {}))
      .then((data) => cleanNews(data && data.announcements, 'project'), () => []),
  ]);
  const all = [...project, ...(server || [])];
  all.sort((a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')));
  return { announcements: all, serverReached: server !== null };
}

// --- Roblox Studio --------------------------------------------------------------------
// Downloaded from the server like the game files (Studio/), on first use and
// when the server has a newer one. On a player's PC Studio reaches the
// server through the shared local proxy (http and https on localhost, plus
// Team Create's UDP relay); it stays up while any Studio window is open.

let studioFilesModule = null;
function studioFiles() {
  if (!studioFilesModule) {
    studioFilesModule = require('./gamefiles')({
      root: ROOT,
      kind: 'studio',
      normalizeUrl: (url) => lib('proxy').normalizeCentralUrl(url),
      canPlay: () => fs.existsSync(STUDIO_EXE()),
      onProgress: (info) => send('studio-progress', info),
      log: logger('play'),
    });
  }
  return studioFilesModule;
}

// Studio windows from this install (each opened place is its own process),
// and the proxy hold that keeps them reaching the server (studiowatch.js).
let studioWatchModule = null;
function studioWatch() {
  if (!studioWatchModule) {
    studioWatchModule = require('./studiowatch')({
      studioDir: path.join(ROOT, 'Studio'),
      acquire: (url) => lib('proxy').acquireProxy(url, logger('play')),
      log: logger('play'),
    });
  }
  return studioWatchModule;
}

// True unless Studio is surely closed (when Windows cannot say, assume open).
async function studioRunning() {
  return (await studioWatch().state()) !== 'stopped';
}

// The server Studio talks to, or null on the server's own PC (no proxy there).
function studioServerUrl() {
  const proxy = lib('proxy');
  const url = proxy.normalizeCentralUrl((lib('joining').loadConfig() || {}).centralUrl || '');
  return url === null || proxy.centralIsLocalPort80(url) ? null : url;
}

async function holdProxyForStudio(url) {
  if (lib('proxy').centralIsLocalPort80(url)) return; // the server's own PC
  await studioWatch().hold(url);
}

// Every 20 s while Studio is installed: holds the proxy for a Studio this
// launcher did not start, and lets go once Studio is closed.
function startStudioWatch() {
  if (process.platform !== 'win32') return;
  const look = () => {
    if (!fs.existsSync(STUDIO_EXE()) && !(studioWatchModule && studioWatchModule.held())) return;
    studioWatch().check(studioServerUrl()).catch((error) => logger('play')(`Studio check failed: ${error.message}`));
  };
  setTimeout(look, 5000);
  setInterval(look, 20000);
}

async function openStudio(centralUrl) {
  const joining = lib('joining');
  const url = lib('proxy').normalizeCentralUrl(centralUrl || (joining.loadConfig() || {}).centralUrl || '');
  if (url === null) throw new Error('Enter your server address first (GAMES tab).');
  const log = logger('play');
  const files = studioFiles();
  if (!fs.existsSync(STUDIO_EXE())) {
    log('Downloading Roblox Studio from the server...');
    await files.download(url);
  } else if (!(await studioRunning())) {
    const update = await files.update(url);
    if (update) {
      log(`Updating Roblox Studio (${update.installed} -> ${update.available})...`);
      await files.download(url);
    }
  }
  await holdProxyForStudio(url);
  try {
    if (joining.moveStudioPluginsSetting()) log('Studio plugins now load from AppData\\Local\\ROBLOX2017 Revival\\Plugins.');
  } catch (error) {
    log(`Could not update Studio's plugins folder setting: ${error.message}`);
  }
  // Its own profile folder, like the client's (lib/joining.js isolatedEnv).
  const child = spawn(STUDIO_EXE(), [], { cwd: path.dirname(STUDIO_EXE()), detached: true, stdio: 'ignore', env: lib('joining').isolatedEnv() });
  child.on('error', (error) => log(`Could not start Studio: ${error.message}`));
  child.unref();
  studioPid = child.pid || null;
  sendPresence();
  log(`Roblox Studio started (server ${url}). Log in on its start page.`);
  send('status-changed');
  return true;
}

// --- the game window inside the launcher (embed.js) -------------------------------------
// The client's window becomes the whole of the launcher's window. Players
// leave from the game's own menu (Esc > Leave Game); F11 toggles full screen.
// If it cannot be done, the game simply stays a window of its own.
let embedModule = null;
let embedState = 'off'; // off | waiting | embedded
let fullScreenForGame = false;

function embedder() {
  if (!embedModule) embedModule = require('./embed')({ log: logger('play') });
  return embedModule;
}

// F11 while a game is inside the launcher. The game window has the keyboard,
// so the launcher only hears it as a global shortcut, held just while playing.
// The game's window is then the active one, which Electron does not count.
async function toggleGameFullScreen() {
  if (!win || win.isDestroyed()) return;
  if (!win.isFocused() && !(embedModule && await embedModule.inFront().catch(() => false))) return;
  fullScreenForGame = !win.isFullScreen();
  win.setFullScreen(fullScreenForGame);
}

function setEmbedState(state) {
  embedState = state;
  try {
    if (state === 'embedded' && !globalShortcut.isRegistered('F11')) globalShortcut.register('F11', toggleGameFullScreen);
    if (state !== 'embedded' && globalShortcut.isRegistered('F11')) globalShortcut.unregister('F11');
  } catch (error) { /* another program owns F11 */ }
  send('play-embed', { state });
}

// Where the game goes in the launcher's window: all of it (pixels).
function gameRect() {
  const [width, height] = win.getContentSize();
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  return { x: 0, y: 0, w: Math.round(width * scale), h: Math.round(height * scale) };
}

async function embedClient(session) {
  if (!win || win.isDestroyed() || !session.pid) return;
  setEmbedState('waiting');
  try {
    const handle = win.getNativeWindowHandle(); // 4 bytes in the 32-bit Windows 7 build
    const parent = (handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0)).toString();
    const child = await embedder().attach(session.pid, parent, gameRect());
    if (!child || playSession !== session) {
      setEmbedState('off');
      return;
    }
    setEmbedState('embedded');
    relayoutGame();
  } catch (error) {
    logger('play')(`Could not put the game window inside the launcher (${error.message}); it stays a window of its own.`);
    setEmbedState('off');
  }
}

// Follows the launcher's window size (one move at a time, the latest wins).
let relayingOut = false;
let relayoutAgain = false;
async function relayoutGame() {
  if (!embedModule || !embedModule.attached() || !win || win.isDestroyed()) return;
  if (relayingOut) {
    relayoutAgain = true;
    return;
  }
  relayingOut = true;
  try {
    do {
      relayoutAgain = false;
      await embedModule.move(gameRect());
    } while (relayoutAgain);
  } catch (error) {
    logger('play')(`Could not resize the game window: ${error.message}`);
  } finally {
    relayingOut = false;
  }
}

function gameClosed() {
  if (embedModule) embedModule.forget();
  if (fullScreenForGame && win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false);
  fullScreenForGame = false;
  if (embedState !== 'off') setEmbedState('off');
}

// --- storage --------------------------------------------------------------------------
// Settings > Storage, and a tidy-up at each start (cleanup.js): the 2017
// programs' logs and crash reports older than a week, the installer of a
// launcher update that is now installed, and unfinished downloads.

// electron-updater's download folder (%LOCALAPPDATA%\<name>-updater, named
// in app-update.yml); null for copies that do not update themselves.
function updaterDir() {
  if (!app.isPackaged || !process.env.LOCALAPPDATA) return null;
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const match = /^updaterCacheDirName:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/m.exec(yml);
    return match ? path.join(process.env.LOCALAPPDATA, match[1]) : null;
  } catch (error) {
    return null;
  }
}

let cleanerModule = null;
function cleaner() {
  if (!cleanerModule) {
    cleanerModule = require('./cleanup')({
      root: ROOT,
      localAppData: process.env.LOCALAPPDATA || null,
      privateLocalAppData: lib('joining').PROFILE_LOCAL_APPDATA,
      updaterDir: updaterDir(),
      appVersion: app.getVersion(),
      // Only Studio this launcher downloaded: on a host's PC, Studio\ is the
      // copy its server hands out.
      studioDownloaded: () => !capabilities().canHost && fs.existsSync(path.join(ROOT, 'Studio')) && fs.existsSync(path.join(ROOT, 'config', 'studio-files.json')),
      busy: () => gameFiles().isBusy() || studioFiles().isBusy(),
    });
  }
  return cleanerModule;
}

function megabytes(bytes) {
  return `${Math.round(bytes / 1048576)} MB`;
}

async function tidyAtStart() {
  const log = logger('launcher');
  try {
    const removed = await cleaner().atStart();
    if (removed.files > 0) log(`Tidied up ${removed.files} old file${removed.files === 1 ? '' : 's'} (${megabytes(removed.bytes)}): game logs older than a week, installed launcher updates, unfinished downloads.`);
  } catch (error) {
    log(`Tidy-up failed: ${error.message}`);
  }
}

async function cleanStorage(kind) {
  if (kind === 'updates' && ['downloading', 'ready'].includes(updateStatus.state)) {
    throw new Error('A launcher update is downloading or waiting to install. Restart to update first.');
  }
  if (kind === 'studio' && await studioRunning()) throw new Error('Close Studio first.');
  const result = await cleaner().clean(kind);
  logger('launcher')(`Storage: removed ${result.files} file${result.files === 1 ? '' : 's'} (${megabytes(result.bytes)}) of ${kind}${result.skipped ? `; ${result.skipped} in use were kept` : ''}.`);
  if (kind === 'studio') send('status-changed');
  return result;
}

// --- setup checks -----------------------------------------------------------------

async function checks() {
  const core = lib('core');
  const result = [];
  const add = (id, label, ok, detail, action) => result.push({ id, label, ok, detail, action: action || null });
  const { canPlay, canHost } = capabilities();

  if (!canHost) {
    // Player install: the game files are all it needs.
    const installed = installedFiles();
    add('files', 'Game files', canPlay,
      canPlay ? `Installed in: ${ROOT}${installed ? ` (version ${installed.version})` : ''}` : 'Not downloaded yet: they come from your server.',
      canPlay ? null : 'download-files');
    if (canPlay) {
      const update = await filesUpdate((lib('joining').loadConfig() || {}).centralUrl);
      if (update) add('files-update', 'Game files update', false, `Version ${update.available} is on the server (you have ${update.installed}, ${Math.round(update.size / 1e6)} MB).`, 'download-files');
    }
    return result;
  }

  add('files', canPlay ? 'Client and server files' : 'Server files (server-only folder: playing from this PC is off)', true,
    `RobloxClient folder: ${ROOT}`);

  let hostsOk = true;
  for (const name of ['api.localhost', 'data.localhost', 'versioncompatibility.api.localhost']) {
    try {
      const resolved = await dns.lookup(name);
      if (!/^127\.|^::1$/.test(resolved.address)) hostsOk = false;
    } catch (error) {
      hostsOk = false;
    }
  }
  add('hosts', 'Hosts entries (needed to host games)', hostsOk,
    hostsOk ? 'api.localhost and the other names RCC uses point at this PC.' : 'RCC cannot accept players or load characters without them.', hostsOk ? null : 'hosts');

  const tailscaleIp = core.tailscaleIPv4();
  const tailscaleInstalled = fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe');
  add('tailscale', 'Tailscale connected', Boolean(tailscaleIp),
    tailscaleIp ? `This PC's Tailscale address: ${tailscaleIp}` : (tailscaleInstalled ? 'Tailscale is installed but not connected.' : 'Not installed (tailscale.com/download). Only needed to play with friends over Tailscale.'),
    tailscaleIp ? null : 'tailscale-download');

  const firewall = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-NetFirewallRule -Group 'RobloxClient (Tailscale)' -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8', windowsHide: true });
  const ruleCount = Number(String(firewall.stdout || '').trim()) || 0;
  add('firewall', 'Firewall open for Tailscale players (hosting)', ruleCount >= 2,
    ruleCount >= 2 ? 'TCP 80 and the UDP game port accept Tailscale addresses.' : 'Players on Tailscale cannot reach this PC\'s web server or game.', ruleCount >= 2 ? null : 'firewall');

  const web = await webStatus();
  add('web', 'Web server running on this PC', web.running,
    web.running ? 'Needed on the PC that hosts the game list (and for hosting with http://127.0.0.1).' : 'Only needed on the PC that runs the web server.', null);

  const apiKey = fs.existsSync(path.join(ROOT, 'config', 'roblox-api-key.txt')) || fs.existsSync(path.join(ROOT, 'cache', '.roblosecurity'));
  add('apikey', 'Roblox sign-in for assets (optional)', apiKey,
    apiKey ? 'Assets that need a signed-in download can load.' : 'Some images and sounds need config\\roblox-api-key.txt (see config\\README.txt).', null);
  return result;
}

function runSetupAction(action) {
  const scripts = { hosts: 'add-hosts-entries.ps1', firewall: 'tailscale-firewall.ps1' };
  if (action === 'tailscale-download') {
    shell.openExternal('https://tailscale.com/download/windows');
    return true;
  }
  const script = scripts[action];
  if (!script) return false;
  // These scripts ask for administrator themselves (a UAC prompt).
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script)], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  return true;
}

// --- avatar picture -------------------------------------------------------------------

// Custom game thumbnails live on the web server (/api/thumbnails/<placeId>,
// see Webserver/node/lib/gamethumbs.js). The window gets them as data: URLs,
// cached per place and thumbnail version; null when a place has none.
const thumbnailCache = new Map();
const THUMBNAIL_TYPES = { 'image/png': true, 'image/jpeg': true, 'image/gif': true, 'image/webp': true };

async function gameThumbnail(centralUrl, placeId, version) {
  const url = lib('proxy').normalizeCentralUrl(centralUrl);
  if (url === null || !/^\d{1,15}$/.test(String(placeId || ''))) return null;
  const key = `${url}|${placeId}|${version || ''}`;
  if (thumbnailCache.has(key)) return thumbnailCache.get(key);
  try {
    const response = await fetch(`${url}/api/thumbnails/${placeId}`, { signal: AbortSignal.timeout(8000) });
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    const dataUrl = response.ok && THUMBNAIL_TYPES[type]
      ? `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
      : null;
    if (response.ok || response.status === 404) thumbnailCache.set(key, dataUrl);
    return dataUrl;
  } catch (error) {
    return null; // web server offline: the tile keeps its generated cover
  }
}

// Host tab: pick a picture and upload it for the place, or remove it. Uses
// the same host key as listing the game.
async function hostThumbnail({ action, centralUrl, placeId, hostKey }) {
  const url = lib('proxy').normalizeCentralUrl(centralUrl);
  if (url === null) throw new Error('Enter the web server address first.');
  if (!/^\d{1,15}$/.test(String(placeId || ''))) throw new Error('Enter the place ID first.');
  if (action === 'get') {
    for (const key of [...thumbnailCache.keys()]) if (key.startsWith(`${url}|${placeId}|`)) thumbnailCache.delete(key);
    return { ok: true, dataUrl: await gameThumbnail(url, placeId, `host-${Date.now()}`) };
  }
  const local = lib('proxy').centralIsLocalPort80(url);
  const key = local ? lib('hosting').localHostKey() : String(hostKey || '').trim();
  if (!key) throw new Error(local ? 'Start the web server once so it creates the host key.' : 'Enter the host key first.');
  let body;
  if (action === 'pick') {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose a thumbnail for this game',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { canceled: true };
    const size = fs.statSync(pick.filePaths[0]).size;
    if (size > 4 * 1024 * 1024) throw new Error('That image is larger than 4 MB.');
    body = fs.readFileSync(pick.filePaths[0]);
  } else if (action !== 'remove') {
    throw new Error('Unknown thumbnail action.');
  }
  let response;
  try {
    response = await fetch(`${url}/api/thumbnails/${placeId}`, {
      method: action === 'pick' ? 'POST' : 'DELETE',
      headers: { 'X-Host-Key': key, 'Content-Type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(`Could not reach the web server at ${url}. Is it running?`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `The web server answered HTTP ${response.status}.`);
  for (const cached of [...thumbnailCache.keys()]) if (cached.startsWith(`${url}|${placeId}|`)) thumbnailCache.delete(cached);
  return { ok: true, dataUrl: action === 'pick' ? await gameThumbnail(url, placeId, result.thumbnail) : null };
}

// --- IPC ----------------------------------------------------------------------------

// --- theme packs (Settings > Theme > Import) -------------------------------------------
// Imported themes stay on this PC, in the launcher's app data (themes\<id>.json),
// checked and cleaned by renderer/themepack.js: CSS and pictures only, nothing
// fetched from elsewhere. They are never sent anywhere.
const THEME_LIMIT = 30;
function themesDir() {
  return path.join(app.getPath('userData'), 'themes');
}

function storedThemes() {
  const ThemePack = require('./renderer/themepack.js');
  let files = [];
  try { files = fs.readdirSync(themesDir()).filter((name) => /^[a-z0-9-]{1,48}\.json$/.test(name)); } catch (error) { return []; }
  const themes = [];
  for (const file of files) {
    try {
      const pack = ThemePack.check(fs.readFileSync(path.join(themesDir(), file), 'utf8'));
      pack.added = fs.statSync(path.join(themesDir(), file)).mtimeMs;
      themes.push(pack);
    } catch (error) { /* a file that no longer passes: left out */ }
  }
  return themes.sort((a, b) => a.added - b.added);
}

function registerThemeIpc() {
  ipcMain.handle('themes:list', () => storedThemes());
  ipcMain.handle('themes:import', async () => {
    const ThemePack = require('./renderer/themepack.js');
    const pick = await dialog.showOpenDialog(win, {
      title: 'Import a theme',
      filters: [{ name: 'Theme pack', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { canceled: true };
    const file = pick.filePaths[0];
    if (fs.statSync(file).size > ThemePack.LIMITS.file) throw new Error('That file is too big for a theme (8 MB at most).');
    const pack = ThemePack.check(fs.readFileSync(file, 'utf8'));
    fs.mkdirSync(themesDir(), { recursive: true });
    const target = path.join(themesDir(), `${pack.id}.json`);
    if (!fs.existsSync(target) && storedThemes().length >= THEME_LIMIT) throw new Error(`You have ${THEME_LIMIT} themes. Remove one first.`);
    fs.writeFileSync(target, JSON.stringify(pack));
    logger('launcher')(`Theme imported: ${pack.name} (${pack.id}).`);
    pack.added = Date.now();
    return { theme: pack };
  });
  ipcMain.handle('themes:remove', (event, id) => {
    if (!/^[a-z0-9-]{1,48}$/.test(String(id))) throw new Error('Unknown theme.');
    const target = path.join(themesDir(), `${id}.json`);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return true;
  });
}

function registerIpc() {
  ipcMain.handle('files:download', (event, centralUrl) => downloadGameFiles(centralUrl));
  ipcMain.handle('studio:open', (event, centralUrl) => openStudio(centralUrl));
  ipcMain.handle('games:thumbnail', (event, options) => gameThumbnail(options && options.centralUrl, options && options.placeId, options && options.version));
  // Opens <web server>/manage in the default browser (only that page).
  // Opens the server's /manage page already unlocked: on the server PC with
  // its host key, elsewhere with a token for the signed-in admin account
  // (Webserver/node/lib/admin.js). Not an admin: the server says why.
  ipcMain.handle('open:manage', async (event, centralUrl) => {
    const url = lib('proxy').normalizeCentralUrl(centralUrl);
    if (url === null) throw new Error('Enter the web server address first.');
    let token = await hostKeyManageToken(url);
    const local = /^http:\/\/(127\.0\.0\.1|localhost\.?|\[::1\])(:\d+)?$/i.test(url);
    if (!token && !local) token = await account.manageToken(url);
    await shell.openExternal(`${url}/manage${token ? `#token=${token}` : ''}`);
    return true;
  });
  ipcMain.handle('host:thumbnail', (event, options) => hostThumbnail(options || {}));
  ipcMain.handle('state', async () => {
    const hosting = lib('hosting');
    const joining = lib('joining');
    return {
      root: ROOT,
      version: app.getVersion(),
      web: await webStatus(),
      host: hostSession ? { active: true, gameId: hostSession.gameId, publicAddress: hostSession.publicAddress } : { active: false },
      play: { active: Boolean(playSession) },
      clientConfig: joining.loadConfig(),
      hostConfig: hosting.loadConfig(),
      hasLocalHostKey: Boolean(hosting.localHostKey()),
      hasMusic: musicStamp() !== null,
      musicStamp: musicStamp(),
      ...capabilities(),
      fixedServer: Boolean(fixedServer()),
      needsFiles: !capabilities().canPlay && !capabilities().canHost,
      update: updateStatus,
      filesVersion: (installedFiles() || {}).version || null,
    };
  });

  registerThemeIpc();

  // Tailscale is no longer needed once the server answers on a public
  // address (the VPS relay): offer to remove it, once, on player installs.
  ipcMain.handle('tailscale:offer', async () => {
    const tailscale = require('./tailscale');
    if (!tailscale.installed() || capabilities().canHost) return { offer: false };
    const config = lib('joining').loadConfig() || {};
    if (config.keepTailscale) return { offer: false };
    const url = lib('proxy').normalizeCentralUrl(config.centralUrl || '');
    if (!url || tailscaleAddress(url)) return { offer: false };
    try {
      const response = await fetch(`${url}/api/games`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return { offer: false };
    } catch (error) {
      return { offer: false };
    }
    return { offer: true };
  });
  ipcMain.handle('tailscale:keep', () => {
    const joining = lib('joining');
    joining.saveConfig(Object.assign({}, joining.loadConfig() || {}, { keepTailscale: true }));
    return true;
  });
  ipcMain.handle('tailscale:uninstall', async () => {
    logger('launcher')('Removing Tailscale (the server no longer needs it).');
    const result = await require('./tailscale').uninstall();
    logger('launcher')(result.removed ? 'Tailscale removed.' : `Tailscale is still installed (uninstaller exit code ${result.code}).`);
    return result;
  });

  // The games on the server, each with its servers (lib/launcherapi.js).
  // Servers from before servers on demand only list running games: each
  // becomes a game with that one server.
  ipcMain.handle('play:games', async (event, centralUrl) => {
    const proxy = lib('proxy');
    const url = proxy.normalizeCentralUrl(centralUrl);
    if (url === null) throw new Error('That web server address does not look right (use http://host or host:port).');
    try {
      const response = await fetch(`${url}/api/launcher/games`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.games)) return data.games;
      }
    } catch (error) { /* the older list below says why the server is unreachable */ }
    const byPlace = new Map();
    for (const game of await lib('joining').fetchGames(url)) {
      const key = String(game.placeId);
      const entry = byPlace.get(key) || {
        placeId: key, name: game.name, description: game.description || '', creator: game.creator || '', thumbnail: game.thumbnail || null,
        maxPlayers: null, canStart: false, starting: false, playing: 0, servers: [], legacy: true,
      };
      const playing = Number.isFinite(game.playing) ? game.playing : 0;
      entry.playing += playing;
      entry.servers.push({ id: game.id, players: [], playing, maxPlayers: null, upSeconds: game.upSeconds, address: game.address });
      byPlace.set(key, entry);
    }
    return [...byPlace.values()];
  });

  // Joins as the signed-in account, or as a guest ("Guest 1234"): the server
  // picks a server with room (or starts one, while this waits) and hands out
  // a join ticket that decides who the player is.
  // request: { placeId } | { gameId } | { privateId } (lib/joining.js).
  let joinCancelled = false;
  async function joinFromLauncher({ request, game, guest, embed }, log) {
    if (playSession) throw new Error('The client is already running. Close it first.');
    const joining = lib('joining');
    const url = account.serverUrl();
    joinCancelled = false;
    await updateFilesBeforePlay(url, log);
    // The game's Roblox version, when the games list said (else the ticket says).
    const listed = game && game.engine ? String(game.engine) : null;
    await engineFilesBeforePlay(url, listed, log);
    if (playSession) throw new Error('The client is already running. Close it first.');
    // The ticket comes after any update, so a long download cannot outlast it.
    const askTicket = () => account.joinTicket(url, Object.assign({}, request || { gameId: game && game.id }, { engines: playableEngines(), anyYear: true }), Boolean(guest), {
      onWait: (text) => send('play-progress', { text }),
      cancelled: () => joinCancelled,
    });
    let ticket = await askTicket();
    if (joinCancelled) throw new Error('Cancelled.');
    const engine = ticket.game && ticket.game.engine ? String(ticket.game.engine) : null;
    if (engine && engine !== listed && await engineFilesBeforePlay(url, engine, log)) {
      if (joinCancelled) throw new Error('Cancelled.');
      ticket = await askTicket();
    }
    if (joinCancelled) throw new Error('Cancelled.');
    // Older servers name no server: then it is the one asked for.
    const target = ticket.game || { id: request && request.gameId, name: game && game.name, placeId: game && game.placeId, address: request && request.address };
    if (!target.address) throw new Error('The server did not say where the game runs. Update its server files.');
    playSession = await joining.joinGame({ centralUrl: url, ticket: ticket.ticket, name: ticket.name, game: target, log });
    playSession.placeId = target.placeId ? String(target.placeId) : null;
    send('status-changed');
    sendPresence();
    if (embed) embedClient(playSession);
    // joinGame logs how the client closed; a client that closed soon after
    // starting (or could not start) is shown on the loading screen.
    playSession.exited.then(
      (outcome) => { if (outcome && outcome.problem) send('play-failed', { text: outcome.problem, game }); },
      (error) => send('play-failed', { text: error.message, game }),
    ).finally(() => {
      playSession = null;
      gameClosed();
      send('status-changed');
      sendPresence();
    });
    return { name: ticket.name, guest: Boolean(ticket.guest) };
  }
  ipcMain.handle('play:join', async (event, options) => {
    const log = logger('play');
    try {
      return await joinFromLauncher(options || {}, log);
    } catch (error) {
      if (!/^Cancelled\.?$/.test(error.message)) log(`Could not join: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('play:stop', async () => {
    joinCancelled = true; // still waiting for a server: give up
    if (playSession) playSession.stop();
    return true;
  });

  // Game assets kept on this PC by the local proxy (lib/proxycache.js).
  ipcMain.handle('assets:cache', () => {
    const proxy = lib('proxy');
    return Object.assign(lib('proxycache').usage(proxy.assetCacheRoot()), { limitBytes: proxy.assetCacheLimit() });
  });
  ipcMain.handle('assets:clear', () => {
    if (playSession || lib('proxy').proxyActive()) throw new Error('Close the game and Studio first.');
    lib('proxycache').clear(lib('proxy').assetCacheRoot());
    return true;
  });

  // Private servers (the game's details).
  ipcMain.handle('private:list', (event, placeId) => account.privateServers(account.serverUrl(), placeId));
  ipcMain.handle('private:create', (event, options) => account.createPrivateServer(account.serverUrl(), options || {}));
  ipcMain.handle('private:redeem', (event, code) => account.redeemPrivateCode(account.serverUrl(), code));
  ipcMain.handle('private:action', (event, options) => account.privateServerAction(account.serverUrl(), options || {}));

  ipcMain.handle('host:start', async (event, config) => {
    if (hostSession) throw new Error('Already hosting.');
    const hosting = lib('hosting');
    const core = lib('core');
    const saved = Object.assign(hosting.loadConfig(), config);
    hosting.saveConfig(saved);
    // Shown in the window and kept in host.log, like hostGame.bat.
    const show = logger('host');
    const log = (line) => {
      show(line);
      core.appendLog(path.join(ROOT, 'Webserver', 'node', 'logs', 'host.log'), `${core.gmdate()}  ${line}`, 1048576);
    };
    hostSession = await hosting.startHosting(saved, { log });
    log('Hosting. Players can join from the Play tab or playGame.bat.');
    send('status-changed');
    hostSession.stopped.then(() => {
      hostSession = null;
      send('status-changed');
    });
    return { gameId: hostSession.gameId, publicAddress: hostSession.publicAddress };
  });

  ipcMain.handle('host:stop', async () => {
    if (hostSession) await hostSession.stop('stopping...');
    return true;
  });

  ipcMain.handle('host:players', async () => (hostSession ? hostSession.players() : null));

  ipcMain.handle('web:start', () => webStart());
  ipcMain.handle('web:stop', () => webStop());
  ipcMain.handle('setup:checks', () => checks());
  ipcMain.handle('setup:run', (event, action) => runSetupAction(action));
  ipcMain.handle('open:folder', (event, which) => {
    const folders = { root: ROOT, config: path.join(ROOT, 'config'), logs: path.join(ROOT, 'Webserver', 'node', 'logs') };
    if (folders[which]) shell.openPath(folders[which]);
    return true;
  });
  // Shows launcher.log selected in Explorer, so it can be sent as it is.
  ipcMain.handle('open:launcher-log', () => {
    const file = launcherLogFile();
    if (!fs.existsSync(file)) writeLogFile('launcher', 'Log opened (nothing logged yet).');
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle('storage:scan', () => cleaner().scan());
  ipcMain.handle('storage:clean', (event, kind) => cleanStorage(String(kind)));
  ipcMain.handle('clipboard:write', (event, text) => { clipboard.writeText(String(text)); return true; });
  // A share link waiting for the window (deliverLink), taken once.
  ipcMain.handle('link:take', () => { const link = pendingLink; pendingLink = null; return link; });
  ipcMain.handle('game:page', (event, placeId) => account.gamePage(account.serverUrl(), placeId));
  ipcMain.handle('game:vote', (event, placeId, vote) => account.vote(account.serverUrl(), placeId, vote));
  ipcMain.handle('robux:get', () => account.robux(account.serverUrl()));

  // Accounts, avatars and the catalog (account.js; all on the server in the
  // launcher's settings).
  ipcMain.handle('update:check', () => {
    if (!checkForUpdatesNow) throw new Error('This copy does not update itself (it was not installed with Setup.exe).');
    checkForUpdatesNow();
    return updateStatus;
  });
  ipcMain.handle('server:set', (event, centralUrl) => {
    if (fixedServer()) return fixedServer();
    const url = lib('proxy').normalizeCentralUrl(centralUrl);
    if (url === null) throw new Error('That server address does not look right (use http://host or host:port).');
    const joining = lib('joining');
    joining.saveConfig(Object.assign({}, joining.loadConfig() || {}, { centralUrl: url }));
    syncMenuMusic(url);
    return url;
  });
  ipcMain.handle('auth:current', () => account.current());
  ipcMain.handle('auth:signin', async (event, options) => {
    const result = await account.signIn(options || {});
    syncMenuMusic();
    sendPresence();
    friendSnapshot = null;
    checkFriendNews();
    return result;
  });
  ipcMain.handle('auth:signout', async () => {
    await sendPresence({ state: 'offline' });
    friendSnapshot = null;
    return account.signOut();
  });
  ipcMain.handle('avatar:get', () => account.avatar());
  ipcMain.handle('avatar:save', (event, body) => account.saveAvatar(undefined, body));
  ipcMain.handle('avatar:copy', () => account.copyAvatar());
  ipcMain.handle('avatar:guest', () => account.guestAvatar());
  ipcMain.handle('avatar:upload', (event, { bytes, guest }) => {
    const buffer = Buffer.from(bytes);
    if (buffer.length > 2 * 1024 * 1024) throw new Error('picture too big');
    return account.uploadAvatarImage(undefined, buffer, Boolean(guest));
  });
  ipcMain.handle('catalog:search', (event, options) => account.catalog(undefined, options || {}));
  ipcMain.handle('catalog:bundle', (event, id) => account.bundle(undefined, id));
  ipcMain.handle('catalog:item', (event, id) => account.item(undefined, id));
  ipcMain.handle('catalog:buy', (event, options) => account.buy(undefined, options || {}));
  ipcMain.handle('catalog:inventory', (event, options) => account.inventory(undefined, options || {}));
  ipcMain.handle('auth:password', (event, options) => account.changePassword(undefined, options || {}));
  ipcMain.handle('players:list', () => account.players());
  ipcMain.handle('server:moved-check', () => checkMovedServer());
  ipcMain.handle('announcements:list', () => listAnnouncements());
  ipcMain.handle('friends:list', () => account.friends());
  ipcMain.handle('friends:action', (event, { verb, body }) => account.friendAction(undefined, verb, body || {}));
  ipcMain.handle('people:search', (event, search) => account.people(undefined, search));
  ipcMain.handle('people:profile', (event, userId) => account.profile(undefined, userId));
  ipcMain.handle('profile:bio', (event, bio) => account.saveBio(undefined, bio));
  ipcMain.handle('follows:list', () => account.following());
  ipcMain.handle('follows:set', async (event, { userId, on }) => account.follow(undefined, userId, Boolean(on)));
  ipcMain.handle('talk:call', (event, { method, route, body }) => account.talk(undefined, method, route, body));
  ipcMain.handle('groups:call', (event, { method, route, body }) => account.groups(undefined, method, route, body));
  ipcMain.handle('groups:emblem', (event, { groupId, bytes }) => account.groupEmblem(undefined, groupId, bytes));
  ipcMain.handle('economy:call', (event, { method, route, body }) => account.economy(undefined, method, route, body));
  ipcMain.handle('players:report', (event, body) => account.report(undefined, body || {}));
  ipcMain.handle('players:block', (event, { userId, on }) => account.block(undefined, userId, Boolean(on)));
  // A game's page opened: the server starts one for it if none runs (older servers: 404, ignored).
  ipcMain.handle('play:warm', (event, placeId) => account.warm(undefined, placeId).catch(() => null));
  // The update log (changelog.json, newest first), for Settings > About and "What's new".
  ipcMain.handle('app:changelog', () => {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  });
  ipcMain.handle('outfits:list', () => account.outfits());
  ipcMain.handle('outfits:save', (event, body) => account.saveOutfit(undefined, body || {}));
  ipcMain.handle('outfits:action', (event, { id, verb, body }) => account.outfitAction(undefined, id, verb, body));

  // Place converter (Webserver/node/convert-place.js): pick a newer .rbxlx,
  // write <name>.2017.rbxlx beside it, and optionally host it.
  const converted = new Set();
  const converter = () => require(path.join(ROOT, 'Webserver', 'node', 'convert-place.js'));
  ipcMain.handle('place:convert', async (event, options) => {
    const robloxPlaceId = options && /^\d{1,15}$/.test(String(options.robloxPlaceId || '')) ? String(options.robloxPlaceId) : null;
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose a place file to convert',
      filters: [{ name: 'Roblox XML place or model', extensions: ['rbxlx', 'rbxmx'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { canceled: true };
    const input = pick.filePaths[0];
    try {
      const result = await converter().convertFile(input, { fromPlace: robloxPlaceId });
      converted.add(result.out);
      return { ok: true, input, output: result.out, universeId: result.universeId, summary: result.summary };
    } catch (error) {
      return { ok: false, input, error: error.message || String(error) };
    }
  });
  ipcMain.handle('place:install', async (event, file) => {
    if (!converted.has(file)) return { ok: false, error: 'Convert the place first.' };
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Host this place', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Make this the hosted place?',
      detail: `${path.basename(file)} replaces Server\\content\\place.rbxlx. The current place is kept as a .bak file next to it. Restart hosting to load the new place.`,
    });
    if (answer.response !== 0) return { ok: false, canceled: true };
    try {
      const installed = converter().install(file);
      return { ok: true, backup: installed.backup ? path.basename(installed.backup) : null };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
}

// --- window -------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#121820',
    title: 'RobloxClient Launcher',
    // Packaged builds take the icon from the .exe; running from source uses this.
    ...(fs.existsSync(path.join(__dirname, 'build', 'icon.ico')) ? { icon: path.join(__dirname, 'build', 'icon.ico') } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  for (const name of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    win.on(name, () => relayoutGame());
  }
  // Back from another window (Alt+Tab, the taskbar, a click): Windows makes the
  // launcher's window the active one and gives it the keyboard and mouse, so
  // the game (which reads them as raw input) got none. Make it active again
  // (also after the window is dragged or resized by its frame).
  for (const name of ['focus', 'restore', 'show', 'moved', 'resized']) {
    win.on(name, () => {
      if (embedState !== 'embedded' || !embedModule) return;
      setTimeout(() => { if (embedState === 'embedded' && embedModule.attached()) embedModule.focus().catch(() => {}); }, 30);
    });
  }
  let leaveGameConfirmed = false;
  win.on('close', async (event) => {
    // Studio reaches the server through the launcher's proxy too; it stays
    // open, but cannot publish until the launcher is back (studiowatch.js).
    if (!playSession && !quitWithStudioConfirmed && studioWatchModule && studioWatchModule.held()) {
      event.preventDefault();
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Quit anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Studio is still open.',
        detail: 'It reaches the server through the launcher, so it can\'t publish until you open the launcher again.',
      });
      if (answer.response !== 0) return;
      quitWithStudioConfirmed = true;
      if (!win.isDestroyed()) win.close();
      return;
    }
    // The game reaches the server through the launcher (its local proxy and
    // game relay), and Windows ends it with the launcher: ask, then leave the
    // game properly (a game inside the window goes with it).
    if (playSession && !leaveGameConfirmed) {
      event.preventDefault();
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Leave the game and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Quitting the launcher ends your game.',
        detail: studioWatchModule && studioWatchModule.held()
          ? 'The game and Studio reach your server through the launcher.'
          : 'The game reaches your server through the launcher.',
      });
      if (answer.response !== 0) return;
      leaveGameConfirmed = true;
      quitWithStudioConfirmed = true;
      const session = playSession;
      if (session) {
        session.stop();
        await Promise.race([session.exited.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
      if (!win.isDestroyed()) win.close();
      return;
    }
    if (!hostSession && !(webChild && webChild.exitCode === null)) return;
    event.preventDefault();
    const what = [hostSession ? 'the game you are hosting' : null, webChild && webChild.exitCode === null ? 'the web server' : null].filter(Boolean).join(' and ');
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Stop and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Quitting stops ${what}.`,
      detail: 'Players in the game will be disconnected.',
    });
    if (answer.response !== 0) return;
    if (hostSession) await hostSession.stop('launcher closed');
    if (webChild && webChild.exitCode === null) webChild.kill();
    win.destroy();
  });
}

// --- share links ------------------------------------------------------------------
// rbx2017://play/<placeId>?host=<server>&server=<job ID>, from a game's share
// page (the server's /play/<placeId>): the window joins that game, or that
// server of it. A link arrives as an argument, at start or in a second start.
const LINK_SCHEME = 'rbx2017';
let pendingLink = null;

function parseLink(text) {
  try {
    const url = new URL(String(text));
    if (url.protocol !== `${LINK_SCHEME}:` || url.hostname !== 'play') return null;
    const placeId = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!/^\d{1,15}$/.test(placeId)) return null;
    const server = url.searchParams.get('server') || '';
    const host = url.searchParams.get('host') || '';
    return {
      placeId,
      server: /^[0-9a-f]{8,64}$/i.test(server) ? server.toLowerCase() : '',
      host: /^[A-Za-z0-9.:[\]-]{1,255}$/.test(host) ? host.toLowerCase() : '',
    };
  } catch (error) {
    return null;
  }
}

function linkIn(argv) {
  const arg = (argv || []).find((item) => String(item).toLowerCase().startsWith(`${LINK_SCHEME}://`));
  return arg ? parseLink(arg) : null;
}

// Installed (packaged) launchers only: one run from source would otherwise
// take the links from the installed one.
function registerLinkScheme() {
  if (!app.isPackaged) return;
  if (!app.setAsDefaultProtocolClient(LINK_SCHEME)) logger('launcher')('Could not register rbx2017:// links (share links will not open the launcher).');
}

// The window takes the link when it is ready for it (link:take), or at once
// when it already runs.
function deliverLink(link) {
  if (!link) return;
  pendingLink = link;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) send('open-link', link);
}

// One launcher at a time (two could both try to host); a second start
// brings the open window forward instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingLink = linkIn(process.argv);
  app.on('second-instance', (event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    deliverLink(linkIn(argv));
  });
}

// Windows shows notifications under the installed app's ID (package.json build.appId).
if (process.platform === 'win32') app.setAppUserModelId('com.rbx2017.launcher');

app.whenReady().then(() => {
  if (ROOT === null) {
    dialog.showErrorBox('RobloxClient Launcher', 'Put the launcher inside the RobloxClient folder (next to Client, Server and Webserver).');
    app.quit();
    return;
  }
  protocol.handle('launcher-net', (request) => account.handleNet(request));
  protocol.handle('launcher-media', (request) => {
    const music = path.join(ROOT, 'config', 'menu-music.mp3');
    if (new URL(request.url).hostname !== 'menu-music' || !fs.existsSync(music)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(fs.readFileSync(music), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  applyFixedServer();
  registerLinkScheme();
  registerIpc();
  createWindow();
  startPresence();
  startStudioWatch();
  const files = installedFiles();
  logger('launcher')(`Launcher ${app.getVersion()} started (${app.isPackaged ? 'installed' : 'from source'}, Windows ${os.release()}, folder ${ROOT}, `
    + `game files ${files ? files.version : capabilities().canPlay ? 'local' : 'none'}, server ${(lib('joining').loadConfig() || {}).centralUrl || 'not set'}).`);
  // Before the first update check (8 s), which may download into the
  // updater's folder.
  tidyAtStart();
  setupUpdates();
  setTimeout(() => syncMenuMusic(), 3000);
  setTimeout(checkMovedServer, 4000);
  setInterval(checkMovedServer, 10 * 60 * 1000);
});

app.on('window-all-closed', () => app.quit());

// --- launcher updates -------------------------------------------------------------
// Installed launchers update themselves from the newest GitHub release
// (electron-updater reads latest.yml there; tools/publish-release.js uploads
// it). The update downloads in the background and installs when the launcher
// closes, or at once with the "Restart to update" button. Builds without
// app-update.yml (running from source, the server package's launcher) skip this.
let updateStatus = { state: 'off' };
// Set by setupUpdates when this copy updates itself; Settings > About calls it.
let checkForUpdatesNow = null;

function setUpdateStatus(status) {
  updateStatus = status;
  send('update-status', status);
}

function setupUpdates() {
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let version = null;
  autoUpdater.on('checking-for-update', () => {
    if (!['downloading', 'ready'].includes(updateStatus.state)) setUpdateStatus({ state: 'checking', version: app.getVersion() });
  });
  autoUpdater.on('update-available', (info) => { version = info.version; setUpdateStatus({ state: 'downloading', version, percent: 0 }); });
  autoUpdater.on('update-not-available', () => setUpdateStatus({ state: 'current', version: app.getVersion() }));
  autoUpdater.on('download-progress', (progress) => setUpdateStatus({ state: 'downloading', version, percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (error) => setUpdateStatus({ state: 'error', message: String(error && error.message || error).slice(0, 200) }));
  ipcMain.handle('update:install', () => {
    if (playSession) throw new Error('Close the game first.');
    if (hostSession) throw new Error('Stop hosting first.');
    if (updateStatus.state !== 'ready') throw new Error('No update is ready yet.');
    // Studio stays open; the restarted launcher picks it up again (studiowatch.js).
    quitWithStudioConfirmed = true;
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });
  // At start, every 30 minutes, and from Settings > About. Not while an
  // update is already downloading or waiting for a restart.
  checkForUpdatesNow = () => {
    if (['checking', 'downloading', 'ready'].includes(updateStatus.state)) return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(checkForUpdatesNow, 8000);
  setInterval(checkForUpdatesNow, 30 * 60 * 1000);
}
