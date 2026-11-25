#!/usr/bin/env node
'use strict';

// Test corpus for the place converter. For each place and each engine (2016,
// 2017, 2018) it converts the place for that engine, then checks the result
// in a throwaway game server of that year (Webserver/node/lib/convertcheck.js):
// every script compiled there, the place loaded, and the place run headless
// for a while with its script errors collected. Place files stay in the
// corpus folder, outside the repo; never commit them.
//
//   node tools/converter-corpus.js add <file or folder>...
//       hard-links (or copies) .rbxl/.rbxlx files into <corpus>/originals and
//       lists them in <corpus>/corpus.json (the same file twice is kept once)
//   node tools/converter-corpus.js run --label <name> [options]
//       results in <corpus>/results/<name>.json, one report per place and
//       engine (lib/convertreport.js format) in <corpus>/reports/<name>/
//   node tools/converter-corpus.js table <label> [<label after>]
//       a markdown table of the results (before -> after)
//   node tools/converter-corpus.js errors <label> [--engine <year>]
//       the most common errors across the corpus
//
// Options:
//   --corpus <dir>      the corpus folder (default: env CONVERTER_CORPUS, or
//                       a converter-corpus folder next to the repo or above it)
//   --game-root <dir>   folder with Server, Server2016, Server2018 (default:
//                       env RBX_GAME_ROOT, the repo, or a RobloxClient folder
//                       next to it); copied into <corpus>/engines as hard links
//   --converter <dir>   the Webserver/node folder whose converter is tested
//                       (default: this repo's); an older one converts for 2017
//                       only and its output is checked on every engine
//   --api-dumps <dir>   API dumps api<year>.txt for the converter (env RBX_API_DUMPS;
//                       default <corpus>/api)
//   --engines 2016,2017,2018   --only <id,...>   --skip <id,...>   --max-mb <n>
//   --seconds <n>       how long each place runs (default 20)
//   --jobs <n>          checks at once (default 3)
//   --ports <n>         first SOAP port (default 64940; give runs side by side their own)
//   --redo              check again what the results file already has

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const NODE_DIR = path.join(REPO, 'Webserver', 'node');
const ENGINES = ['2016', '2017', '2018'];
const SERVER_FOLDER = { 2016: 'Server2016', 2017: 'Server', 2018: 'Server2018' };

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (['redo', 'keep', 'all'].includes(name)) options[name] = true;
      else options[name] = argv[++i];
    } else {
      options._.push(arg);
    }
  }
  return options;
}

function firstDir(candidates, test) {
  for (const dir of candidates) {
    if (dir && test(dir)) return path.resolve(dir);
  }
  return null;
}

function corpusDir(options) {
  const dir = firstDir([options.corpus, process.env.CONVERTER_CORPUS, path.join(REPO, '..', 'converter-corpus'), path.join(REPO, '..', '..', 'converter-corpus')],
    (d) => fs.existsSync(d));
  if (!dir) throw new Error('No corpus folder: make one (e.g. next to the repo, named converter-corpus) or pass --corpus.');
  return dir;
}

function gameRoot(options) {
  const dir = firstDir([options['game-root'], process.env.RBX_GAME_ROOT, REPO, path.join(REPO, '..', 'RobloxClient'), path.join(REPO, '..', '..', 'RobloxClient')],
    (d) => fs.existsSync(path.join(d, 'Server', 'RCCService.exe')));
  if (!dir) throw new Error('No game folders (Server/RCCService.exe): pass --game-root.');
  return dir;
}

