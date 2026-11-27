'use strict';

// Live numbers for the /manage Performance view: CPU, RAM, GPU, temperatures,
// players, games, RCC and network. One sample every 10 s; the last hour stays
// in memory (a restart starts over). Only lib/manageapi.js serves it, behind
// the manage checks (lib/admin.js).
//
// Where each number comes from (one that can't be read is null, "n/a" on the page):
//   CPU, RAM               Node's os module
//   GPU, VRAM, GPU temp    nvidia-smi, else LibreHardwareMonitor / OpenHardwareMonitor
//                          (while it runs), else GPU usage from the Windows counters
//   CPU temp               LibreHardwareMonitor / OpenHardwareMonitor, else ACPI thermal zones
//   RCC, network           lib/hoststats.ps1: one PowerShell for as long as this process runs
//   players, games         the always-on server's status (passed in by lib/manageapi.js)
//
//   const hoststats = require('./hoststats');
//   hoststats.start(current)   current() -> { up, players, servers, games }
//   hoststats.read(since)      -> { interval, keep, info, samples } (the samples after `since`)

const os = require('os');
const path = require('path');
const cp = require('child_process');

const INTERVAL_MS = 10 * 1000;
const KEEP = 360;                       // an hour
const STALE_MS = 3 * INTERVAL_MS;       // a probe answer older than this is n/a
const RECHECK_MS = 10 * 60 * 1000;      // look for nvidia-smi again
const PROBE_SCRIPT = path.join(__dirname, 'hoststats.ps1');

const samples = [];
const info = {
  cpuName: '', cores: 0, ramTotal: os.totalmem(),
  gpuName: null, vramTotal: null,
  sources: { gpu: null, gpuTemp: null, cpuTemp: null, windows: false },
};

const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const fresh = (entry) => (entry && Date.now() - entry.at < STALE_MS ? entry : null);

// --- CPU and RAM ----------------------------------------------------------------------------

let cpuBefore = null;
function cpuPercent() {
  let idle = 0;
  let total = 0;
  const cpus = os.cpus();
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  if (cpus.length) {
    info.cpuName = String(cpus[0].model || '').replace(/\s+/g, ' ').trim();
    info.cores = cpus.length;
  }
  const before = cpuBefore;
  cpuBefore = { idle, total };
  if (!before || total <= before.total) return null;
  return round(Math.min(100, Math.max(0, 100 * (1 - (idle - before.idle) / (total - before.total)))));
}

// --- nvidia-smi -----------------------------------------------------------------------------

const NVIDIA = [
  'nvidia-smi',
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
];
const GPU_QUERY = ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
let nvidiaFile;            // undefined: not looked for yet, null: none
let nvidiaLookedAt = 0;
let nvidiaBusy = false;
let nvidia = null;         // { at, gpu, temp, vram, vramTotal, name }

function readNvidia(file, done) {
  cp.execFile(file, GPU_QUERY, { timeout: 5000, windowsHide: true }, (error, stdout) => {
    if (error) return done(null);
    const number = (text) => (/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null);
    const gpus = String(stdout).split(/\r?\n/).map((line) => line.split(',').map((part) => part.trim())).filter((cols) => cols.length >= 5);
    if (!gpus.length) return done(null);
    const pick = (index, how) => {
      const values = gpus.map((cols) => number(cols[index])).filter((value) => value !== null);
      return values.length ? how(values) : null;
    };
    const sum = (values) => values.reduce((a, b) => a + b, 0);
    return done({
      at: Date.now(),
      name: gpus[0][0] + (gpus.length > 1 ? ` (+${gpus.length - 1})` : ''),
      gpu: pick(1, (values) => Math.max(...values)),
      temp: pick(2, (values) => Math.max(...values)),
      vram: pick(3, (values) => sum(values) * 1048576),
      vramTotal: pick(4, (values) => sum(values) * 1048576),
    });
  });
}

// Asks nvidia-smi for the next sample (finding it first, and again every
// 10 minutes while there is none).
function pollNvidia() {
  if (nvidiaBusy) return;
  if (nvidiaFile === null && Date.now() - nvidiaLookedAt < RECHECK_MS) return;
  nvidiaBusy = true;
  const candidates = nvidiaFile ? [nvidiaFile] : NVIDIA.slice();
  const next = () => {
    const file = candidates.shift();
    if (!file) {
      nvidiaBusy = false;
      nvidiaFile = null;
      nvidiaLookedAt = Date.now();
      return;
    }
    readNvidia(file, (result) => {
      if (!result) return next();
      nvidiaBusy = false;
      nvidiaFile = file;
      nvidia = result;
      info.gpuName = result.name;
      if (result.vramTotal) info.vramTotal = result.vramTotal;
    });
  };
  next();
}

