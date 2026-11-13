'use strict';

// Server updates: signed packages (.rbxupd) of new server files.
//   public   this repository's own server code, published with the GitHub
//            releases (RobloxServer-update-<build>.rbxupd); the always-on
//            server looks for a newer one every few hours.
//   private  files that cannot be published (game-server scripts, the
//            client download...), uploaded on /manage with the host key.
// tools/build-server-update.js makes them and signs them with
// config/update-signing-key.pem on the developer's PC. A server installs only
// packages signed with that key (PUBLIC_KEY below), so neither the host key
// nor access to GitHub is enough to change a server's code.
//
// A package is gzip of: "RBXUPD1\n", a 4-byte header length, the header
// (JSON: kind, build, label, notes, files with path, size and SHA-256, and
// "delete": files to remove, e.g. a script that was renamed), a
// 64-byte Ed25519 signature of the header, then the files one after another.
//
// Installing: dedicated.js stages a package in updates/staged/<kind>-<build>/,
// saves players and stops, and apply-update.js swaps the files in, starts the
// server again and puts the old files back if it does not come up.
// server-version.json (in the server folder) says what is installed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const core = require('./core');

const MAGIC = Buffer.from('RBXUPD1\n');
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMkcUrw3x7o0UwJlMv2+lFkUPP6pUBgwzCPUVoq4G4Jc=
-----END PUBLIC KEY-----
`;
const REPO = 'FilteredAsync/rbx2017-launcher';
const ASSET = /^RobloxServer-update-(\d{14})\.rbxupd$/;
const KINDS = new Set(['public', 'private']);
const DIR = core.rootPath('updates');
const STAGED = path.join(DIR, 'staged');
const RESULT_FILE = path.join(DIR, 'last-result.json');
const VERSION_FILE = core.rootPath('server-version.json');
const MAX_UNPACKED = 1536 * 1048576;

// Never written by an update: the server's data, settings, keys, saves and logs.
const PROTECTED = [
  /^webserver\/node\/(data|logs)(\/|$)/i,
  /^config\/(?!readme\.txt$)/i,
  /^cache(\/|$)/i,
  /^server\/content\/places(\/|$)/i,
  /^updates(\/|$)/i,
  /^server-version\.json$/i,
  /(^|\/)(host-key\.txt|roblox-api-key\.txt|\.roblosecurity|update-signing-key\.pem|[^/]*\.pid)$/i,
];

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// "Webserver/node/lib/core.js" -> the same, or null when an update may not write there.
function cleanPath(name) {
  const text = String(name || '').replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /^[a-z]:/i.test(text) || /[<>:"|?*\x00-\x1f]/.test(text)) return null;
  if (text.split('/').some((part) => part === '' || part === '.' || part === '..' || / $|\.$/.test(part))) return null;
  if (PROTECTED.some((pattern) => pattern.test(text))) return null;
  return text;
}

// 20261113183005 -> "2026-11-13 18:30" (UTC) when a package has no label.
function buildLabel(build) {
  const text = String(build);
  return /^\d{14}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)} UTC` : text;
}

// header: { kind, build, label, notes, delete: [paths], ... }, files: [{ path, data }],
// privateKey: KeyObject or PEM -> Buffer
function pack(header, files, privateKey) {
  const list = files.map((file) => {
    const clean = cleanPath(file.path);
    if (!clean) throw new Error(`an update may not contain ${file.path}`);
    return { path: clean, size: file.data.length, sha256: sha256(file.data) };
  });
  const remove = (header.delete || []).map((name) => {
    const clean = cleanPath(name);
    if (!clean) throw new Error(`an update may not delete ${name}`);
    if (list.some((file) => file.path.toLowerCase() === clean.toLowerCase())) throw new Error(`${name} is both added and deleted`);
    return clean;
  });
  const full = Object.assign({}, header, { format: 1, files: list, delete: remove });
  const headerBytes = Buffer.from(JSON.stringify(full), 'utf8');
  const signature = crypto.sign(null, headerBytes, privateKey);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return zlib.gzipSync(Buffer.concat([MAGIC, length, headerBytes, signature, ...files.map((file) => file.data)]), { level: 6 });
}