function slug(name) {
  return name.toLowerCase().replace(/\.(rbxlx?)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'place';
}

function readManifest(corpus) {
  const file = path.join(corpus, 'corpus.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { places: [] };
}

function writeManifest(corpus, manifest) {
  fs.writeFileSync(path.join(corpus, 'corpus.json'), `${JSON.stringify(manifest, null, 1)}\n`);
}

function sha1File(file) {
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(16 * 1024 * 1024);
  try {
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function placeFiles(target, depth = 0) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return /\.rbxlx?$/i.test(target) ? [target] : [];
  if (!stat.isDirectory() || depth > 3) return [];
  const out = [];
  for (const name of fs.readdirSync(target)) {
    try { out.push(...placeFiles(path.join(target, name), depth + 1)); } catch (error) { /* unreadable */ }
  }
  return out;
}

function add(options) {
  const corpus = corpusDir(options);
  const manifest = readManifest(corpus);
  const originals = path.join(corpus, 'originals');
  fs.mkdirSync(originals, { recursive: true });
  const bySha = new Map(manifest.places.map((p) => [p.sha1, p]));
  const ids = new Set(manifest.places.map((p) => p.id));
  let added = 0;
  for (const target of options._) {
    for (const file of placeFiles(path.resolve(target))) {
      const sha1 = sha1File(file);
      if (bySha.has(sha1)) continue;
      const ext = path.extname(file).toLowerCase().slice(1);
      let id = `${slug(path.basename(file))}-${ext}`;
      for (let n = 2; ids.has(id); n++) id = `${slug(path.basename(file))}-${ext}-${n}`;
      const stored = path.join(originals, `${id}.${ext}`);
      try { fs.linkSync(file, stored); } catch (error) { fs.copyFileSync(file, stored); }
      const place = { id, name: path.basename(file).replace(/\.rbxlx?$/i, ''), file: `originals/${id}.${ext}`, source: file, bytes: fs.statSync(file).size, sha1 };
      manifest.places.push(place);
      bySha.set(sha1, place);
      ids.add(id);
      added++;
    }
  }
  manifest.places.sort((a, b) => a.bytes - b.bytes);
  writeManifest(corpus, manifest);
  console.log(`${added} added, ${manifest.places.length} in the corpus`);
}

// --- Engines -------------------------------------------------------------------------------

function linkTree(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (skip(a, entry)) continue;
    if (entry.isDirectory()) linkTree(a, b, skip);
    else if (!fs.existsSync(b)) {
      try { fs.linkSync(a, b); } catch (error) { fs.copyFileSync(a, b); }
    }
  }
}

// RCC flags as the web server serves them (lib/routes.js rccSettings): the
// switched-off 2017 features on. The 2016 RCC never asks the web server, so
// it keeps its own file.
function servedFlags() {
  const source = fs.readFileSync(path.join(NODE_DIR, 'lib', 'routes.js'), 'utf8');
  const block = /const FEATURE_FLAGS = \[([\s\S]*?)\];/.exec(source);
  const flags = { FFlagDebugLocalRccServerConnection: true, DFFlagDebugLocalRccServerConnection: true };
  for (const match of (block ? block[1] : '').replace(/\/\/.*$/gm, '').matchAll(/'(\w+)'/g)) {
    flags[`FFlag${match[1]}`] = true;
    flags[`DFFlag${match[1]}`] = true;
  }
  return flags;
}

// <corpus>/engines/rcc<year>: a hard-linked copy of that year's game server.
function engineDir(corpus, root, engine) {
  const from = path.join(root, SERVER_FOLDER[engine]);
  const to = path.join(corpus, 'engines', `rcc${engine}`);
  if (!fs.existsSync(path.join(from, 'RCCService.exe'))) throw new Error(`No ${SERVER_FOLDER[engine]}/RCCService.exe in ${root}`);
  const stale = !fs.existsSync(path.join(to, 'RCCService.exe'))
    || fs.statSync(path.join(to, 'RCCService.exe')).size !== fs.statSync(path.join(from, 'RCCService.exe')).size;
  if (stale) {
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    linkTree(from, to, (file, entry) => entry.isDirectory() && (/[\\/]content[\\/]places$/.test(file) || /[\\/]internalscripts$/.test(file) || entry.name === 'ClientSettings' || entry.name === 'logs'));
    const settings = path.join(to, 'ClientSettings');
    fs.mkdirSync(settings, { recursive: true });
    const own = path.join(from, 'ClientSettings', 'RCCService.json');
    const base = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8').replace(/^﻿/, '')) : {};
    const flags = engine === '2016' ? base : Object.assign(base, servedFlags());
    const text = JSON.stringify(flags, null, 1);
    fs.writeFileSync(path.join(settings, 'RCCService.json'), text);
    if (engine === '2017') fs.writeFileSync(path.join(settings, 'RCCServiceRCCService.json'), text);
  }
  return to;
}

// --- Converting (in a child process each: big places need a big heap) ---------------------------

function converterInfo(dir) {
  const placefile = path.join(dir, 'lib', 'placefile.js');
  const text = fs.existsSync(placefile) ? fs.readFileSync(placefile, 'utf8') : '';
  return { dir, perEngine: /ENGINE_TARGETS/.test(text), hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 10) };
}

async function convertOne(options) {
  const converter = path.resolve(options.converter || NODE_DIR);
  if (options['api-dumps']) process.env.RBX_API_DUMPS = path.resolve(options['api-dumps']);
  const rbxbinary = require(path.join(converter, 'lib', 'rbxbinary'));
  const placefile = require(path.join(converter, 'lib', 'placefile'));
  const scriptsOf = placefile.scriptsOf || require(path.join(NODE_DIR, 'lib', 'placefile')).scriptsOf;
  const started = Date.now();
  const read = rbxbinary.placeXml(fs.readFileSync(options.in));
  const result = placefile.convertPlace(read.xml, { engine: options.engine, unionShapes: new Map() });
  const stored = rbxbinary.placeToStore(result.output);
  // Each changed script with its source from before (to tell whether a
  // compile error is the converter's).
  const before = new Map();
  const seen = new Map();
  const key = (s) => { const n = (seen.get(s.path) || 0) + 1; seen.set(s.path, n); return `${s.path}#${n}`; };
  for (const s of scriptsOf(read.xml)) before.set(key(s), s.source);
  seen.clear();
  const scripts = scriptsOf(result.output).map((s) => {
    const original = before.get(key(s));
    return Object.assign({ path: s.path, className: s.className, source: s.source }, original !== undefined && original !== s.source ? { original } : {});
  });
  const counts = {};
  for (const [key, value] of Object.entries(result.counts)) {
    counts[key] = value instanceof Map ? Object.fromEntries(value) : value instanceof Set ? [...value] : value;
  }
  counts.engine = options.engine;
  const out = options.out;
  fs.writeFileSync(`${out}.place`, stored.bytes);
  fs.writeFileSync(`${out}.scripts.json`, JSON.stringify(scripts));
  fs.writeFileSync(`${out}.convert.json`, JSON.stringify({ ms: Date.now() - started, summary: [...read.notes, ...result.summary, ...stored.notes], counts }));
}

function runChild(args, logFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=16000', __filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => {
      if (logFile && output) fs.writeFileSync(logFile, output);
      resolve({ code, output });
    });
  });
}