// --- the Windows probe (lib/hoststats.ps1) ------------------------------------------------------

let probe = null;          // the PowerShell child
let probeFails = 0;
let windows = null;        // its last line, parsed, with `at`
let network = null;        // { at, rx, tx, nics } the line before, for rates
let rates = null;          // { at, netIn, netOut } bytes per second

function startProbe() {
  if (process.platform !== 'win32' || probe) return;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE_SCRIPT, '-Parent', String(process.pid), '-Every', String(INTERVAL_MS)];
  // Without nvidia-smi, the Windows counters stand in for GPU usage.
  if (nvidiaFile === null) args.push('-GpuCounters');
  const startedAt = Date.now();
  let child;
  try {
    child = cp.spawn(powershell, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (error) {
    return;
  }
  probe = child;
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (line.startsWith('{')) onProbeLine(line);
    }
    if (buffered.length > 1048576) buffered = '';
  });
  // Ended (or never started: then only 'error' comes). Ran a while: start it
  // again soon. Keeps failing: wait longer each time (at most 10 minutes).
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    probe = null;
    probeFails = Date.now() - startedAt > 5 * 60 * 1000 ? 0 : probeFails + 1;
    const again = setTimeout(startProbe, Math.min(RECHECK_MS, 15000 * 2 ** Math.min(probeFails, 6)));
    if (again.unref) again.unref();
  };
  child.on('error', end);
  child.on('exit', end);
  // A short-lived script that loads this file must still be able to exit.
  child.unref();
  if (child.stdout.unref) child.stdout.unref();
}

function onProbeLine(line) {
  let result;
  try { result = JSON.parse(line); } catch (error) { return; }
  if (!result || typeof result !== 'object') return;
  result.at = Date.now();
  windows = result;
  info.sources.windows = true;
  if (Number.isFinite(result.rx) && Number.isFinite(result.tx)) {
    const before = network;
    network = { at: result.at, t: Number(result.t) || result.at, rx: result.rx, tx: result.tx, nics: result.nics };
    const seconds = before ? (network.t - before.t) / 1000 : 0;
    // An adapter that came or went (or was reset) changes the totals: no rate this time.
    if (before && seconds > 0 && before.nics === network.nics && network.rx >= before.rx && network.tx >= before.tx) {
      rates = { at: result.at, netIn: (network.rx - before.rx) / seconds, netOut: (network.tx - before.tx) / seconds };
    }
  }
}

// --- hardware monitor sensors (LibreHardwareMonitor / OpenHardwareMonitor) -----------------------

// The first sensor whose name matches, in the order of `names`, else the hottest.
function sensorValue(sensors, idTest, type, names) {
  const list = sensors.filter((sensor) => sensor && sensor.type === type && idTest.test(String(sensor.id)) && Number.isFinite(sensor.value));
  for (const name of names) {
    const found = list.find((sensor) => name.test(String(sensor.name)));
    if (found) return found.value;
  }
  return list.length ? Math.max(...list.map((sensor) => sensor.value)) : null;
}

const CPU_SENSOR = /cpu/i;
const GPU_SENSOR = /gpu/i;
const CPU_TEMP_NAMES = [/^CPU Package$/i, /Tctl|Tdie/i, /^Core Max$/i, /^Core Average$/i, /^CPU/i];
const GPU_TEMP_NAMES = [/^GPU Core$/i, /^GPU Hot ?Spot$/i, /^GPU/i];
const GPU_LOAD_NAMES = [/^GPU Core$/i, /^D3D 3D$/i, /^GPU/i];

const celsius = (value) => (Number.isFinite(value) && value > 0 && value < 150 ? round(value) : null);

