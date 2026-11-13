'use strict';

// Always-on server: runs the web server and the game servers of the games
// that are "online" in the place library (Webserver/node/data/places.json,
// managed at http://<this PC>/manage), and keeps them running.
//   - Servers start on demand: when a player joins a game whose servers are
//     all full (or that has none), the web server asks for a new one
//     ("start" in data/control.json). A server nobody has played on for
//     idleStopMinutes stops again. A game with "keep running" always has one.
//   - Each server has its own job ID; private servers (lib/privateservers.js)
//     are servers of their own, started the same way.
//   - Turning a game off on the management page stops its servers (players
//     are saved first); uploading a new version restarts them.
//   - A game whose RCC stops by itself is started again; one that stops
//     answering for a few minutes is restarted.
//   - A game using more than memoryLimitMB restarts when nobody is playing
//     (past 115% of the limit, after saving the players).
//   - Every game restarts once a day at restartDaily, players saved first.
//   - The web server is started again if it stops.
//   - Server updates (lib/updates.js): it looks for a newer one on GitHub every
//     few hours and installs waiting ones when nobody is playing, or when
//     asked on the management page (apply-update.js swaps the files).
// Server-wide settings: config/dedicated.json (all optional). Each server gets
// a UDP port from gamePortFirst (53640) onwards, one per running server, up to
// gamePortCount (tailscaleFirewall.bat opens that range); maxGames servers at
// most run at once.
// startServer.bat runs this; autostartServer.bat starts it at sign-in.
// Type "status", "restart", "restart <place ID>" or "stop" in its window.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const accounts = require('./lib/accounts');
const core = require('./lib/core');
const hosting = require('./lib/hosting');
const places = require('./lib/places');
const privateservers = require('./lib/privateservers');
const updates = require('./lib/updates');

const CONFIG_FILE = core.rootPath('config', 'dedicated.json');
const LOG_FILE = path.join(__dirname, 'logs', 'dedicated.log');
const SERVER_PID = path.join(__dirname, 'server.pid');
const GRACE_MS = 3 * 60 * 1000; // no health checks while a game starts up

const DEFAULTS = {
  webServer: true,
  centralUrl: 'http://127.0.0.1',
  hostKey: '',
  restartDaily: '05:00',
  healthCheckSeconds: 60,
  failedChecksBeforeRestart: 3,
  memoryLimitMB: 3000,
  saveWaitSeconds: 10,
  maxGames: 4,
  idleStopMinutes: 5,
  gamePortFirst: 53640,
  gamePortCount: 20,
  autoUpdate: true,
  updateCheckHours: 3,
};

const MESSAGES = {
  daily: 'Daily server restart. Your progress was saved - rejoin in a minute.',
  memory: 'The server is restarting to free memory. Your progress was saved - rejoin in a minute.',
  manual: 'The server is restarting. Your progress was saved - rejoin in a minute.',
  updated: 'This game was updated. Your progress was saved - rejoin in a minute.',
  off: 'This game was turned off. Your progress was saved.',
  shutdown: 'The server is shutting down. Your progress was saved.',
  update: 'The server is updating. Your progress was saved - rejoin in a minute.',
  stopped: 'An admin closed this server. Your progress was saved.',
  privateGone: 'This private server was deleted. Your progress was saved.',
};

// --- logging and small helpers ---------------------------------------------------

function localTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(scope, line) {
  const text = `${localTime()}  [${scope}] ${line}`;
  console.log(text);
  try { core.appendLog(LOG_FILE, text, 2 * 1048576); } catch (error) { /* logs folder busy */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

// --- config --------------------------------------------------------------------------

function loadConfig() {
  const raw = core.isFile(CONFIG_FILE) ? core.readJsonFile(CONFIG_FILE) : {};
  if (raw === null) throw new Error('config\\dedicated.json is not valid JSON (see config\\README.txt).');
  const config = Object.assign({}, DEFAULTS, raw);
  if (config.restartDaily && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(config.restartDaily))) {
    throw new Error('restartDaily must look like "05:00" (24-hour clock), or "" for no daily restart.');
  }
  config.maxGames = Math.max(1, Number(config.maxGames) || DEFAULTS.maxGames);
  config.gamePortFirst = Number(config.gamePortFirst) || DEFAULTS.gamePortFirst;
  config.gamePortCount = Math.max(1, Number(config.gamePortCount) || DEFAULTS.gamePortCount);
  config.idleStopMinutes = Math.max(0, Number(config.idleStopMinutes === undefined ? DEFAULTS.idleStopMinutes : config.idleStopMinutes) || 0);
  if (!config.webServer && config.maxGames > 1) config.maxGames = 1; // a remote web server: one game per PC
  config.centralUrl = config.webServer ? 'http://127.0.0.1' : config.centralUrl;
  return config;
}

// --- web server ------------------------------------------------------------------------

class WebServer {
  constructor() {
    this.child = null;
    this.stopping = false;
  }

  async start() {
    // A web server left by an earlier run (or the launcher) is replaced.
    const old = Number((core.readText(SERVER_PID) || '').trim());
    if (old && hosting.processAlive(old)) {
      log('web', `stopping the web server already running (PID ${old})`);
      killTree(old);
      for (let i = 0; i < 20 && await canConnect(80, '127.0.0.1', 300); i++) await sleep(250);
    }
    if (await canConnect(80, '127.0.0.1', 500)) {
      throw new Error('port 80 is in use by another program (UwAmp/Apache or IIS?); stop it first');
    }
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      env: process.env,
      // Its own process group: Ctrl+C here must not stop it before the games
      // have saved their players.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const relay = (stream) => readline.createInterface({ input: stream }).on('line', (line) => {
      if (line.trim() !== '' && !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+\S+ "/.test(line)) log('web', line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+/, ''));
    });
    relay(child.stdout);
    relay(child.stderr);
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      log('web', `the web server stopped (exit code ${code}); starting it again in 5 seconds`);
      setTimeout(() => this.keepStarting(), 5000);
    });
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch('http://127.0.0.1/api/games', { signal: AbortSignal.timeout(2000) });
        if (response.ok) return;
      } catch (error) { /* not up yet */ }
      await sleep(500);
    }
    throw new Error('the web server did not start answering on port 80');
  }

  async keepStarting() {
    for (let attempt = 1; !this.stopping; attempt++) {
      try {
        await this.start();
        return;
      } catch (error) {
        const delay = Math.min(300, 10 * attempt);
        log('web', `could not start the web server: ${error.message}; trying again in ${delay} seconds`);
        await sleep(delay * 1000);
      }
    }
  }

  stop() {
    this.stopping = true;
    if (this.child) {
      const pid = this.child.pid;
      killTree(pid);
      // server.js removes its PID file only when it shuts itself down.
      try { if ((core.readText(SERVER_PID) || '').trim() === String(pid)) fs.unlinkSync(SERVER_PID); } catch (error) { /* gone */ }
    }
    this.child = null;
  }
}

// --- one game server ---------------------------------------------------------------------

class GameSlot {
  // index: which port pair this server uses while it runs. jobId: its own ID
  // (the game list's game ID); privateId: the private server it runs.
  constructor(placeId, index, config, onChange, { jobId, privateId = null } = {}) {
    this.placeId = placeId;
    this.index = index;
    this.config = config;
    this.onChange = onChange;
    this.jobId = jobId || crypto.randomBytes(8).toString('hex');
    this.privateId = privateId;
    this.scope = `place ${placeId} ${this.tag()}`;
    this.session = null;
    this.retiring = false; // being stopped for good
    this.failures = 0;
    this.idleSince = Date.now();
    this.maxPlayers = null;
    this.state = 'starting';
    this.lastError = null;
    this.startedAt = 0;
    this.startedVersion = null;
    this.badChecks = 0;
    this.checking = false;
    this.restarting = false;
    this.shuttingDown = false;
    this.wake = null;
    this.restarts = 0;
    this.players = null;
    this.memoryMB = null;
  }

  get gamePort() { return this.config.gamePortFirst + this.index; }
  get soapPort() { return hosting.SOAP_PORT + this.index; }

  // "#ab12cd" for a public server, "private #ab12cd" for a private one.
  tag() {
    return `${this.privateId ? 'private ' : ''}#${this.jobId.slice(0, 6)}`;
  }

  setState(state, error) {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.onChange();
  }

  // Read from the library at every start, so renames and new files apply.
  hostConfig() {
    const place = places.load().places[this.placeId];
    if (!place) throw new Error('this place is no longer in the library');
    this.scope = `${place.name} (${this.placeId}) ${this.tag()}`;
    this.startedVersion = place.version || 1;
    this.maxPlayers = places.maxPlayersOf(place);
    return {
      gameName: place.name,
      placeId: this.placeId,
      placeFile: place.file,
      gamePort: this.gamePort,
      soapPort: this.soapPort,
      publicAddress: `tailscale:${this.gamePort}`,
      centralUrl: this.config.centralUrl,
      hostKey: this.config.hostKey,
      jobId: this.jobId,
      privateId: this.privateId,
      maxPlayers: this.maxPlayers,
    };
  }

  // Waits, unless shutdown or a restart request cuts it short.
  pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  async run() {
    while (!this.shuttingDown) {
      try {
        this.setState('starting');
        const config = this.hostConfig();
        this.session = await hosting.startHosting(config, { log: (line) => log(this.scope, line), dedicated: true });
        this.failures = 0;
        this.badChecks = 0;
        this.startedAt = Date.now();
        this.idleSince = Date.now();
        this.setState('running', null);
        log(this.scope, `online; players join at ${this.session.publicAddress}`);
        const result = await this.session.stopped;
        this.session = null;
        this.players = null;
        this.memoryMB = null;
        if (this.shuttingDown) break;
        this.restarts++;
        const delay = result && result.crashed ? 10 : 3;
        this.setState('restarting');
        log(this.scope, `starting the game again in ${delay} seconds`);
        await this.pause(delay * 1000);
      } catch (error) {
        this.session = null;
        if (this.shuttingDown) break;
        this.failures++;
        const delay = Math.min(300, 15 * 2 ** Math.min(this.failures - 1, 5));
        this.setState('error', error.message);
        log(this.scope, `could not start: ${error.message}; trying again in ${delay} seconds`);
        await this.pause(delay * 1000);
      }
    }
    this.setState('stopped');
  }

