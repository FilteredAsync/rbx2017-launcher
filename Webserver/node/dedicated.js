'use strict';

// Always-on server: runs the web server and every game that is "online" in
// the place library (Webserver/node/data/places.json, managed at
// http://<this PC>/manage), and keeps them running.
//   - Turning a game on or off on the management page starts or stops it
//     (players are saved first); uploading a new version restarts it.
//   - A game whose RCC stops by itself is started again; one that stops
//     answering for a few minutes is restarted.
//   - A game using more than memoryLimitMB restarts when nobody is playing
//     (past 115% of the limit, after saving the players).
//   - Every game restarts once a day at restartDaily, players saved first.
//   - The web server is started again if it stops.
// Server-wide settings: config/dedicated.json (all optional). Each game gets
// a UDP port from gamePortFirst (53640) onwards, one per running game, up to
// gamePortCount (tailscaleFirewall.bat opens that range).
// startServer.bat runs this; autostartServer.bat starts it at sign-in.
// Type "status", "restart", "restart <place ID>" or "stop" in its window.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const core = require('./lib/core');
const hosting = require('./lib/hosting');
const places = require('./lib/places');

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
  gamePortFirst: 53640,
  gamePortCount: 20,
};

const MESSAGES = {
  daily: 'Daily server restart. Your progress was saved - rejoin in a minute.',
  memory: 'The server is restarting to free memory. Your progress was saved - rejoin in a minute.',
  manual: 'The server is restarting. Your progress was saved - rejoin in a minute.',
  updated: 'This game was updated. Your progress was saved - rejoin in a minute.',
  off: 'This game was turned off. Your progress was saved.',
  shutdown: 'The server is shutting down. Your progress was saved.',
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

// --- one game ------------------------------------------------------------------------------

class GameSlot {
  // index: which port pair this game uses while it runs.
  constructor(placeId, index, config, onChange) {
    this.placeId = placeId;
    this.index = index;
    this.config = config;
    this.onChange = onChange;
    this.scope = `place ${placeId}`;
    this.session = null;
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

  setState(state, error) {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.onChange();
  }

  // Read from the library at every start, so renames and new files apply.
  hostConfig() {
    const place = places.load().places[this.placeId];
    if (!place) throw new Error('this place is no longer in the library');
    this.scope = `${place.name} (${this.placeId})`;
    this.startedVersion = place.version || 1;
    return {
      gameName: place.name,
      placeId: this.placeId,
      placeFile: place.file,
      gamePort: this.gamePort,
      soapPort: this.soapPort,
      publicAddress: `tailscale:${this.gamePort}`,
      centralUrl: this.config.centralUrl,
      hostKey: this.config.hostKey,
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
    let failures = 0;
    while (!this.shuttingDown) {
      try {
        this.setState('starting');
        const config = this.hostConfig();
        this.session = await hosting.startHosting(config, { log: (line) => log(this.scope, line), dedicated: true });
        failures = 0;
        this.badChecks = 0;
        this.startedAt = Date.now();
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
        failures++;
        const delay = Math.min(300, 15 * 2 ** Math.min(failures - 1, 5));
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

  // Players and memory for the status report.
  async sample() {
    const session = this.session;
    if (!session || this.state !== 'running') return;
    this.players = await session.players();
    this.memoryMB = session.memoryMB();
  }

  report() {
    return {
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

// --- main ----------------------------------------------------------------------------------

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

  const web = config.webServer ? new WebServer() : null;
  if (web) {
    await web.keepStarting();
    log('web', 'web server is up on port 80; manage games at http://<this PC>/manage');
  }

  const slots = new Map(); // placeId -> GameSlot
  const retiring = new Set();
  let problems = [];
  let shuttingDown = false;

  // --- status for the management page ---
  let statusTimer = null;
  const writeStatus = () => {
    const games = {};
    for (const [id, slot] of slots) games[id] = slot.report();
    places.writeRunnerStatus({ pid: process.pid, maxGames: config.maxGames, games, problems });
  };
  const statusSoon = () => {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; writeStatus(); }, 300);
  };
  const sampleAll = async () => {
    for (const slot of slots.values()) await slot.sample().catch(() => {});
    writeStatus();
  };

  // --- keep running games in line with the library ---
  const handled = new Set(places.readRequests().map((request) => request.id)); // older requests are done
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling || shuttingDown) return;
    reconciling = true;
    try {
      const entries = places.load().places;
      const wanted = Object.keys(entries).filter((id) => entries[id].enabled).sort((a, b) => Number(a) - Number(b));
      const nextProblems = [];

      // Turned off or deleted: save players and stop.
      for (const [id, slot] of slots) {
        if (!wanted.includes(id) && !retiring.has(id)) {
          retiring.add(id);
          log(slot.scope, entries[id] ? 'turned off on the management page' : 'removed from the library');
          slot.shutdown(MESSAGES.off).catch(() => {}).finally(() => {
            slots.delete(id);
            retiring.delete(id);
            statusSoon();
          });
        }
      }

      // Turned on: start, while there is room.
      for (const id of wanted) {
        if (slots.has(id)) continue;
        if (slots.size >= config.maxGames) {
          nextProblems.push(`"${entries[id].name}" (${id}) is online but waits: ${config.maxGames} games already run (maxGames in config\\dedicated.json).`);
          continue;
        }
        const used = new Set([...slots.values()].map((slot) => slot.index));
        let index = 0;
        while (used.has(index)) index++;
        if (index >= config.gamePortCount) {
          nextProblems.push(`no free game port for "${entries[id].name}" (gamePortCount in config\\dedicated.json).`);
          continue;
        }
        const slot = new GameSlot(id, index, config, statusSoon);
        slots.set(id, slot);
        log(`place ${id}`, `turning on "${entries[id].name}" (game port ${slot.gamePort})`);
        slot.run().catch((error) => log(slot.scope, `stopped: ${error.message}`));
        await sleep(1000); // one RCC start at a time is gentler
      }

      // A new version of a running game: save players and restart on it.
      for (const [id, slot] of slots) {
        const place = entries[id];
        if (place && slot.session && slot.startedVersion !== null && (place.version || 1) !== slot.startedVersion && !slot.restarting) {
          log(slot.scope, `version ${place.version} was uploaded; restarting`);
          slot.restart('a new version was uploaded', MESSAGES.updated).catch(() => {});
        }
      }

      // Restart buttons on the management page.
      for (const request of places.readRequests()) {
        if (handled.has(request.id)) continue;
        handled.add(request.id);
        const slot = slots.get(String(request.placeId));
        if (request.action === 'restart' && slot) {
          log(slot.scope, 'restart requested on the management page');
          slot.restart('restart requested', MESSAGES.manual).catch(() => {});
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
      log('server', 'daily restart');
      for (const slot of [...slots.values()]) await slot.restart('daily restart', MESSAGES.daily).catch(() => {});
      scheduleDaily();
    }, at.getTime() - Date.now());
  };
  scheduleDaily();

  const shutdown = async (fast) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of [reconcileTimer, sampleTimer, checks, report]) clearInterval(timer);
    clearTimeout(dailyTimer);
    if (fast) {
      // The window is closing: Windows allows a few seconds only.
      for (const slot of slots.values()) slot.killNow();
    } else {
      log('server', 'stopping: saving players, then stopping the games and the web server');
      await Promise.all([...slots.values()].map((slot) => slot.shutdown(MESSAGES.shutdown).catch(() => {})));
    }
    slots.clear();
    try { places.writeRunnerStatus({ pid: null, maxGames: config.maxGames, games: {}, problems: [], stoppedAt: new Date().toISOString() }); } catch (error) { /* ignore */ }
    try { fs.unlinkSync(places.STATUS); } catch (error) { /* gone */ }
    if (web) web.stop();
    try { if ((core.readText(hosting.DEDICATED_PID) || '').trim() === String(process.pid)) fs.unlinkSync(hosting.DEDICATED_PID); } catch (error) { /* gone */ }
    log('server', 'stopped');
    process.exit(0);
  };
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
      if (slots.size === 0) log('status', 'no games online (turn some on at http://<this PC>/manage)');
      for (const slot of slots.values()) log('status', slot.describe());
      for (const problem of problems) log('status', problem);
    } else if (name === 'restart') {
      const targets = !argument || argument === 'all' ? [...slots.values()] : [slots.get(argument)].filter(Boolean);
      if (targets.length === 0) log('server', `no online game with place ID ${argument}`);
      for (const slot of targets) await slot.restart('restart requested', MESSAGES.manual);
    } else if (name === 'stop' || name === 'quit' || name === 'exit') {
      shutdown(false);
    } else if (name !== '') {
      log('server', 'commands: status, restart, restart <place ID>, stop');
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