// -> { cpuTemp, gpuTemp, gpu, sources } from the probe's last line
function fromProbe() {
  const out = { cpuTemp: null, gpuTemp: null, gpu: null, cpuTempFrom: null, gpuTempFrom: null, gpuFrom: null };
  const line = fresh(windows);
  if (!line) return out;
  if (Array.isArray(line.sensors) && line.sensors.length) {
    const monitor = line.monitor === 'OpenHardwareMonitor' ? 'OpenHardwareMonitor' : 'LibreHardwareMonitor';
    out.cpuTemp = celsius(sensorValue(line.sensors, CPU_SENSOR, 'Temperature', CPU_TEMP_NAMES));
    out.gpuTemp = celsius(sensorValue(line.sensors, GPU_SENSOR, 'Temperature', GPU_TEMP_NAMES));
    const load = sensorValue(line.sensors, GPU_SENSOR, 'Load', GPU_LOAD_NAMES);
    out.gpu = Number.isFinite(load) ? round(Math.min(100, Math.max(0, load))) : null;
    if (out.cpuTemp !== null) out.cpuTempFrom = monitor;
    if (out.gpuTemp !== null) out.gpuTempFrom = monitor;
    if (out.gpu !== null) out.gpuFrom = monitor;
  }
  if (out.cpuTemp === null && Array.isArray(line.zones)) {
    // Kelvin; the hottest zone.
    const zones = line.zones.map((kelvin) => celsius(Number(kelvin) - 273.15)).filter((value) => value !== null);
    if (zones.length) {
      out.cpuTemp = Math.max(...zones);
      out.cpuTempFrom = 'ACPI';
    }
  }
  if (out.gpu === null && Number.isFinite(line.gpu)) {
    out.gpu = round(line.gpu);
    out.gpuFrom = 'Windows';
  }
  return out;
}

// --- sampling -------------------------------------------------------------------------------------

let current = () => null;

function sample() {
  const t = Math.round(Date.now() / 1000) * 1000;
  const cpu = cpuPercent();
  const ram = os.totalmem() - os.freemem();
  info.ramTotal = os.totalmem();
  const smi = fresh(nvidia);
  const win = fromProbe();
  const line = fresh(windows);
  const net = fresh(rates);
  let game = null;
  try { game = current(); } catch (error) { game = null; }
  const up = Boolean(game && game.up);

  info.sources.gpu = smi && smi.gpu !== null ? 'nvidia-smi' : win.gpuFrom;
  info.sources.gpuTemp = smi && smi.temp !== null ? 'nvidia-smi' : win.gpuTempFrom;
  info.sources.cpuTemp = win.cpuTempFrom;
  info.sources.windows = Boolean(line);

  samples.push({
    t,
    cpu,
    ram,
    gpu: smi && smi.gpu !== null ? round(smi.gpu) : win.gpu,
    vram: smi ? smi.vram : null,
    cpuTemp: win.cpuTemp,
    gpuTemp: smi && smi.temp !== null ? celsius(smi.temp) : win.gpuTemp,
    players: up ? game.players : null,
    games: up ? game.games : null,
    servers: up ? game.servers : null,
    rcc: line && Number.isFinite(line.rcc) ? line.rcc : null,
    rccRam: line && Number.isFinite(line.rccRam) ? line.rccRam : null,
    netIn: net ? Math.round(net.netIn) : null,
    netOut: net ? Math.round(net.netOut) : null,
  });
  while (samples.length > KEEP) samples.shift();
  pollNvidia();
}

let started = false;
function start(currentGame) {
  if (started) return;
  started = true;
  if (typeof currentGame === 'function') current = currentGame;
  cpuPercent();
  // nvidia-smi first: the probe leaves GPU usage to it when it is there.
  pollNvidia();
  let waits = 0;
  const begin = () => {
    // The probe needs to know whether nvidia-smi is there (a few seconds at most).
    if (nvidiaFile === undefined && waits++ < 10) {
      const later = setTimeout(begin, 1000);
      if (later.unref) later.unref();
      return;
    }
    startProbe();
    sample();
    const timer = setInterval(sample, INTERVAL_MS);
    if (timer.unref) timer.unref();
  };
  const first = setTimeout(begin, 3000);
  if (first.unref) first.unref();
}

process.on('exit', () => {
  if (probe) try { probe.kill(); } catch (error) { /* gone already */ }
});

function read(since) {
  const after = Number(since) || 0;
  return {
    interval: INTERVAL_MS,
    keep: KEEP,
    info,
    samples: after ? samples.filter((item) => item.t > after) : samples.slice(),
  };
}

module.exports = { start, read };
