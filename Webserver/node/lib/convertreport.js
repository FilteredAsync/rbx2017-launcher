'use strict';

// Converter reports: what may still be wrong with a converted place, per game
// (/manage shows it). One file per game, replaced on each conversion:
//
//   data/convert-reports/<placeId>.json = {
//     placeId, engine, convertedAt, converterVersion,
//     checks: { loads, scripts, scriptsFailed, runErrors },
//     issues: [{ severity: 'error'|'warning'|'info', kind, path, message }] }
//
// checks come from a run in a throwaway game server (lib/convertcheck.js);
// null where that has not run (yet). converterVersion changes whenever the
// converter's code does (a hash of its files).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');

const REPORTS_DIR = path.join(__dirname, '..', 'data', 'convert-reports');
const CONVERTER_FILES = ['placefile.js', 'luacompat.js', 'luaulower.js', 'attributes.js', 'unionshapes.js', 'gamepatches.js', 'rbxbinary.js', 'apidump.js'];
const MAX_ISSUES = 300;

let version = null;
function converterVersion() {
  if (version === null) {
    const hash = crypto.createHash('sha1');
    for (const name of CONVERTER_FILES) {
      try { hash.update(fs.readFileSync(path.join(__dirname, name))); } catch (error) { hash.update(`no ${name}`); }
    }
    version = hash.digest('hex').slice(0, 12);
  }
  return version;
}

// Issues from what the converter counted (lib/placefile.js convertPlace counts).
function conversionIssues(counts) {
  const issues = [];
  if (!counts) return issues;
  const add = (severity, kind, pathName, message) => issues.push({ severity, kind, path: pathName || '', message });
  if (counts.apiDumpMissing) add('warning', 'api', '', `No API list for ${counts.engine}; converted with 2017's`);
  for (const entry of counts.luauScripts || []) {
    const colon = entry.lastIndexOf(': ');
    add('error', 'luau', colon > 0 ? entry.slice(0, colon) : entry, `Luau syntax left: ${colon > 0 ? entry.slice(colon + 2) : '?'}`);
  }
  const unknown = counts.unknownClasses instanceof Map ? [...counts.unknownClasses] : Object.entries(counts.unknownClasses || {});
  for (const [name, n] of unknown.sort((a, b) => b[1] - a[1])) {
    add('warning', 'class', name, `${name} x${n}: no such class in ${counts.engine || '2017'}, skipped`);
  }
  if (counts.newCsg > 0) add('warning', 'union', '', `${counts.newCsg} unions in the newer format won't show`);
  const names = counts.gameAssetNames instanceof Set ? [...counts.gameAssetNames] : counts.gameAssetNames || [];
  if (names.length > 0 && !counts.gameAssets) add('warning', 'assets', '', `${names.length} rbxgameasset:// images need the game's universe ID`);
  const thumbs = counts.unsupportedThumbnails instanceof Set ? [...counts.unsupportedThumbnails] : counts.unsupportedThumbnails || [];
  if (thumbs.length > 0) add('info', 'thumbnail', '', `rbxthumb types left as they were: ${thumbs.join(', ')}`);
  if (counts.chatSetAside > 0) add('info', 'chat', 'Chat', 'Newer chat set aside; the game uses the built-in chat');
  if (counts.coreGuiSetAside > 0) add('info', 'coregui', 'StarterGui.RobloxGui', 'Saved copy of Roblox UI set aside');
  return issues;
}

// checks and issues from a lib/convertcheck.js result.
function checkIssues(result) {
  if (!result) return { checks: { loads: null, scripts: null, scriptsFailed: null, runErrors: null }, issues: [] };
  const issues = [];
  if (result.loads === false) issues.push({ severity: 'error', kind: 'load', path: '', message: result.loadError ? `Doesn't load: ${result.loadError}` : "Doesn't load" });
  if (result.crashed) issues.push({ severity: 'error', kind: 'crash', path: '', message: 'The game server crashed' });
  else if (result.hung) issues.push({ severity: 'error', kind: 'hang', path: '', message: 'The game server stopped answering' });
  for (const e of result.compileErrors || []) {
    // unchanged: the converter left the script as it was (same error in the original).
    issues.push({ severity: e.unchanged ? 'warning' : 'error', kind: 'compile', path: e.path, message: e.unchanged ? `${e.error} (as in the original)` : e.error });
  }
  for (const e of result.runErrors || []) {
    issues.push({ severity: 'error', kind: 'runtime', path: e.path || '', message: `${e.message}${e.count > 1 ? ` (x${e.count})` : ''}` });
  }
  const runErrors = result.loads ? (result.runErrors || []).length : null;
  return {
    checks: {
      loads: result.loads === undefined ? null : result.loads,
      scripts: result.scripts === undefined ? null : result.scripts,
      scriptsFailed: result.scriptsFailed === undefined ? null : result.scriptsFailed,
      runErrors,
    },
    issues,
  };
}

const ORDER = { error: 0, warning: 1, info: 2 };
function build({ placeId, engine, convertedAt, counts, check }) {
  const fromCheck = checkIssues(check);
  const issues = [...fromCheck.issues, ...conversionIssues(counts)]
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
    .slice(0, MAX_ISSUES);
  return {
    placeId: String(placeId),
    engine: String(engine || '2017'),
    convertedAt: convertedAt || new Date().toISOString(),
    converterVersion: converterVersion(),
    checks: fromCheck.checks,
    issues,
  };
}

function reportFile(placeId) {
  return /^\d{1,15}$/.test(String(placeId)) ? path.join(REPORTS_DIR, `${placeId}.json`) : null;
}

function write(placeId, report) {
  const file = reportFile(placeId);
  if (!file) return false;
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  return core.writeFileAtomic(file, `${JSON.stringify(report, null, 1)}\n`);
}

function read(placeId) {
  const file = reportFile(placeId);
  return file ? core.readJsonFile(file) : null;
}

module.exports = { build, write, read, converterVersion, conversionIssues, checkIssues, REPORTS_DIR };
