'use strict';

// A game's place file for a Roblox year other than its own. The launcher lets
// a player pick the year they play a game in (/manage says which years each
// game allows); a 2016 pick gets a 2016 game server, and that RCC needs the
// place converted for 2016.
//
//   Server/content/places/years/<placeId>-<year>-v<version>.rbxl(x)   the converted file
//   Server/content/places/years/<placeId>-<year>.json   { version, file, from, convertedAt, notes } or { version, error }
//   Webserver/node/data/convert-reports/<placeId>-<year>.json   the converter's report on it (lib/convertreport.js;
//                                                    /manage shows only the game's own <placeId>.json)
//
// dedicated.js calls prepare() before it starts such a server. It converts in
// a worker thread (big places take a while; the runner keeps answering) with
// lib/placeconvert.js, from the original upload when the server kept it
// (places.originalFile), else from the stored file. A new version of the game
// is converted again the next time a server of that year starts.
// Where lib/placeconvert.js (the per-year converter) isn't installed, every
// year gets the game's own file, as before the picker.
// The 2018 RCC fetches the place from the web server instead of reading it
// from disk; lib/routes.js sends it fetchedFile().

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const core = require('./core');
const engines = require('./engines');
const places = require('./places');

const CONTENT = core.rootPath('Server', 'content');
const RELATIVE = 'places/years';
const DIR = path.join(CONTENT, ...RELATIVE.split('/'));
const CONVERT_LIMIT_MS = 15 * 60 * 1000;

function converterReady() {
  return core.isFile(path.join(__dirname, 'placeconvert.js'));
}

function metaPath(placeId, year) {
  return path.join(DIR, `${placeId}-${year}.json`);
}

function readMeta(placeId, year) {
  const meta = core.readJsonFile(metaPath(placeId, year));
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
}

const versionOf = (place) => place.version || 1;

// The converted file of the place's current version -> its path under
// Server/content ('places/years/...'), or null.
function freshFile(place, placeId, year) {
  const meta = readMeta(placeId, year);
  if (!meta || meta.error || meta.version !== versionOf(place) || !/^[\w.-]+\.rbxlx?$/.test(String(meta.file || ''))) return null;
  return core.isFile(path.join(DIR, meta.file)) ? `${RELATIVE}/${meta.file}` : null;
}

// The file a server of that year loads (under Server/content), without
// converting: the game's own file for its own year or until converted.
function fileFor(place, placeId, year) {
  if (!place) return null;
  if (!year || year === places.engineOf(place)) return place.file;
  return freshFile(place, placeId, year) || place.file;
}

// The file to send when an RCC fetches a library place over HTTP (the 2018
// RCC loads it from assetgame.<domain>/asset/?id=): while a server of another
// year that loads places that way is starting for it on this PC, that year's
// file; else the game's own.
function fetchedFile(place, placeId, { loopback = false, userAgent = '' } = {}) {
  const own = places.engineOf(place);
  if (loopback && !/studio/i.test(String(userAgent))) {
    const status = places.runnerStatus();
    const servers = status && !status.stale && status.servers && typeof status.servers === 'object' ? Object.values(status.servers) : [];
    for (const server of servers) {
      const year = server ? engines.known(server.engine) : null;
      if (!year || year === own || String(server.placeId) !== String(placeId) || !engines.get(year).jsonJobs) continue;
      if (server.state !== 'starting' && server.state !== 'restarting') continue;
      const fresh = freshFile(place, placeId, year);
      if (fresh) return path.join(CONTENT, ...fresh.split('/'));
    }
  }
  return places.filePath(place);
}

// --- converting -----------------------------------------------------------------------------

// One conversion at a time (they can take a lot of memory), one per place and year.
let chain = Promise.resolve();
const pending = new Map(); // "<placeId>-<year>" -> Promise

function runWorker(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { yearPlaceJob: job } });
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      done(reject, new Error(`it took longer than ${CONVERT_LIMIT_MS / 60000} minutes`));
    }, CONVERT_LIMIT_MS);
    worker.once('message', (message) => {
      if (message && message.error) done(reject, new Error(message.error));
      else done(resolve, message);
    });
    worker.once('error', (error) => done(reject, error));
    worker.once('exit', (code) => done(reject, new Error(`the converter stopped (exit code ${code})`)));
  });
}

// Older converted files of this place and year, once the new one is there,
// with the links other years' RCCs load them through (lib/hosting.js
// linkPlaceFile, <server>/content/places/years).
function removeOlder(placeId, year, keep) {
  const dirs = [DIR, ...Object.values(engines.ENGINES).filter((engine) => engine.server !== 'Server')
    .map((engine) => core.rootPath(engine.server, 'content', ...RELATIVE.split('/')))];
  const prefix = `${placeId}-${year}-v`;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (error) { continue; }
    for (const name of names) {
      if (name !== keep && name.startsWith(prefix) && /\.rbxlx?$/.test(name)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (error) { /* an RCC still reads it: next time */ }
      }
    }
  }
}