// --- Running -------------------------------------------------------------------------------

function list(value) {
  return value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : null;
}

async function run(options) {
  const corpus = corpusDir(options);
  const label = options.label;
  if (!label || !/^[\w.-]+$/.test(label)) throw new Error('--label <name> (letters, digits, . - _)');
  const root = gameRoot(options);
  const converter = converterInfo(path.resolve(options.converter || NODE_DIR));
  const apiDumps = path.resolve(options['api-dumps'] || process.env.RBX_API_DUMPS || path.join(corpus, 'api'));
  const engines = list(options.engines) || ENGINES;
  const only = list(options.only);
  const skip = list(options.skip) || [];
  const maxBytes = options['max-mb'] ? Number(options['max-mb']) * 1024 * 1024 : Infinity;
  const seconds = Number(options.seconds || 20);
  const jobs = Math.max(1, Number(options.jobs || 3));
  // SOAP ports from here (two per check), game ports 11100 below.
  const ports = Number(options.ports || 64940);
  const manifest = readManifest(corpus);
  const places = manifest.places.filter((p) => (!only || only.some((o) => p.id === o || p.id.includes(o))) && !skip.some((s) => p.id === s) && p.bytes <= maxBytes);
  const dirs = {};
  for (const engine of engines) dirs[engine] = engineDir(corpus, root, engine);

  const resultsDir = path.join(corpus, 'results');
  const reportsDir = path.join(corpus, 'reports', label);
  const work = path.join(corpus, 'work', label);
  for (const dir of [resultsDir, reportsDir, work]) fs.mkdirSync(dir, { recursive: true });
  const resultsFile = path.join(resultsDir, `${label}.json`);
  const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
    : { label, converter: converter.dir, converterHash: converter.hash, perEngine: converter.perEngine, seconds, startedAt: new Date().toISOString(), places: {} };
  const save = () => fs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 1)}\n`);

  const convertreport = require(path.join(NODE_DIR, 'lib', 'convertreport'));
  const convertcheck = require(path.join(NODE_DIR, 'lib', 'convertcheck'));

  // Conversions: one per place (an older converter, the same for every engine) or per engine.
  const converted = new Map(); // key -> Promise<{ base, info } | { error }>
  let bigBusy = Promise.resolve();
  const convert = (place, engine) => {
    const target = converter.perEngine ? engine : 'any';
    const key = `${place.id}|${target}`;
    if (!converted.has(key)) {
      const base = path.join(work, `${place.id}.${target}`);
      const go = async () => {
        const res = await runChild(['convert', '--converter', converter.dir, '--api-dumps', apiDumps, '--engine', converter.perEngine ? engine : '2017',
          '--in', path.join(corpus, place.file), '--out', base], `${base}.log`);
        if (res.code !== 0) return { error: (res.output.trim().split('\n').pop() || `exit ${res.code}`).slice(0, 300) };
        return { base, info: JSON.parse(fs.readFileSync(`${base}.convert.json`, 'utf8')) };
      };
      // Places over 150 MB convert one at a time.
      let promise;
      if (place.bytes > 150 * 1024 * 1024) {
        promise = bigBusy.then(go, go);
        bigBusy = promise.catch(() => {});
      } else {
        promise = go();
      }
      converted.set(key, promise);
    }
    return converted.get(key);
  };

  const tasks = [];
  for (const place of places) {
    for (const engine of engines) {
      if (!options.redo && results.places[place.id] && results.places[place.id][engine]) continue;
      tasks.push({ place, engine });
    }
  }
  console.log(`${tasks.length} checks (${places.length} places x ${engines.join('/')}), ${jobs} at a time, converter ${converter.dir}${converter.perEngine ? '' : ' (2017 only)'}`);
  let next = 0;
  let done = 0;
  const worker = async (slot) => {
    while (next < tasks.length) {
      const { place, engine } = tasks[next++];
      const t0 = Date.now();
      const conversion = await convert(place, engine);
      const entry = { converted: !conversion.error, convertError: conversion.error || null };
      if (!conversion.error) {
        entry.convertMs = conversion.info.ms;
        const scripts = JSON.parse(fs.readFileSync(`${conversion.base}.scripts.json`, 'utf8'));
        const check = await convertcheck.check({
          engine, rccDir: dirs[engine], place: fs.readFileSync(`${conversion.base}.place`), scripts, seconds,
          soapPort: ports + slot * 2, gamePort: ports - 11100 + slot,
        });
        const report = convertreport.build({ placeId: 0, engine, counts: conversion.info.counts, check });
        report.placeId = place.id;
        fs.writeFileSync(path.join(reportsDir, `${place.id}.${engine}.json`), `${JSON.stringify(report, null, 1)}\n`);
        Object.assign(entry, {
          loads: check.loads, loadError: check.loadError, loadMs: check.loadMs, scripts: check.scripts, compiled: check.compiled,
          scriptsFailed: check.scriptsFailed, runErrors: check.runErrors.length, hung: check.hung, crashed: check.crashed,
          compileErrors: check.compileErrors, errors: check.runErrors, engineErrors: (check.engineErrors || []).length, player: check.player, warnings: check.warnings.slice(0, 40), log: check.log,
          issues: report.issues.filter((i) => i.kind !== 'compile' && i.kind !== 'runtime').slice(0, 60),
        });
      }
      entry.ms = Date.now() - t0;
      (results.places[place.id] = results.places[place.id] || {})[engine] = entry;
      save();
      done++;
      const status = entry.converted
        ? `${entry.loads ? 'loads' : `NO LOAD${entry.loadError ? ` (${String(entry.loadError).slice(0, 80)})` : ''}`}, ${entry.scriptsFailed === null ? '?' : entry.scriptsFailed}/${entry.scripts} fail to compile, ${entry.runErrors} run errors${entry.hung ? ', HUNG' : ''}${entry.crashed ? ', CRASHED' : ''}`
        : `CONVERT FAILED: ${entry.convertError}`;
      console.log(`[${done}/${tasks.length}] ${place.id} ${engine}: ${status} (${Math.round(entry.ms / 1000)} s)`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, (x, slot) => worker(slot)));
  if (!options.keep) {
    for (const name of fs.readdirSync(work)) if (/\.(place|scripts\.json)$/.test(name)) fs.rmSync(path.join(work, name), { force: true });
  }
  results.finishedAt = new Date().toISOString();
  save();
}

// --- Tables -------------------------------------------------------------------------------

// Results of one label, or several joined ("before,before-2018").
function loadResults(corpus, labels) {
  const merged = { places: {} };
  for (const label of String(labels).split(',')) {
    const one = JSON.parse(fs.readFileSync(path.join(corpus, 'results', `${label}.json`), 'utf8'));
    for (const [id, byEngine] of Object.entries(one.places)) merged.places[id] = Object.assign(merged.places[id] || {}, byEngine);
  }
  return merged;
}

// Errors from the check's surroundings, not the converter: the throwaway
// server has no place ID, no web server of its own and no players.
const ENVIRONMENT = [
  /publish this place to the web/i, /LuaWebService/i, /\bHTTP \d{3}\b/, /Http(?:Service)? requests? (?:are|is) not (?:enabled|allowed)/i, /HttpError/i,
  /Unable to find module for asset id/i, /Failed to load (?:animation|sound|asset)/i, /DataStore/i, /GetProductInfo/i, /TeleportService/i,
  /Can't parse JSON/i, /LocalPlayer/, /InsertService/i, /LoadAsset/i, /Unable to fetch/i, /trust check failed/i, /not allowed to access/i,
  /Infinite yield possible/i,
];
function environmental(message) {
  return ENVIRONMENT.some((pattern) => pattern.test(String(message)));
}
function runErrorCount(entry) {
  return (entry.errors || []).filter((e) => !environmental(e.message)).length;
}

function cell(entry) {
  if (!entry) return '';
  if (!entry.converted) return 'convert ✗';
  if (entry.loads === false || entry.loads === null) return `load ✗${entry.hung ? ' (hung)' : ''}${entry.crashed ? ' (crash)' : ''}`;
  const failed = entry.scriptsFailed === null ? '?' : entry.scriptsFailed;
  const broke = (entry.compileErrors || []).filter((e) => e.byConverter).length;
  return `${failed}c${broke ? ` (${broke} by converter)` : ""} ${runErrorCount(entry)}r`;
}

function score(entry) {
  if (!entry) return null;
  if (!entry.converted || !entry.loads) return 1000;
  return (entry.scriptsFailed || 0) * 3 + runErrorCount(entry);
}

function table(options) {
  const corpus = corpusDir(options);
  const [beforeLabel, afterLabel] = options._;
  const load = (label) => loadResults(corpus, label);
  const before = load(beforeLabel);
  const after = afterLabel ? load(afterLabel) : null;
  const manifest = readManifest(corpus);
  const engines = ENGINES.filter((e) => Object.values(before.places).some((p) => p[e]) || (after && Object.values(after.places).some((p) => p[e])));
  const lines = [];
  lines.push(`| Place | MB | ${engines.map((e) => (after ? `${e} before → after` : e)).join(' | ')} |`);
  lines.push(`|---|---:|${engines.map(() => '---').join('|')}|`);
  const totals = {};
  for (const place of manifest.places) {
    const b = before.places[place.id];
    const a = after ? after.places[place.id] : null;
    if (!b && !a) continue;
    const cells = engines.map((e) => {
      const t = (totals[e] = totals[e] || { places: 0, loadsBefore: 0, loadsAfter: 0, compileBefore: 0, compileAfter: 0, runBefore: 0, runAfter: 0, clean: [0, 0] });
      const be = b && b[e];
      const ae = a && a[e];
      if (be && (!after || ae)) {
        t.places++;
        if (be.loads) t.loadsBefore++;
        t.compileBefore += be.scriptsFailed || 0;
        t.runBefore += runErrorCount(be);
        if (score(be) === 0) t.clean[0]++;
        if (ae) {
          if (ae.loads) t.loadsAfter++;
          t.compileAfter += ae.scriptsFailed || 0;
          t.runAfter += runErrorCount(ae);
          if (score(ae) === 0) t.clean[1]++;
        }
      }
      return after ? `${cell(be)} → ${cell(ae)}` : cell(be);
    });
    lines.push(`| ${place.name.replace(/\|/g, '/')} (${path.extname(place.file).slice(1)}) | ${(place.bytes / 1048576).toFixed(1)} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('Cells: `<scripts that fail to compile>c <distinct script errors while running>r`; "load ✗" = the place did not load. '
    + 'Errors from the test setup (no web server, data stores or players) are left out.');
  lines.push('');
  for (const [e, t] of Object.entries(totals)) {
    lines.push(after
      ? `- ${e}: ${t.places} places; loads ${t.loadsBefore} → ${t.loadsAfter}; scripts failing to compile ${t.compileBefore} → ${t.compileAfter}; run errors ${t.runBefore} → ${t.runAfter}; places with no errors ${t.clean[0]} → ${t.clean[1]}`
      : `- ${e}: ${t.places} places; loads ${t.loadsBefore}; scripts failing to compile ${t.compileBefore}; run errors ${t.runBefore}; places with no errors ${t.clean[0]}`);
  }
  console.log(lines.join('\n'));
}

