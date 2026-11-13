'use strict';

// Assets Roblox will not hand out (private since the 2022 audio privacy
// change, removed for copyright, moderated) and the replacement files hosts
// upload for them on the /manage page.
//
//   cache/assets/id-<id>.bin.missing        a failed download (lib/routes.js)
//   assets-override/<id>.<ext>              a replacement, served instead of the
//                                           Roblox asset from then on
//   Webserver/node/data/asset-info.json     names and types looked up on Roblox

const fs = require('fs');
const path = require('path');
const core = require('./core');
const assets = require('./assets');

const OVERRIDES = core.rootPath('assets-override');
const INFO = core.rootPath('Webserver', 'node', 'data', 'asset-info.json');
const MAX_BYTES = 20 * 1024 * 1024;
const TYPE_NAMES = { 1: 'Image', 2: 'T-Shirt', 3: 'Audio', 4: 'Mesh', 8: 'Hat', 10: 'Model', 11: 'Shirt', 12: 'Pants', 13: 'Decal', 24: 'Animation', 40: 'MeshPart', 62: 'Video' };

// Replacement files, recognized by their first bytes.
const KINDS = [
  { ext: 'ogg', test: (b) => b.toString('latin1', 0, 4) === 'OggS' },
  { ext: 'mp3', test: (b) => b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: 'wav', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
  { ext: 'png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'rbxm', test: (b) => b.toString('latin1', 0, 8) === '<roblox!' },
  { ext: 'rbxmx', test: (b) => /^\s*<roblox[\s>]/.test(b.toString('latin1', 0, 64)) },
];

function readInfo() {
  return core.readJsonFile(INFO) || {};
}

function reasonOf(marker) {
  const status = marker && marker.status !== undefined ? Number(marker.status) : null;
  const text = marker && marker.reason ? String(marker.reason) : '';
  if (status === 403 || /not authorized/i.test(text)) return 'Private on Roblox';
  if (/not approved/i.test(text)) return 'Moderated or not approved';
  if (status === 404) return 'Not found on Roblox';
  if (text) return text.replace(/\s*\(.*\)\s*$/, '');
  return 'Failed to download (no details recorded)';
}

function replacementOf(id) {
  try {
    const file = fs.readdirSync(OVERRIDES).find((name) => path.parse(name).name === id);
    return file ? path.join(OVERRIDES, file) : null;
  } catch (error) {
    return null;
  }
}

// Every missing asset, plus every asset that has a replacement.
function list() {
  const info = readInfo();
  const byId = new Map();
  const dir = core.cacheDir('assets');
  for (const name of fs.readdirSync(dir)) {
    const match = /^id-(\d+)\.bin\.missing$/.exec(name);
    if (!match) continue;
    let marker = core.readJsonFile(path.join(dir, name));
    if (marker === null) marker = { at: (core.readText(path.join(dir, name)) || '').trim() };
    byId.set(match[1], { id: match[1], reason: reasonOf(marker), failedAt: marker.at || null });
  }
  try {
    for (const name of fs.readdirSync(OVERRIDES)) {
      const id = path.parse(name).name;
      if (/^\d+$/.test(id) && !byId.has(id)) byId.set(id, { id, reason: 'Replaced', failedAt: null });
    }
  } catch (error) { /* no overrides yet */ }
  return [...byId.values()].map((entry) => {
    const known = info[entry.id] || {};
    const replacement = replacementOf(entry.id);
    return Object.assign(entry, {
      name: known.name || null,
      type: known.type || null,
      creator: known.creator || null,
      replaced: replacement !== null,
      replacement: replacement ? path.basename(replacement) : null,
    });
  }).sort((a, b) => (a.type || 'zzz').localeCompare(b.type || 'zzz') || (a.name || '').localeCompare(b.name || ''));
}

// Looks up names and types of the listed assets that are not known yet.
let lookingUp = false;
async function lookUpNames(ids) {
  if (lookingUp) return;
  lookingUp = true;
  try {
    const info = readInfo();
    const todo = ids.filter((id) => !info[id]).slice(0, 200);
    for (const id of todo) {
      const data = await assets.httpGetJson(`https://economy.roblox.com/v2/assets/${id}/details`, 8000);
      info[id] = data
        ? { name: String(data.Name || ''), type: TYPE_NAMES[data.AssetTypeId] || `Type ${data.AssetTypeId}`, creator: data.Creator ? String(data.Creator.Name || '') : '' }
        : { name: '', type: 'Unknown', creator: '' };
    }
    if (todo.length) {
      fs.mkdirSync(path.dirname(INFO), { recursive: true });
      core.writeFileAtomic(INFO, JSON.stringify(info, null, 2));
    }
  } finally {
    lookingUp = false;
  }
}

// -> { file } or { error }
function saveReplacement(id, bytes) {
  if (!/^\d{1,15}$/.test(String(id))) return { error: 'the asset ID must be a number' };
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { error: 'no file was sent' };
  if (bytes.length > MAX_BYTES) return { error: 'the file is larger than 20 MB' };
  const kind = KINDS.find((candidate) => candidate.test(bytes));
  if (!kind) return { error: 'use an OGG, MP3 or WAV sound, a PNG or JPG image, or a .rbxm/.rbxmx model (e.g. an animation exported from Studio)' };
  removeReplacement(id);
  fs.mkdirSync(OVERRIDES, { recursive: true });
  const file = path.join(OVERRIDES, `${id}.${kind.ext}`);
  if (!core.writeFileAtomic(file, bytes)) return { error: 'could not save the file' };
  // Forget the failed download, so nothing remembers it as missing.
  for (const suffix of ['.bin', '.bin.json', '.bin.missing']) {
    try { fs.unlinkSync(path.join(core.cacheDir('assets'), `id-${id}${suffix}`)); } catch (error) { /* none */ }
  }
  return { file: path.basename(file) };
}

function removeReplacement(id) {
  const existing = replacementOf(String(id));
  if (!existing) return false;
  fs.unlinkSync(existing);
  return true;
}

module.exports = { list, lookUpNames, saveReplacement, removeReplacement };