  async restart(reason, kickMessage) {
    const session = this.session;
    if (!session) {
      if (this.wake) this.wake(); // waiting to retry: try now
      return;
    }
    if (this.restarting) return;
    this.restarting = true;
    this.setState('restarting');
    try {
      await session.stop(reason, kickMessage ? { kickMessage, saveWaitSeconds: this.config.saveWaitSeconds } : {});
    } finally {
      this.restarting = false;
    }
  }

  async check() {
    const session = this.session;
    if (!session || this.checking || this.restarting || Date.now() - this.startedAt < GRACE_MS) return;
    this.checking = true;
    try {
      if (!(await session.ping(20000))) {
        this.badChecks++;
        log(this.scope, `RCC is not answering (${this.badChecks} of ${this.config.failedChecksBeforeRestart} checks)`);
        if (this.badChecks >= this.config.failedChecksBeforeRestart) {
          this.badChecks = 0;
          await this.restart('RCC stopped answering; restarting the game');
        }
        return;
      }
      this.badChecks = 0;
      const limit = Number(this.config.memoryLimitMB) || 0;
      const memory = session.memoryMB();
      if (limit > 0 && memory !== null && memory > limit) {
        const players = await session.players();
        if (players !== null && players.length === 0) {
          await this.restart(`RCC uses ${memory} MB (limit ${limit} MB) and nobody is playing; restarting to free memory`);
        } else if (memory > limit * 1.15) {
          await this.restart(`RCC uses ${memory} MB, well over the ${limit} MB limit; saving players and restarting`, MESSAGES.memory);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  // Players and memory for the status report; tracks how long nobody has
  // played (an RCC too busy to answer counts as played).
  async sample() {
    const session = this.session;
    if (!session || this.state !== 'running') return;
    this.players = await session.players();
    this.memoryMB = session.memoryMB();
    if (this.players === null || this.players.length > 0) this.idleSince = Date.now();
  }

  idleFor() {
    return this.state === 'running' && !this.restarting && Array.isArray(this.players) && this.players.length === 0
      ? Date.now() - this.idleSince : 0;
  }

  report() {
    return {
      placeId: this.placeId,
      jobId: this.jobId,
      privateId: this.privateId,
      maxPlayers: this.maxPlayers,
      idleSince: this.idleFor() > 0 ? new Date(this.idleSince).toISOString() : null,
      state: this.state,
      players: this.players,
      memoryMB: this.memoryMB,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      restarts: this.restarts,
      lastError: this.lastError,
      address: this.session ? this.session.publicAddress : null,
      gamePort: this.gamePort,
    };
  }

  describe() {
    if (!this.session) return `${this.scope}: ${this.state}${this.lastError ? ` (${this.lastError})` : ''}`;
    const players = this.players;
    const who = players === null ? 'RCC busy' : `${players.length} player${players.length === 1 ? '' : 's'}${players.length ? ` (${players.join(', ')})` : ''}`;
    return `${this.scope}: ${who}, ${this.memoryMB === null ? '?' : this.memoryMB} MB, up ${Math.round((Date.now() - this.startedAt) / 60000)} min, port ${this.gamePort}, restarted ${this.restarts} time${this.restarts === 1 ? '' : 's'}`;
  }

  async shutdown(kickMessage) {
    this.shuttingDown = true;
    this.setState('stopping');
    if (this.wake) this.wake();
    if (this.session) await this.session.stop('stopping the game', kickMessage ? { kickMessage, saveWaitSeconds: this.config.saveWaitSeconds } : {});
  }

  killNow() {
    this.shuttingDown = true;
    if (this.session && this.session.pid) killTree(this.session.pid);
  }
}

// --- one Team Create server -------------------------------------------------------------------
// RCC as a cloud edit server for one place, shared by everyone editing it in
// Studio. Started when Studio asks for it (PlaceLauncher.ashx?request=CloudEdit
// becomes a "cloudedit" request), saved and stopped once nobody has been
// editing for CLOUD_IDLE_MS. Its saves go to the web server's
// /ide/publish/UploadFromCloudEdit with a token only this server has.

const CLOUD_IDLE_MS = 3 * 60 * 1000;

class CloudEditSlot {
  constructor(placeId, index, config, onChange) {
    this.placeId = placeId;
    this.index = index;
    this.config = config;
    this.onChange = onChange;
    this.scope = `Team Create ${placeId}`;
    this.session = null;
    this.state = 'starting';
    this.lastError = null;
    this.startedAt = 0;
    this.idleSince = Date.now();
    this.editors = null;
    this.stopping = false;
  }

  get gamePort() { return this.config.gamePortFirst + this.index; }
  get soapPort() { return hosting.SOAP_PORT + this.index; }

  setState(state, error) {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.onChange();
  }

  hostConfig() {
    const place = places.load().places[this.placeId];
    if (!place) throw new Error('this place is no longer in the library');
    this.scope = `Team Create: ${place.name} (${this.placeId})`;
    const token = accounts.editToken(0, this.placeId, 30);
    return {
      gameName: `${place.name} (Team Create)`,
      placeId: this.placeId,
      placeFile: place.file,
      gamePort: this.gamePort,
      soapPort: this.soapPort,
      publicAddress: `tailscale:${this.gamePort}`,
      centralUrl: this.config.centralUrl,
      hostKey: this.config.hostKey,
      cloudEdit: { saveUrl: `http://localhost./ide/publish/UploadFromCloudEdit?placeId=${this.placeId}&t=${encodeURIComponent(token)}` },
    };
  }

  // Resolves when the server has stopped (it is not restarted: Studio asks
  // again when someone opens the place).
  async run() {
    try {
      this.setState('starting');
      this.session = await hosting.startHosting(this.hostConfig(), { log: (line) => log(this.scope, line), dedicated: true });
      this.startedAt = Date.now();
      this.idleSince = Date.now();
      this.setState('running', null);
      log(this.scope, `ready on UDP port ${this.gamePort}`);
      await this.session.stopped;
    } catch (error) {
      this.setState('error', error.message);
      log(this.scope, `could not start: ${error.message}`);
    } finally {
      this.session = null;
      if (this.state !== 'error') this.setState('stopped');
    }
  }

  // Who is editing; tracks how long nobody has been.
  async sample() {
    const session = this.session;
    if (!session || this.state !== 'running') return;
    this.editors = await session.players();
    if (this.editors === null || this.editors.length > 0) this.idleSince = Date.now();
  }

  idleTooLong() {
    return this.state === 'running' && !this.stopping && Array.isArray(this.editors) && this.editors.length === 0
      && Date.now() - this.idleSince > CLOUD_IDLE_MS;
  }

  // Saves the place to the web server, waits for it to arrive, then stops.
  async shutdown(reason) {
    if (this.stopping) return;
    this.stopping = true;
    const session = this.session;
    if (!session) return;
    this.setState('stopping');
    if (!places.load().places[this.placeId]) {
      await session.stop(`${reason}; stopping the Team Create server`);
      return;
    }
    const before = places.load().places[this.placeId].version || 0;
    log(this.scope, `${reason}; saving the place first`);
    if (await session.saveNow(60000)) {
      for (let i = 0; i < 60; i++) {
        if (((places.load().places[this.placeId] || {}).version || 0) !== before) break;
        await sleep(500);
      }
    } else {
      log(this.scope, 'warning: RCC did not save; changes since its last autosave are lost');
    }
    await session.stop('stopping the Team Create server');
  }

  killNow() {
    this.stopping = true;
    if (this.session && this.session.pid) killTree(this.session.pid);
  }

  report() {
    return {
      state: this.state,
      editors: this.editors,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      lastError: this.lastError,
      address: this.session ? this.session.publicAddress : null,
      gamePort: this.gamePort,
    };
  }

  describe() {
    const who = this.editors === null ? 'RCC busy' : `${this.editors.length} editing${this.editors.length ? ` (${this.editors.join(', ')})` : ''}`;
    return `${this.scope}: ${this.state}, ${who}, port ${this.gamePort}`;
  }
}

// --- main ----------------------------------------------------------------------------------

// All servers of one place as one status entry: running if any runs, every
// player, memory added up.
function combined(reports) {
  const states = reports.map((report) => report.state);
  const state = ['running', 'starting', 'restarting', 'error', 'stopping'].find((name) => states.includes(name)) || states[0];
  const known = reports.filter((report) => Array.isArray(report.players));
  const memory = reports.filter((report) => report.memoryMB !== null);
  const started = reports.map((report) => report.startedAt).filter(Boolean).sort();
  const errored = reports.find((report) => report.lastError);
  const first = reports.find((report) => report.address) || reports[0];
  return {
    state,
    players: known.length ? [].concat(...known.map((report) => report.players)) : null,
    memoryMB: memory.length ? memory.reduce((sum, report) => sum + report.memoryMB, 0) : null,
    startedAt: started[0] || null,
    restarts: reports.reduce((sum, report) => sum + (report.restarts || 0), 0),
    lastError: errored ? errored.lastError : null,
    address: first.address,
    gamePort: first.gamePort,
    servers: reports.length,
  };
}

function nextDaily(time) {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date();
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= Date.now() + 1000) next.setDate(next.getDate() + 1);
  return next;
}

async function main() {
  const other = hosting.dedicatedServerPid();
  if (other) throw new Error(`the always-on server is already running (PID ${other}).`);
  const config = loadConfig();
  const library = places.ensure(); // created on the first run (Lumber Tycoon 2 as 1818)
  fs.writeFileSync(hosting.DEDICATED_PID, String(process.pid));
  const online = Object.values(library.places).filter((place) => place.enabled).length;
  log('server', `always-on server starting: ${Object.keys(library.places).length} places in the library, ${online} online`
    + ` (up to ${config.maxGames} at once)${config.restartDaily ? `, daily restart at ${config.restartDaily}` : ''}, memory limit ${config.memoryLimitMB || 'off'} MB`);

  const version = updates.installed();
  log('server', `server version: ${version.publicLabel || 'not recorded'}${version.privateLabel ? `, private files ${version.privateLabel}` : ''}`);
  // The update that started this server (apply-update.js writes its result
  // once this reports in): say how it went.
  const startedAt = Date.now();
  setTimeout(() => {
    const result = updates.lastResult();
    if (result && Date.parse(result.at) >= startedAt) {
      log('update', result.ok ? `installed ${result.updates}` : `update failed: ${result.error}`);
    }
  }, 30 * 1000).unref();

  const web = config.webServer ? new WebServer() : null;
  if (web) {
    await web.keepStarting();
    log('web', 'web server is up on port 80; manage games at http://<this PC>/manage');
  }

  const slots = new Map(); // jobId -> GameSlot (game servers, private ones too)
  const cloud = new Map(); // placeId -> CloudEditSlot (Team Create servers)
  let problems = [];
  let startFailures = []; // start requests that could not start a server: { id, error, at }
  let shuttingDown = false;
  // Updates: what the last GitHub check found (lib/updates.js).
  const updateState = { lastCheck: null, lastError: null, available: null, checking: false };
  const serverRequests = []; // update checks, installs and restarts from /manage
  let updateTimer = null;
  let firstCheck = null;
  let idleTimer = null;
  let serverTimer = null;

  // --- status for the management page ---
  let statusTimer = null;
  // servers: every game server by job ID. games: per place, all its servers
  // together (what readers from before servers on demand expect).
  const writeStatus = () => {
    const servers = {};
    for (const [id, slot] of slots) servers[id] = slot.report();
    const games = {};
    for (const report of Object.values(servers)) (games[report.placeId] = games[report.placeId] || []).push(report);
    for (const [placeId, list] of Object.entries(games)) games[placeId] = combined(list);
    const cloudEdit = {};
    for (const [id, slot] of cloud) cloudEdit[id] = slot.report();
    places.writeRunnerStatus({
      pid: process.pid, maxGames: config.maxGames, idleStopMinutes: config.idleStopMinutes,
      servers, games, cloudEdit, problems, startFailures,
      updates: Object.assign({ autoUpdate: config.autoUpdate !== false }, updateState),
    });
  };
  const statusSoon = () => {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; writeStatus(); }, 300);
  };
  const sampleAll = async () => {
    for (const slot of slots.values()) await slot.sample().catch(() => {});
    for (const slot of cloud.values()) {
      await slot.sample().catch(() => {});
      if (slot.idleTooLong()) slot.shutdown('nobody has been editing for a while').catch(() => {});
    }
    stopIdle();
    writeStatus();
  };

  // A free port pair: games count up from the first, Team Create servers
  // down from the last, so they rarely meet.
  const usedIndexes = () => new Set([...slots.values(), ...cloud.values()].map((slot) => slot.index));

  // --- game servers ---
  const live = () => [...slots.values()].filter((slot) => !slot.retiring);
  // The servers of a place: public ones (privateId null) or a private server's.
  const serversOf = (placeId, privateId = null) => live().filter((slot) => slot.placeId === placeId && slot.privateId === privateId);

  // -> { slot } or { error } (the text players see)
  const startServer = (placeId, privateId, entries, why) => {
    if (live().length >= config.maxGames) {
      return { error: `The server already runs ${config.maxGames} game server${config.maxGames === 1 ? '' : 's'}, as many as it may. Try again in a few minutes.` };
    }
    const used = usedIndexes();
    let index = 0;
    while (used.has(index)) index++;
    if (index >= config.gamePortCount) return { error: 'The server has no free game port for another game server. Try again in a few minutes.' };
    const slot = new GameSlot(placeId, index, config, statusSoon, { privateId });
    slots.set(slot.jobId, slot);
    log(`place ${placeId}`, `starting ${privateId ? 'a private' : 'a'} server ${slot.tag()} of "${entries[placeId].name}" (${why}; game port ${slot.gamePort})`);
    slot.run().catch((error) => log(slot.scope, `stopped: ${error.message}`)).finally(() => {
      if (slots.get(slot.jobId) === slot && slot.shuttingDown) slots.delete(slot.jobId);
      statusSoon();
    });
    statusSoon();
    return { slot };
  };

  // Stops a server for good (kickMessage: save its players first).
  const stopServer = (slot, kickMessage, why) => {
    if (slot.retiring) return;
    slot.retiring = true;
    log(slot.scope, `${why}; stopping this server`);
    slot.shutdown(kickMessage).catch(() => {}).finally(() => {
      if (slots.get(slot.jobId) === slot) slots.delete(slot.jobId);
      statusSoon();
    });
  };

  // Servers nobody has played on for idleStopMinutes stop, except the one a
  // "keep running" game keeps. A server that keeps failing to start stops
  // too, unless it is that one.
  const stopIdle = () => {
    const entries = places.load().places;
    const idleMs = config.idleStopMinutes * 60 * 1000;
    for (const slot of live()) {
      const place = entries[slot.placeId];
      const kept = place && place.enabled && place.keepRunning !== false && !slot.privateId
        && serversOf(slot.placeId).filter((other) => other !== slot).length === 0;
      if (kept) continue;
      if (idleMs > 0 && slot.idleFor() > idleMs) stopServer(slot, null, `nobody has played for ${config.idleStopMinutes} minutes`);
      else if (slot.state === 'error' && slot.failures >= 3) stopServer(slot, null, `it failed to start ${slot.failures} times`);
    }
  };
  const startCloudEdit = (id, entries) => {
    const used = usedIndexes();
    let index = config.gamePortCount - 1;
    while (index >= 0 && used.has(index)) index--;
    if (index < 0) {
      log(`place ${id}`, 'no free game port for a Team Create server (gamePortCount in config\\dedicated.json)');
      return;
    }
    const slot = new CloudEditSlot(id, index, config, statusSoon);
    cloud.set(id, slot);
    log(`place ${id}`, `starting a Team Create server for "${entries[id].name}" (UDP port ${slot.gamePort})`);
    slot.run().finally(() => {
      if (cloud.get(id) === slot) cloud.delete(id);
      statusSoon();
    });
  };

  // --- keep the servers in line with the library ---
  const handled = new Set(places.readRequests().map((request) => request.id)); // older requests are done
  const failStart = (request, error) => {
    startFailures = startFailures.concat({ id: request.id, error, at: new Date().toISOString() }).slice(-20);
    log(`place ${request.placeId}`, `could not start a server: ${error}`);
    statusSoon();
  };
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling || shuttingDown) return;
    reconciling = true;
    try {
      const entries = places.load().places;
      const privates = {};
      for (const server of privateservers.list()) privates[server.id] = server;
      const wanted = Object.keys(entries).filter((id) => entries[id].enabled).sort((a, b) => Number(a) - Number(b));
      const nextProblems = [];

      // Turned off or deleted (or the private server was): save players and stop.
      for (const slot of live()) {
        const place = entries[slot.placeId];
        if (!place || !place.enabled) {
          stopServer(slot, MESSAGES.off, place ? 'turned off on the management page' : 'removed from the library');
        } else if (slot.privateId && (!privates[slot.privateId] || privates[slot.privateId].placeId !== slot.placeId)) {
          stopServer(slot, MESSAGES.privateGone, 'its private server was deleted');
        }
      }

      // "Keep running": one public server at all times, while there is room.
      for (const id of wanted) {
        if (entries[id].keepRunning === false || serversOf(id).length > 0) continue;
        const started = startServer(id, null, entries, 'it is kept running');
        if (started.error) {
          nextProblems.push(`"${entries[id].name}" (${id}) is kept running but waits: ${started.error.replace(/ Try again.*$/, '')} (maxGames, gamePortCount in config\\dedicated.json)`);
          continue;
        }
        await sleep(1000); // one RCC start at a time is gentler
      }

      // A new version of a running game: save players and restart on it.
      // Team Create saves (every few minutes while people build) wait until
      // nobody is playing, so players are not kicked each time.
      for (const slot of live()) {
        const place = entries[slot.placeId];
        if (place && slot.session && slot.startedVersion !== null && (place.version || 1) !== slot.startedVersion && !slot.restarting) {
          if (place.versionSource === 'teamcreate') {
            if (Array.isArray(slot.players) && slot.players.length === 0) {
              log(slot.scope, `Team Create saved version ${place.version} and nobody is playing; restarting on it`);
              slot.restart('Team Create changes go live').catch(() => {});
            }
          } else {
            log(slot.scope, `version ${place.version} was uploaded; restarting`);
            slot.restart('a new version was uploaded', MESSAGES.updated).catch(() => {});
          }
        }
      }

      // Team Create servers for places that left Team Create or the library.
      for (const [id, slot] of cloud) {
        if ((!entries[id] || !entries[id].teamCreate) && !slot.stopping) {
          slot.shutdown(entries[id] ? 'Team Create was turned off' : 'removed from the library').catch(() => {});
        }
      }

      // Players joining (start), and buttons on the management page.
      for (const request of places.readRequests()) {
        if (handled.has(request.id)) continue;
        handled.add(request.id);
        if (['update-check', 'update-install', 'server-restart'].includes(request.action)) {
          serverRequests.push(request.action);
          continue;
        }
        const id = String(request.placeId);
        if (request.action === 'cloudedit') {
          if (entries[id] && entries[id].teamCreate && !cloud.has(id)) startCloudEdit(id, entries);
          continue;
        }
        if (request.action === 'start') {
          // A player joins and every server is full, or there is none. One
          // that is starting already will do.
          const privateId = request.privateId ? String(request.privateId) : null;
          if (!entries[id] || !entries[id].enabled) { failStart(request, 'This game is not online right now.'); continue; }
          if (privateId && (!privates[privateId] || privates[privateId].placeId !== id)) { failStart(request, 'That private server no longer exists.'); continue; }
          const existing = serversOf(id, privateId);
          if (privateId ? existing.length > 0 : existing.some((slot) => slot.state === 'starting' || slot.restarting)) continue;
          const started = startServer(id, privateId, entries, privateId ? `private server "${privates[privateId].name}"` : 'a player is joining');
          if (started.error) failStart(request, started.error);
          continue;
        }
        if (request.action === 'restart') {
          const targets = request.jobId ? [slots.get(String(request.jobId))].filter(Boolean) : live().filter((slot) => slot.placeId === id);
          for (const slot of targets) {
            log(slot.scope, 'restart requested on the management page');
            slot.restart('restart requested', MESSAGES.manual).catch(() => {});
          }
          continue;
        }
        if (request.action === 'stop-server') {
          const slot = slots.get(String(request.jobId || ''));
          if (slot) stopServer(slot, MESSAGES.stopped, 'closed on the management page');
        }
      }

      if (JSON.stringify(nextProblems) !== JSON.stringify(problems)) {
        problems = nextProblems;
        for (const problem of problems) log('server', problem);
        statusSoon();
      }
    } catch (error) {
      log('server', `could not read the place library: ${error.message}`);
    } finally {
      reconciling = false;
    }
  };

  await reconcile();
  const reconcileTimer = setInterval(reconcile, 3000);
  const sampleTimer = setInterval(() => { sampleAll().catch(() => {}); }, 10000);
  const checks = setInterval(() => {
    for (const slot of slots.values()) slot.check().catch((error) => log(slot.scope, `check failed: ${error.message}`));
  }, Math.max(15, Number(config.healthCheckSeconds) || 60) * 1000);
  const report = setInterval(() => {
    for (const slot of slots.values()) log('status', slot.describe());
  }, 15 * 60 * 1000);

  let dailyTimer = null;
  const scheduleDaily = () => {
    if (!config.restartDaily) return;
    const at = nextDaily(config.restartDaily);
    dailyTimer = setTimeout(async () => {
      if (updates.listStaged().some((item) => !item.failed)) {
        installUpdates('daily restart');
        return;
      }
      log('server', 'daily restart');
      for (const slot of [...slots.values()]) await slot.restart('daily restart', MESSAGES.daily).catch(() => {});
      scheduleDaily();
    }, at.getTime() - Date.now());
  };
  scheduleDaily();

  // fast: the window is closing. after: runs once everything has stopped,
  // before this exits (an update or a restart starts the next server).
  const shutdown = async (fast, after = null, message = MESSAGES.shutdown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of [reconcileTimer, sampleTimer, checks, report, updateTimer, idleTimer, serverTimer]) clearInterval(timer);
    clearTimeout(dailyTimer);
    clearTimeout(firstCheck);
    if (fast) {
      // The window is closing: Windows allows a few seconds only.
      for (const slot of slots.values()) slot.killNow();
      for (const slot of cloud.values()) slot.killNow();
    } else {
      log('server', 'stopping: saving players and Team Create places, then stopping the games and the web server');
      await Promise.all([
        ...[...slots.values()].map((slot) => slot.shutdown(message).catch(() => {})),
        ...[...cloud.values()].map((slot) => slot.shutdown('the server is stopping').catch(() => {})),
      ]);
    }
    slots.clear();
    cloud.clear();
    try { places.writeRunnerStatus({ pid: null, maxGames: config.maxGames, games: {}, problems: [], stoppedAt: new Date().toISOString() }); } catch (error) { /* ignore */ }
    try { fs.unlinkSync(places.STATUS); } catch (error) { /* gone */ }
    if (web) web.stop();
    try { if ((core.readText(hosting.DEDICATED_PID) || '').trim() === String(process.pid)) fs.unlinkSync(hosting.DEDICATED_PID); } catch (error) { /* gone */ }
    log('server', 'stopped');
    if (after) {
      try {
        await after();
      } catch (error) {
        log('server', `${error.message}; starting the server again as it was`);
        relaunch();
      }
    }
    process.exit(0);
  };

  // --- updates and whole-server restarts (lib/updates.js, apply-update.js) ---
  // Starts startServer.bat through Explorer, as a double-click does (its
  // window then takes Ctrl+C, and it never runs as administrator).
  const relaunch = () => {
    const explorer = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
    spawn(explorer, [core.rootPath('startServer.bat')], { detached: true, stdio: 'ignore' }).unref();
  };

  // The startServer window this runs in, which the installer waits for.
  const windowPid = () => {
    const found = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}").CommandLine`], { encoding: 'utf8', windowsHide: true });
    return /startServer\.bat/i.test(String(found.stdout || '')) ? process.ppid : null;
  };

  const installUpdates = (reason) => {
    if (shuttingDown) return;
    const ready = updates.listStaged().filter((item) => !item.failed);
    if (ready.length === 0) {
      log('update', 'no update is waiting to install');
      return;
    }
    log('update', `installing ${ready.map((item) => `the ${item.kind} update ${item.label}`).join(' and ')} (${reason}): saving players, then stopping`);
    const parentWindow = windowPid();
    shutdown(false, async () => {
      fs.mkdirSync(updates.DIR, { recursive: true });
      const applier = path.join(updates.DIR, 'apply-update.js');
      fs.copyFileSync(path.join(__dirname, 'apply-update.js'), applier);
      const job = path.join(updates.DIR, 'apply.json');
      fs.writeFileSync(job, `${JSON.stringify({ root: core.rootPath(), runnerPid: process.pid, windowPid: parentWindow, staged: ready.map((item) => item.dir), reason }, null, 2)}\n`);
      spawn(process.execPath, [applier, job], { cwd: updates.DIR, env: process.env, detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      log('update', 'the update installer takes over; the server starts again in about a minute (updates\\update.log)');
    }, MESSAGES.update);
  };

  const restartServer = (reason) => {
    if (shuttingDown) return;
    log('server', `restarting the whole server (${reason})`);
    shutdown(false, async () => relaunch(), MESSAGES.manual);
  };

  const checkUpdates = async (manual) => {
    if (updateState.checking || shuttingDown) return;
    updateState.checking = true;
    statusSoon();
    try {
      const best = await updates.latestPublished();
      const current = updates.installed();
      const waiting = updates.listStaged().find((item) => item.kind === 'public');
      updateState.lastCheck = new Date().toISOString();
      updateState.lastError = null;
      updateState.available = best && best.build > current.public ? { build: best.build, label: updates.buildLabel(best.build), release: best.release } : null;
      if (best && best.build > current.public && !(waiting && waiting.build >= best.build)) {
        log('update', `downloading server update ${best.release} (${Math.max(1, Math.round(best.size / 1048576))} MB)`);
        const info = updates.stage(await updates.download(best.url), `GitHub release ${best.release}`);
        log('update', `server update ${info.label} is ready: it installs ${config.autoUpdate !== false ? 'once nobody is playing' : 'when Install is pressed on /manage'}`);
      } else if (manual) {
        log('update', !best ? 'no server updates are published yet' : best.build <= current.public ? 'the server is up to date' : 'the newest update is already waiting to install');
      }
    } catch (error) {
      if (manual || updateState.lastError !== error.message) log('update', `could not check for updates: ${error.message}`);
      updateState.lastError = error.message;
      updateState.lastCheck = new Date().toISOString();
    } finally {
      updateState.checking = false;
      statusSoon();
    }
  };

  // A waiting update installs once nobody has played or built for 3 minutes.
  let idleChecks = 0;
  const autoInstall = () => {
    if (shuttingDown || config.autoUpdate === false) return;
    if (!updates.listStaged().some((item) => !item.failed)) {
      idleChecks = 0;
      return;
    }
    const playing = [...slots.values()].reduce((sum, slot) => sum + (Array.isArray(slot.players) ? slot.players.length : 0), 0) + cloud.size;
    idleChecks = playing === 0 ? idleChecks + 1 : 0;
    if (idleChecks >= 3) installUpdates('nobody is playing');
  };

  const hours = config.updateCheckHours === 0 ? 0 : (Number(config.updateCheckHours) || DEFAULTS.updateCheckHours);
  if (hours > 0) {
    firstCheck = setTimeout(() => { checkUpdates(false).catch(() => {}); }, 2 * 60 * 1000);
    updateTimer = setInterval(() => { checkUpdates(false).catch(() => {}); }, hours * 3600000);
  }
  idleTimer = setInterval(autoInstall, 60 * 1000);
  serverTimer = setInterval(() => {
    while (serverRequests.length > 0 && !shuttingDown) {
      const action = serverRequests.shift();
      if (action === 'update-check') checkUpdates(true).catch(() => {});
      else if (action === 'update-install') installUpdates('requested on the management page');
      else if (action === 'server-restart') restartServer('requested on the management page');
    }
  }, 1000);
  process.on('SIGINT', () => shutdown(false));
  process.on('SIGTERM', () => shutdown(false));
  process.on('SIGBREAK', () => shutdown(true));
  process.on('SIGHUP', () => shutdown(true));

  // Commands typed in the window.
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    const [command, argument] = line.trim().split(/\s+/);
    const name = (command || '').toLowerCase();
    if (name === 'status') {
      await sampleAll();
      if (slots.size === 0) log('status', 'no game servers running (they start when someone joins; games are turned on at http://<this PC>/manage)');
      for (const slot of slots.values()) log('status', slot.describe());
      for (const slot of cloud.values()) log('status', slot.describe());
      for (const problem of problems) log('status', problem);
    } else if (name === 'restart') {
      const targets = !argument || argument === 'all' ? live() : live().filter((slot) => slot.placeId === argument || slot.jobId.startsWith(argument.replace(/^#/, '')));
      if (targets.length === 0) log('server', `no running server of place ${argument} (or with that job ID)`);
      for (const slot of targets) await slot.restart('restart requested', MESSAGES.manual);
    } else if (name === 'stop' || name === 'quit' || name === 'exit') {
      shutdown(false);
    } else if (name !== '') {
      log('server', 'commands: status, restart, restart <place ID or job ID>, stop');
    }
  });
  writeStatus();
  log('server', 'running. Type "status", "restart", "restart <place ID>" or "stop" (or press Ctrl+C) here.');
}

main().catch((error) => {
  log('server', `cannot start: ${error.message}`);
  try { if ((core.readText(hosting.DEDICATED_PID) || '').trim() === String(process.pid)) fs.unlinkSync(hosting.DEDICATED_PID); } catch (e) { /* gone */ }
  process.exit(1);
});
