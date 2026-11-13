'use strict';

// RobloxClient Launcher: one window for playing, hosting and running the web
// server. The work is done by the same modules as playGame.bat, hostGame.bat
// and startWeb.bat (RobloxClient/Webserver/node/lib), so the console scripts
// and the launcher behave the same. Node scripts run on Electron's own Node,
// so players do not need Node.js installed.

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol } = require('electron');
const { spawn, spawnSync } = require('child_process');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');

// Menu music is the player's own file (config/menu-music.mp3), served to the
// window as launcher-media://menu-music; it is not part of the app.
protocol.registerSchemesAsPrivileged([
  { scheme: 'launcher-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// The RobloxClient folder: the first folder above this app that has the client.
function findRoot() {
  let dir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  for (let i = 0; i < 8; i++) {
    // A server-only folder (no Client) works too: it can run the web server
    // and host, just not play.
    const hasGame = fs.existsSync(path.join(dir, 'Client', 'RobloxPlayerBeta.exe')) || fs.existsSync(path.join(dir, 'Server', 'RCCService.exe'));
    if (hasGame && fs.existsSync(path.join(dir, 'Webserver', 'node'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const ROOT = findRoot();
const lib = (name) => require(path.join(ROOT, 'Webserver', 'node', 'lib', name));

let win = null;
let hostSession = null;
let playSession = null;
let webChild = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function logger(area) {
  return (line) => send('log', { area, line: String(line), time: new Date().toLocaleTimeString() });
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
  return spawn(process.execPath, [path.join(ROOT, relative), ...args], Object.assign({
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
function capabilities() {
  return {
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

// --- setup checks -----------------------------------------------------------------

async function checks() {
  const core = lib('core');
  const result = [];
  const add = (id, label, ok, detail, action) => result.push({ id, label, ok, detail, action: action || null });
  const { canPlay, canHost } = capabilities();

  if (!canHost) {
    // Player install: the game files and Tailscale are all it needs.
    const installed = installedFiles();
    add('files', 'Game files', canPlay,
      canPlay ? `Installed in: ${ROOT}${installed ? ` (version ${installed.version})` : ''}` : 'Not downloaded yet: they come from your server.',
      canPlay ? null : 'download-files');
    if (canPlay) {
      const update = await filesUpdate((lib('joining').loadConfig() || {}).centralUrl);
      if (update) add('files-update', 'Game files update', false, `Version ${update.available} is on the server (you have ${update.installed}, ${Math.round(update.size / 1e6)} MB).`, 'download-files');
    }
    const tailscaleIp = core.tailscaleIPv4();
    const tailscaleInstalled = fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe');
    add('tailscale', 'Tailscale connected', Boolean(tailscaleIp),
      tailscaleIp ? `This PC's Tailscale address: ${tailscaleIp}` : (tailscaleInstalled ? 'Tailscale is installed but not connected: sign in from its tray icon.' : 'Install Tailscale and sign in to reach your friends\' server.'),
      tailscaleIp ? null : 'tailscale-download');
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

// The home screen shows the avatar of the Roblox account with the player's
// username (the same account the web server dresses them in). Returned as a
// data: URL so the window needs no outside image hosts; null if not found.
const avatarCache = new Map();
async function avatarImage(username) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(String(username || ''))) return null;
  const key = username.toLowerCase();
  if (avatarCache.has(key)) return avatarCache.get(key);
  try {
    const users = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(8000),
    });
    const id = users.ok ? ((await users.json()).data || [])[0]?.id : null;
    if (!id) { avatarCache.set(key, null); return null; }
    let imageUrl = null;
    for (let attempt = 0; attempt < 3 && !imageUrl; attempt++) {
      const thumbs = await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${id}&size=420x420&format=Png&isCircular=false`, { signal: AbortSignal.timeout(8000) });
      const entry = thumbs.ok ? ((await thumbs.json()).data || [])[0] : null;
      if (entry && entry.state === 'Completed') imageUrl = entry.imageUrl;
      else await new Promise((resolve) => setTimeout(resolve, 1500)); // still rendering
    }
    if (!imageUrl) return null;
    const image = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!image.ok) return null;
    const dataUrl = `data:image/png;base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
    avatarCache.set(key, dataUrl);
    return dataUrl;
  } catch (error) {
    return null; // offline: the home screen shows a silhouette
  }
}

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

function registerIpc() {
  ipcMain.handle('files:download', (event, centralUrl) => downloadGameFiles(centralUrl));
  ipcMain.handle('games:thumbnail', (event, options) => gameThumbnail(options && options.centralUrl, options && options.placeId, options && options.version));
  // Opens <web server>/manage in the default browser (only that page).
  ipcMain.handle('open:manage', async (event, centralUrl) => {
    const url = lib('proxy').normalizeCentralUrl(centralUrl);
    if (url === null) throw new Error('Enter the web server address first.');
    await shell.openExternal(`${url}/manage`);
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
      hasMusic: fs.existsSync(path.join(ROOT, 'config', 'menu-music.mp3')),
      ...capabilities(),
      needsFiles: !capabilities().canPlay && !capabilities().canHost,
      filesVersion: (installedFiles() || {}).version || null,
    };
  });

  ipcMain.handle('play:games', async (event, centralUrl) => {
    const proxy = lib('proxy');
    const url = proxy.normalizeCentralUrl(centralUrl);
    if (url === null) throw new Error('That web server address does not look right (use http://host or host:port).');
    return lib('joining').fetchGames(url);
  });

  ipcMain.handle('play:join', async (event, { centralUrl, username, game }) => {
    if (playSession) throw new Error('The client is already running. Close it first.');
    const joining = lib('joining');
    const url = lib('proxy').normalizeCentralUrl(centralUrl);
    if (url === null) throw new Error('That web server address does not look right.');
    if (!joining.validUsername(username)) throw new Error('The username needs 3-20 letters, digits or _.');
    joining.saveConfig({ centralUrl: url, username });
    const log = logger('play');
    playSession = await joining.joinGame({ centralUrl: url, username, game, log });
    send('status-changed');
    playSession.exited.then(() => log('The client closed.'), (error) => log(`Error: ${error.message}`)).finally(() => {
      playSession = null;
      send('status-changed');
    });
    return true;
  });

  ipcMain.handle('play:stop', async () => {
    if (playSession) playSession.stop();
    return true;
  });

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
  ipcMain.handle('clipboard:write', (event, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('avatar:image', (event, username) => avatarImage(username));

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
  win.on('close', async (event) => {
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

// One launcher at a time (two could both try to host); a second start
// brings the open window forward instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

app.whenReady().then(() => {
  if (ROOT === null) {
    dialog.showErrorBox('RobloxClient Launcher', 'Put the launcher inside the RobloxClient folder (next to Client, Server and Webserver).');
    app.quit();
    return;
  }
  protocol.handle('launcher-media', (request) => {
    const music = path.join(ROOT, 'config', 'menu-music.mp3');
    if (new URL(request.url).hostname !== 'menu-music' || !fs.existsSync(music)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(fs.readFileSync(music), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