// A downloaded or uploaded package -> { header, files: [{ path, data }] }, or throws why it is refused.
function unpack(buffer, publicKey = PUBLIC_KEY) {
  let raw;
  try {
    raw = zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED });
  } catch (error) {
    throw new Error('this is not a server update file (it could not be unpacked)');
  }
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('this is not a server update file');
  const length = raw.readUInt32BE(MAGIC.length);
  let offset = MAGIC.length + 4;
  const headerBytes = raw.subarray(offset, offset + length);
  offset += length;
  const signature = raw.subarray(offset, offset + 64);
  offset += 64;
  if (headerBytes.length !== length || signature.length !== 64 || !crypto.verify(null, headerBytes, publicKey, signature)) {
    throw new Error('this update is not signed with the project\'s key, so it was not installed');
  }
  const header = JSON.parse(headerBytes.toString('utf8'));
  if (header.format !== 1 || !KINDS.has(header.kind) || !/^\d{14}$/.test(String(header.build)) || !Array.isArray(header.files)
    || (header.delete !== undefined && !Array.isArray(header.delete))) {
    throw new Error('this update was made by a newer or broken update builder');
  }
  for (const name of header.delete || []) {
    if (typeof name !== 'string' || !cleanPath(name)) throw new Error(`the update wants to delete ${name}, which updates may not touch`);
  }
  const files = [];
  for (const entry of header.files) {
    const clean = cleanPath(entry.path);
    if (!clean) throw new Error(`the update wants to change ${entry.path}, which updates may not touch`);
    const data = raw.subarray(offset, offset + entry.size);
    offset += entry.size;
    if (data.length !== entry.size || sha256(data) !== entry.sha256) throw new Error(`the update file is damaged (${entry.path})`);
    files.push({ path: clean, data });
  }
  if (offset !== raw.length) throw new Error('the update file is damaged (extra data at the end)');
  return { header, files };
}

function summary(header) {
  return {
    kind: header.kind,
    build: Number(header.build),
    label: header.label || buildLabel(header.build),
    notes: String(header.notes || '').slice(0, 2000),
    files: Array.isArray(header.files) ? header.files.length : 0,
    deletes: Array.isArray(header.delete) ? header.delete.length : 0,
    commit: header.commit || null,
  };
}

// What is installed: { public, private (builds, 0 = none), publicLabel, privateLabel, updatedAt }
function installed() {
  const data = core.readJsonFile(VERSION_FILE) || {};
  return {
    public: Number(data.public) || 0,
    private: Number(data.private) || 0,
    publicLabel: data.publicLabel || null,
    privateLabel: data.privateLabel || null,
    updatedAt: data.updatedAt || null,
  };
}

// Packages waiting to be installed, oldest first.
function listStaged() {
  let names = [];
  try { names = fs.readdirSync(STAGED); } catch (error) { return []; }
  const list = [];
  for (const name of names) {
    if (!/^(public|private)-\d{14}$/.test(name)) continue;
    const dir = path.join(STAGED, name);
    const header = core.readJsonFile(path.join(dir, 'update.json'));
    if (!header) continue;
    const failed = core.readJsonFile(path.join(dir, 'failed.json'));
    list.push(Object.assign(summary(header), { dir, stagedAt: header.stagedAt || null, source: header.source || null, failed: failed ? failed.error || 'failed' : null }));
  }
  return list.sort((a, b) => a.build - b.build);
}

// Verifies a package and lays its files out in updates/staged/ -> summary, or throws.
function stage(buffer, source) {
  const { header, files } = unpack(buffer);
  const info = summary(header);
  const now = installed();
  if (info.build <= now[info.kind]) throw new Error(`this ${info.kind} update (${info.label}) is not newer than the installed one`);
  const name = `${info.kind}-${header.build}`;
  const dir = path.join(STAGED, name);
  const temp = `${dir}.partial`;
  fs.rmSync(temp, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(temp, 'files', ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  fs.writeFileSync(path.join(temp, 'update.json'), `${JSON.stringify(Object.assign({}, header, { stagedAt: new Date().toISOString(), source }), null, 2)}\n`);
  // One waiting package per kind: a newer one replaces an older one.
  for (const old of listStaged()) {
    if (old.kind === info.kind) fs.rmSync(old.dir, { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(temp, dir);
  return Object.assign(info, { dir });
}

function discard(build, kind) {
  for (const item of listStaged()) {
    if (item.build === Number(build) && (!kind || item.kind === kind)) fs.rmSync(item.dir, { recursive: true, force: true });
  }
}

function lastResult() {
  return core.readJsonFile(RESULT_FILE);
}

// The newest public update on GitHub -> { build, url, size, release, notes } or null.
async function latestPublished() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { 'User-Agent': 'RobloxServer-updater', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
  const releases = await response.json();
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release.draft) continue;
    for (const asset of release.assets || []) {
      const match = ASSET.exec(asset.name || '');
      if (match && (!best || Number(match[1]) > best.build)) {
        best = { build: Number(match[1]), url: asset.browser_download_url, size: asset.size, release: release.tag_name, notes: String(release.body || '').slice(0, 2000) };
      }
    }
  }
  return best;
}

async function download(url, maxBytes = 600 * 1048576) {
  const response = await fetch(url, { headers: { 'User-Agent': 'RobloxServer-updater' }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok) throw new Error(`the download answered HTTP ${response.status}`);
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > maxBytes) throw new Error('the update is too large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('the update is too large');
  return bytes;
}

// Everything /manage shows about updates (without the runner's part).
function status() {
  return {
    installed: installed(),
    staged: listStaged().map(({ dir, ...item }) => item),
    lastResult: lastResult(),
  };
}

module.exports = {
  PUBLIC_KEY, REPO, ASSET, DIR, STAGED, RESULT_FILE, VERSION_FILE,
  cleanPath, buildLabel, pack, unpack, summary, installed, listStaged, stage, discard, lastResult,
  latestPublished, download, status,
};