async function convert(place, placeId, year, centralUrl, log) {
  const original = typeof places.originalFile === 'function' ? places.originalFile(place, placeId) : null;
  const source = original || places.filePath(place);
  const version = versionOf(place);
  const started = Date.now();
  log(`converting the place for ${year} (from ${original ? 'the original upload' : 'the stored file'})...`);
  fs.mkdirSync(DIR, { recursive: true });
  try {
    const result = await runWorker({
      placeId: String(placeId), year, version, source, dir: DIR,
      universeId: place.universeId || null, centralUrl,
    });
    core.writeFileAtomic(metaPath(placeId, year), JSON.stringify({
      placeId: String(placeId), year, version, file: result.file, from: original ? 'original' : 'stored',
      convertedAt: new Date().toISOString(), notes: result.notes,
    }, null, 2));
    removeOlder(placeId, year, result.file);
    writeReport(placeId, year, result.counts);
    log(`converted for ${year} in ${Math.round((Date.now() - started) / 1000)} s`);
    return `${RELATIVE}/${result.file}`;
  } catch (error) {
    core.writeFileAtomic(metaPath(placeId, year), JSON.stringify({ placeId: String(placeId), year, version, error: error.message, at: new Date().toISOString() }, null, 2));
    throw error;
  }
}

// The converter's report on a year's file, beside the game's own report.
function writeReport(placeId, year, counts) {
  try {
    const convertreport = require('./convertreport');
    const report = convertreport.build({ placeId, engine: year, counts: counts || null, check: null });
    fs.mkdirSync(convertreport.REPORTS_DIR, { recursive: true });
    core.writeFileAtomic(path.join(convertreport.REPORTS_DIR, `${placeId}-${year}.json`), `${JSON.stringify(report, null, 1)}\n`);
  } catch (error) { /* no converter reports on this server */ }
}

// The file a server of that year should load (under Server/content),
// converting first when needed -> { file, note }. note: why it is the game's
// own file after all (for the log).
async function prepare(place, placeId, year, { centralUrl = 'http://127.0.0.1', log = () => {} } = {}) {
  if (!year || year === places.engineOf(place)) return { file: place.file };
  const fresh = freshFile(place, placeId, year);
  if (fresh) return { file: fresh };
  if (!converterReady()) return { file: place.file, note: `this server has no converter for other years yet, so ${year} uses the game's own file` };
  const meta = readMeta(placeId, year);
  if (meta && meta.error && meta.version === versionOf(place)) {
    return { file: place.file, note: `converting for ${year} failed (${meta.error}); using the game's own file` };
  }
  const key = `${placeId}-${year}`;
  if (!pending.has(key)) {
    const job = chain.then(() => convert(place, placeId, year, centralUrl, log));
    chain = job.catch(() => {});
    pending.set(key, job.finally(() => pending.delete(key)));
  }
  try {
    return { file: await pending.get(key) };
  } catch (error) {
    return { file: place.file, note: `converting for ${year} failed (${error.message}); using the game's own file` };
  }
}

function converting(placeId, year) {
  return pending.has(`${placeId}-${year}`);
}

// --- the worker -------------------------------------------------------------------------------

// Union meshes come from the asset cache, else from the web server.
async function workerAssetBytes(assetId, centralUrl) {
  const cachePath = path.join(core.cacheDir('assets'), `id-${assetId}.bin`);
  try {
    if (fs.statSync(cachePath).size > 0) {
      const bytes = fs.readFileSync(cachePath);
      return bytes[0] === 0x1f && bytes[1] === 0x8b ? require('./assets').normalizeAsset(bytes).bytes : bytes;
    }
  } catch (error) { /* not cached */ }
  try {
    const response = await fetch(`${centralUrl}/asset/?id=${encodeURIComponent(String(assetId))}`, { signal: AbortSignal.timeout(30000) });
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch (error) {
    return null;
  }
}

async function workerJob(job) {
  const placeconvert = require('./placeconvert')({ assetBytes: (id) => workerAssetBytes(id, job.centralUrl), log: () => {} });
  const converted = await placeconvert.convert(fs.readFileSync(job.source), { universeId: job.universeId, engine: job.year });
  if (converted.engine && converted.engine !== job.year) throw new Error(`the converter has no ${job.year} target`);
  const bytes = Buffer.from(converted.bytes);
  const ext = bytes.toString('latin1', 0, 8) === '<roblox!' ? 'rbxl' : 'rbxlx';
  const file = `${job.placeId}-${job.year}-v${job.version}.${ext}`;
  if (!core.writeFileAtomic(path.join(job.dir, file), bytes)) throw new Error('could not save the converted file');
  return { file, notes: Array.isArray(converted.notes) ? converted.notes.length : 0, counts: converted.counts || null };
}

if (!isMainThread && workerData && workerData.yearPlaceJob) {
  workerJob(workerData.yearPlaceJob).then(
    (result) => parentPort.postMessage(result),
    (error) => parentPort.postMessage({ error: error && error.message ? error.message : String(error) }),
  );
}

module.exports = { fileFor, fetchedFile, prepare, converting, converterReady, freshFile, DIR };
