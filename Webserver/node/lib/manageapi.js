'use strict';

// The /manage page's files and the API only it uses (the rest is in
// lib/routes.js, lib/studio.js and lib/admin.js). Everything but the page
// itself needs the host key or a manage token (lib/admin.js).
//
//   GET  /manage, /manage/<file>.js|css        the page (Webserver/node/manage/)
//   GET  /api/manage/overview                   the dashboard: players per Roblox version now and
//                                               over the last days, problems, recent errors,
//                                               converter report counts, the asset search
//   GET  /api/manage/games/<id>/log?lines=      the always-on server's lines about one game
//   GET  /api/manage/games/<id>/report          the converter's report, or { report: null }
//   GET  /api/manage/games/<id>/client-years    which client years players may pick
//   POST /api/manage/games/<id>/client-years    { years: ['2016', '2017'] }
//   GET  /api/manage/asset-search               every searched asset and what was found
//   POST /api/manage/asset-search               { paused }
//   POST /api/manage/asset-search/<id>/search   search it (again) now
//   GET  /api/manage/asset-search/<id>/<n>      a found file, for its preview
//   POST /api/manage/asset-search/<id>/<n>/approve | reject
//
//   const manage = require('./manageapi')({ send, sendJson, sendFile, jsonBody });
//   manage.routes: [pattern, handler] pairs for the route table

const fs = require('fs');
const path = require('path');
const core = require('./core');
const admin = require('./admin');
const places = require('./places');
const engines = require('./engines');
const assetsearch = require('./assetsearch');

const PAGE_DIR = path.join(__dirname, '..', 'manage');
const PAGE_TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const DATA = core.rootPath('Webserver', 'node', 'data');
const HISTORY = path.join(DATA, 'player-history.json');
const REPORTS = path.join(DATA, 'convert-reports');
// Which client years players may pick per game in the launcher
// (lib/launcherapi.js): { "<placeId>": ["2016", "2017"] }. A game with no
// entry allows every year.
const CLIENT_YEARS = path.join(DATA, 'client-years.json');
const DEDICATED_LOG = core.rootPath('Webserver', 'node', 'logs', 'dedicated.log');

const BUCKET_MS = 10 * 60 * 1000;     // one point per 10 minutes
const HISTORY_DAYS = 7;
const SAMPLE_MS = 60 * 1000;
const PREVIEW_TYPES = { ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', png: 'image/png', jpg: 'image/jpeg', rbxm: 'application/octet-stream', rbxmx: 'text/xml; charset=utf-8' };

// Lines worth a look in the always-on server's log. "script timeout 10 s"
// is part of every start line, so it doesn't count.
const ERROR_LINE = /\b(error|errors|failed|failure|fails|crash(?:ed)?|could not|couldn't|can't|not responding|timed out|refused|rejected|stopped by itself|exit code)\b/i;
const NOT_ERROR = /game job submitted|script timeout \d+ s/i;

// --- reading logs -------------------------------------------------------------------------

// The last `bytes` of a text file as lines (the first, partial one dropped).
function tailLines(file, bytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (length < size) lines.shift();
    return lines.filter((line) => line !== '');
  } finally {
    fs.closeSync(fd);
  }
}

// "2026-11-13 11:59:24  [Lumber Tycoon 2 (1818) #a1b2] text" -> { at, scope, placeId, text }
// Game names may hold brackets ("Phantom Forces [2017]"), so the scope ends
// where its brackets balance.
function parseLine(line) {
  const head = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+\[/.exec(line);
  if (!head) return { at: null, scope: '', placeId: null, text: line };
  let depth = 1;
  let end = head[0].length;
  for (; end < line.length && depth > 0; end++) {
    if (line[end] === '[') depth++;
    else if (line[end] === ']') depth--;
  }
  if (depth > 0) return { at: head[1], scope: '', placeId: null, text: line.slice(head[0].length) };
  const scope = line.slice(head[0].length, end - 1);
  const place = /\((\d{1,15})\)(?:\s|$)/.exec(scope) || /^(?:place|Team Create) (\d{1,15})\b/.exec(scope);
  return { at: head[1], scope, placeId: place ? place[1] : null, text: line.slice(end).replace(/^\s/, '') };
}

// The dedicated.log lines (newest last), from the current file and the one before.
function logLines(bytes) {
  const current = tailLines(DEDICATED_LOG, bytes);
  if (current.length >= 2000) return current;
  return tailLines(`${DEDICATED_LOG}.old`, bytes).concat(current);
}

function recentErrors(limit) {
  const out = [];
  const lines = logLines(1024 * 1024);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = parseLine(lines[i]);
    if (ERROR_LINE.test(line.text) && !NOT_ERROR.test(line.text)) out.push(line);
  }
  return out;
}