// The most common errors (messages with numbers, names and quotes made generic).
function errors(options) {
  const corpus = corpusDir(options);
  const results = loadResults(corpus, options._[0]);
  const engines = list(options.engine) || ENGINES;
  const generic = (m) => String(m).replace(/^[^:]*:\d+: /, '').replace(/\[string "[^"]*"\]:\d+: /, '').replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'").replace(/\d+(\.\d+)?/g, 'N').slice(0, 160);
  const groups = new Map();
  for (const [id, byEngine] of Object.entries(results.places)) {
    for (const engine of engines) {
      const entry = byEngine[engine];
      if (!entry || !entry.converted) continue;
      const items = [
        ...(entry.compileErrors || []).map((e) => ({ kind: e.byConverter ? 'compile(converter)' : 'compile', message: e.error, path: e.path })),
        ...(entry.errors || []).filter((e) => options.all || !environmental(e.message)).map((e) => ({ kind: 'run', message: e.message, path: e.path })),
        ...(entry.loads ? [] : [{ kind: 'load', message: entry.loadError || 'did not load', path: '' }]),
      ];
      for (const item of items) {
        const key = `${item.kind} ${generic(item.message)}`;
        const group = groups.get(key) || { key, places: new Set(), count: 0, example: `${id} ${engine} ${item.path}: ${String(item.message).slice(0, 200)}` };
        group.places.add(`${id}@${engine}`);
        group.count++;
        groups.set(key, group);
      }
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.places.size - a.places.size || b.count - a.count);
  for (const g of sorted.slice(0, Number(options.top || 60))) {
    console.log(`${String(g.places.size).padStart(3)} places ${String(g.count).padStart(4)}x  ${g.key}\n      e.g. ${g.example}`);
  }
}

// Runs Lua (a file or the text itself) in a fresh RCC of each engine and
// prints what it returns: for checking an engine fact before relying on it.
async function probe(options) {
  const corpus = corpusDir(options);
  const root = gameRoot(options);
  const convertcheck = require(path.join(NODE_DIR, 'lib', 'convertcheck'));
  const sources = options._.map((arg) => (fs.existsSync(arg) ? fs.readFileSync(arg, 'latin1') : arg));
  for (const [n, engine] of (list(options.engines) || ENGINES).entries()) {
    const rcc = new convertcheck.Rcc(engine, engineDir(corpus, root, engine), 64990 - n * 2);
    try {
      await rcc.start();
      for (const source of sources) console.log(`${engine}: ${await rcc.run(source)}`);
    } catch (error) {
      console.log(`${engine}: ${error.message}`);
    } finally {
      rcc.stop();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._.shift();
  if (command === 'probe') return probe(options);
  if (command === 'add') return add(options);
  if (command === 'run') return run(options);
  if (command === 'table') return table(options);
  if (command === 'errors') return errors(options);
  if (command === 'convert') return convertOne(options);
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 37).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  return null;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});

module.exports = { slug, cell };