function gameLog(placeId, limit) {
  const mentions = new RegExp(`\\(${placeId}\\)|^(?:place|Team Create) ${placeId}\\b`);
  const out = [];
  for (const raw of logLines(2 * 1024 * 1024)) {
    const line = parseLine(raw);
    if (line.placeId === placeId || mentions.test(line.scope) || (line.scope === 'status' && line.text.includes(`(${placeId})`))) out.push(raw);
  }
  return out.slice(-limit);
}

// --- converter reports (the converter writes them; see the contract below) ------------------
// data/convert-reports/<placeId>.json = { placeId, engine, convertedAt, converterVersion,
//   checks: { loads, scripts, scriptsFailed, runErrors },
//   issues: [{ severity: 'error'|'warning'|'info', kind, path, message }] }

function readReport(placeId) {
  const report = core.readJsonFile(path.join(REPORTS, `${placeId}.json`));
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  if (!Array.isArray(report.issues)) report.issues = [];
  report.issues = report.issues.filter((issue) => issue && typeof issue === 'object').slice(0, 5000);
  return report;
}

function reportCounts() {
  const out = {};
  let names;
  try { names = fs.readdirSync(REPORTS); } catch (error) { return out; }
  for (const name of names) {
    const match = /^(\d{1,15})\.json$/.exec(name);
    if (!match) continue;
    const report = readReport(match[1]);
    if (!report) continue;
    const count = (severity) => report.issues.filter((issue) => issue.severity === severity).length;
    const checks = report.checks || {};
    out[match[1]] = {
      errors: count('error'), warnings: count('warning'), info: count('info'),
      loads: checks.loads === undefined ? null : Boolean(checks.loads),
      scriptsFailed: Number(checks.scriptsFailed) || 0, runErrors: Number(checks.runErrors) || 0,
      convertedAt: report.convertedAt || null, engine: report.engine || null,
    };
  }
  return out;
}

// --- client years ---------------------------------------------------------------------------

function readClientYears() {
  const data = core.readJsonFile(CLIENT_YEARS);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

// -> { years, engine, saved }: the game's own year is always in; nothing
// saved means every year (the launcher offers those whose server is here).
// place: its library entry, when the caller has it already.
function clientYearsOf(placeId, place = places.get(placeId)) {
  const own = places.engineOf(place);
  // Games of the self-hosted years (2009, 2011, 2013) play in their own year only,
  // and other games never in those years (lib/launcherapi.js yearsFor).
  if (engines.selfHosted(own)) return { years: [own], engine: own, saved: false };
  const saved = readClientYears()[placeId];
  const years = (Array.isArray(saved) ? saved.filter((year) => engines.known(year)) : Object.keys(engines.ENGINES))
    .filter((year) => !engines.selfHosted(year));
  if (!years.includes(own)) years.unshift(own);
  return { years, engine: own, saved: Array.isArray(saved) };
}

// --- players over time ----------------------------------------------------------------------
// { buckets: [{ t, players, servers, engines: { "2017": players } }] }, one per
// 10 minutes, the busiest minute of each.

let history = null;
let historyDirty = false;

function readHistory() {
  if (history === null) {
    const data = core.readJsonFile(HISTORY);
    history = data && Array.isArray(data.buckets) ? data : { buckets: [] };
  }
  return history;
}

function saveHistory() {
  if (!historyDirty) return;
  historyDirty = false;
  fs.mkdirSync(DATA, { recursive: true });
  core.writeFileAtomic(HISTORY, JSON.stringify(readHistory()));
}
process.on('exit', saveHistory);

// Players and servers now, per Roblox version.
function current() {
  const runner = places.runnerStatus();
  const up = Boolean(runner && !runner.stale);
  const servers = up && runner.servers ? Object.values(runner.servers) : [];
  const library = places.exists() ? places.load().places : {};
  const byEngine = {};
  for (const engine of engines.list()) byEngine[engine.id] = { id: engine.id, label: engine.label, installed: engine.installed, servers: 0, players: 0, games: 0 };
  const gamesSeen = new Set();
  for (const server of servers) {
    // The year the server runs (a player may have picked another than the game's).
    const engine = engines.known(server.engine) || places.engineOf(library[String(server.placeId)]);
    const slot = byEngine[engine] || (byEngine[engine] = { id: engine, label: engine, installed: false, servers: 0, players: 0, games: 0 });
    if (server.state === 'running') slot.servers++;
    slot.players += Array.isArray(server.players) ? server.players.length : 0;
    // A game with servers of two years counts under both.
    const key = `${engine}:${server.placeId}`;
    if (!gamesSeen.has(key)) { gamesSeen.add(key); slot.games++; }
  }
  const list = Object.values(byEngine);
  return {
    up,
    players: list.reduce((sum, slot) => sum + slot.players, 0),
    servers: list.reduce((sum, slot) => sum + slot.servers, 0),
    engines: list,
  };
}

function sample() {
  const now = current();
  if (!now.up) return;
  const data = readHistory();
  const t = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  let bucket = data.buckets[data.buckets.length - 1];
  if (!bucket || bucket.t !== t) {
    bucket = { t, players: 0, servers: 0, engines: {} };
    data.buckets.push(bucket);
    const oldest = Date.now() - HISTORY_DAYS * 86400 * 1000;
    while (data.buckets.length && data.buckets[0].t < oldest) data.buckets.shift();
  }
  bucket.players = Math.max(bucket.players, now.players);
  bucket.servers = Math.max(bucket.servers, now.servers);
  for (const engine of now.engines) bucket.engines[engine.id] = Math.max(bucket.engines[engine.id] || 0, engine.players);
  historyDirty = true;
}

let sampling = false;
function startSampling() {
  if (sampling) return;
  sampling = true;
  const first = setTimeout(sample, 5000);
  if (first.unref) first.unref();
  const timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();
  const saver = setInterval(saveHistory, 5 * 60 * 1000);
  if (saver.unref) saver.unref();
}

// What needs a look: servers that broke, games that couldn't start, runner problems.
function problems() {
  const runner = places.runnerStatus();
  const out = [];
  if (!runner || runner.stale) out.push({ kind: 'runner', text: "The always-on server isn't running." });
  if (!runner) return out;
  const library = places.exists() ? places.load().places : {};
  const nameOf = (placeId) => (library[placeId] && library[placeId].name) || `Place ${placeId}`;
  for (const problem of runner.problems || []) out.push({ kind: 'runner', text: String(problem) });
  if (!runner.stale) {
    for (const server of Object.values(runner.servers || {})) {
      if (server.state === 'error') out.push({ kind: 'server', placeId: String(server.placeId), name: nameOf(String(server.placeId)), jobId: server.jobId, text: server.lastError || "didn't start" });
    }
  }
  const dayAgo = Date.now() - 86400 * 1000;
  for (const failure of runner.startFailures || []) {
    if (Date.parse(failure.at) < dayAgo) continue;
    const placeId = /^\d{1,15}$/.test(String(failure.id)) ? String(failure.id) : null;
    out.push({ kind: 'start', placeId, name: placeId ? nameOf(placeId) : null, text: String(failure.error || ''), at: failure.at });
  }
  return out;
}

// --- HTTP ----------------------------------------------------------------------------------

module.exports = function manageApi({ send, sendJson, sendFile, jsonBody }) {
  startSampling();
  assetsearch.start();

  function page(ctx, match) {
    const name = (match[1] || 'index.html').toLowerCase();
    const ext = name.split('.').pop();
    const file = path.join(PAGE_DIR, name);
    if (!PAGE_TYPES[ext] || path.dirname(file) !== PAGE_DIR || !core.isFile(file)) return send(ctx, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    return sendFile(ctx, file, { 'Content-Type': PAGE_TYPES[ext], 'Cache-Control': 'no-cache' });
  }

  async function api(ctx, match) {
    if (!admin.allowed(ctx)) return sendJson(ctx, 403, admin.DENIED);
    const parts = match[1].split('/').filter(Boolean).map((part) => part.toLowerCase());
    const [area, id, action, extra] = parts;

    if (area === 'overview' && parts.length === 1) {
      if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
      return sendJson(ctx, 200, {
        now: current(),
        history: readHistory().buckets,
        bucketMinutes: BUCKET_MS / 60000,
        problems: problems(),
        errors: recentErrors(60),
        convertReports: reportCounts(),
        assetSearch: assetsearch.summary(),
      });
    }

    if (area === 'games' && /^\d{1,15}$/.test(id || '') && parts.length === 3) {
      if (!places.get(id)) return sendJson(ctx, 404, { error: 'no such place' });
      if (action === 'log') {
        if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
        const lines = Math.min(2000, Math.max(20, Number(ctx.queryLower.lines) || 400));
        return sendJson(ctx, 200, { lines: gameLog(id, lines) });
      }
      if (action === 'report') {
        if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
        return sendJson(ctx, 200, { report: readReport(id) });
      }
      if (action === 'client-years') {
        if (ctx.method === 'GET') return sendJson(ctx, 200, clientYearsOf(id));
        if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use GET or POST' });
        const body = await jsonBody(ctx);
        const years = Array.isArray(body.years) ? [...new Set(body.years.map(String).filter((year) => engines.known(year)))] : null;
        if (!years) return sendJson(ctx, 400, { error: 'years must be a list such as ["2016", "2017"]' });
        const all = readClientYears();
        all[id] = years;
        fs.mkdirSync(DATA, { recursive: true });
        if (!core.writeFileAtomic(CLIENT_YEARS, JSON.stringify(all, null, 2))) return sendJson(ctx, 500, { error: 'could not save' });
        return sendJson(ctx, 200, clientYearsOf(id));
      }
    }

    if (area === 'asset-search') {
      if (parts.length === 1) {
        if (ctx.method === 'GET') return sendJson(ctx, 200, assetsearch.status());
        if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use GET or POST' });
        const body = await jsonBody(ctx);
        if (typeof body.paused === 'boolean') assetsearch.setPaused(body.paused);
        return sendJson(ctx, 200, assetsearch.summary());
      }
      if (!/^\d{1,15}$/.test(id || '')) return sendJson(ctx, 404, { error: 'unknown asset search call' });
      if (action === 'search' && parts.length === 3) {
        if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
        assetsearch.searchNow(id);
        return sendJson(ctx, 200, { ok: true });
      }
      if (/^\d{1,3}$/.test(action || '') && parts.length === 3) {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return sendJson(ctx, 405, { error: 'use GET' });
        const file = assetsearch.filePath(id, action);
        if (!file) return sendJson(ctx, 404, { error: 'That copy is no longer waiting.' });
        return sendFile(ctx, file, { 'Content-Type': PREVIEW_TYPES[file.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' });
      }
      if (/^\d{1,3}$/.test(action || '') && (extra === 'approve' || extra === 'reject') && parts.length === 4) {
        if (ctx.method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
        if (extra === 'reject') return assetsearch.reject(id, action) ? sendJson(ctx, 200, { ok: true }) : sendJson(ctx, 404, { error: 'That copy is no longer waiting.' });
        const result = assetsearch.approve(id, action);
        return result.error ? sendJson(ctx, 400, result) : sendJson(ctx, 200, result);
      }
    }
    return sendJson(ctx, 404, { error: 'unknown manage API call' });
  }

  return {
    routes: [
      [/^manage(?:\/([a-z0-9-]+\.(?:js|css|html)))?\/?$/i, page],
      [/^api\/manage\/((?:overview|games|asset-search)(?:\/[a-z0-9-]+){0,3})\/?$/i, api],
    ],
  };
};

module.exports.clientYearsOf = clientYearsOf;
