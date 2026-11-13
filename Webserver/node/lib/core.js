'use strict';

// Shared helpers: paths, settings files, logging, IDs and PHP-compatible
// encoding. The Node server is a drop-in replacement for the old
// UwAmp (Apache + PHP) setup, so responses mirror the PHP output byte for
// byte where the client could care, and the cache/config files are shared.

const fs = require('fs');
const path = require('path');

// .../RobloxClient/Webserver/node/lib -> .../RobloxClient
const ROOT = path.resolve(__dirname, '..', '..', '..');
const WEBSERVER = path.join(ROOT, 'Webserver');
const WWW = path.join(WEBSERVER, 'www');

function rootPath(...parts) {
  return path.join(ROOT, ...parts);
}

function cacheDir(subdirectory) {
  const dir = subdirectory ? path.join(ROOT, 'cache', subdirectory) : path.join(ROOT, 'cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readText(file) {
  try {
    return stripBom(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function readJsonFile(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === 'object' ? data : null;
  } catch (error) {
    return null;
  }
}

function writeFileAtomic(file, contents) {
  const temporary = `${file}.${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, contents);
  } catch (error) {
    return false;
  }
  try {
    fs.renameSync(temporary, file);
    return true;
  } catch (error) {
    try {
      fs.unlinkSync(file);
      fs.renameSync(temporary, file);
      return true;
    } catch (secondError) {
      try { fs.unlinkSync(temporary); } catch (ignored) { /* already gone */ }
      return false;
    }
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (error) {
    return 0;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch (error) {
    return false;
  }
}

// --- Decimal IDs (kept as strings, like the PHP version) -----------------

function decimal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
    value = BigInt(value).toString();
  }
  if (typeof value !== 'string') return null;
  value = value.trim();
  if (value === '' || !/^[0-9]+$/.test(value)) return null;
  value = value.replace(/^0+/, '');
  return value === '' ? '0' : value;
}

function decimalCompare(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// See Webserver/lib/legacy-assets.php: avatar-fetch hands out "8" + the asset
// ID padded to 15 digits as a version ID, and /asset maps it back.
function versionIdForAsset(assetId) {
  if (assetId === null || assetId.length > 15) return null;
  return '8' + assetId.padStart(15, '0');
}

function assetForVersionId(versionId) {
  if (versionId.length !== 16 || versionId[0] !== '8') return null;
  const assetId = versionId.slice(1).replace(/^0+/, '');
  return assetId === '' ? null : assetId;
}

// --- Settings -------------------------------------------------------------

const ASSET_DEFAULTS = {
  baseUrl: 'http://localhost.',
  avatarType: 'auto',
  defaultFaceId: '144075659',
  dynamicHeadFaces: {},
  dynamicHeads: {},
  legacyBodyPartMaxAssetId: '',
  loadGear: false,
  avatarCacheSeconds: 120,
  gameAssets: {},
  gameUniverseId: '',
};

const settingsCache = new Map();

// Re-reads a settings file when it changes, so edits apply without a restart.
function settingsFile(file, defaults) {
  const stamp = mtimeMs(file);
  const cached = settingsCache.get(file);
  if (cached && cached.stamp === stamp) return cached.value;
  const value = Object.assign({}, defaults);
  const loaded = readJsonFile(file);
  if (loaded && !Array.isArray(loaded)) {
    for (const key of Object.keys(defaults)) {
      if (Object.prototype.hasOwnProperty.call(loaded, key)) value[key] = loaded[key];
    }
  }
  settingsCache.set(file, { stamp, value });
  return value;
}

function assetConfig() {
  return settingsFile(rootPath('config', 'assets.json'), ASSET_DEFAULTS);
}

// --- Logging ---------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

function gmdate(date) {
  date = date || new Date();
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} `
    + `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

// gmdate("c") in PHP: 2026-11-11T20:08:25+00:00
function isoDate(date) {
  date = date || new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function appendLog(file, line, maxBytes) {
  try {
    if (maxBytes && isFile(file) && fs.statSync(file).size > maxBytes) {
      try { fs.unlinkSync(`${file}.old`); } catch (ignored) { /* none yet */ }
      fs.renameSync(file, `${file}.old`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch (error) {
    // Logging must never break a request.
  }
}

// The same file the PHP proxy wrote: RobloxClient/cache/asset-errors.log
function assetLog(line) {
  appendLog(path.join(cacheDir(''), 'asset-errors.log'), `${gmdate()}  ${line}`, 1048576);
}

// --- PHP-compatible encoding ----------------------------------------------

// json_encode() of PHP 5.5: escapes "/" and every non-ASCII character.
function phpJsonString(text) {
  let out = '"';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '/') out += '\\/';
    else if (code === 8) out += '\\b';
    else if (code === 12) out += '\\f';
    else if (code === 10) out += '\\n';
    else if (code === 13) out += '\\r';
    else if (code === 9) out += '\\t';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else if (code > 0x7f) {
      if (code > 0xffff) {
        const v = code - 0x10000;
        out += '\\u' + (0xd800 + (v >> 10)).toString(16) + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16);
      } else {
        out += '\\u' + code.toString(16).padStart(4, '0');
      }
    } else out += ch;
  }
  return out + '"';
}

function phpJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return phpJsonString(value);
  if (Array.isArray(value)) return '[' + value.map(phpJson).join(',') + ']';
  return '{' + Object.keys(value).map((key) => phpJsonString(key) + ':' + phpJson(value[key])).join(',') + '}';
}

// strtr($text, $map): one pass, longest key first, no re-replacement.
function strtr(text, map) {
  const keys = Object.keys(map).filter((key) => key !== '').sort((a, b) => b.length - a.length);
  if (keys.length === 0) return text;
  const pattern = new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.replace(pattern, (match) => String(map[match]));
}

// PHP-style query parsing: "+" is a space, bad escapes are left alone, and a
// repeated key keeps its last value.
function phpUrlDecode(text) {
  text = text.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

function parseQuery(queryString) {
  const query = Object.create(null);
  if (!queryString) return query;
  for (const part of queryString.split('&')) {
    if (part === '') continue;
    const equals = part.indexOf('=');
    const key = phpUrlDecode(equals < 0 ? part : part.slice(0, equals));
    const value = equals < 0 ? '' : phpUrlDecode(part.slice(equals + 1));
    if (key !== '') query[key] = value;
  }
  return query;
}

function lowerKeys(query) {
  const lowered = Object.create(null);
  for (const key of Object.keys(query)) lowered[key.toLowerCase()] = query[key];
  return lowered;
}

// (int) cast of PHP 5.5 on a 32-bit build: leading digits, clamped to int32.
function phpInt(value) {
  if (value === undefined || value === null) return 0;
  const match = /^\s*([+-]?\d+)/.exec(String(value));
  if (!match) return 0;
  const number = Number(match[1]);
  if (number > 2147483647) return 2147483647;
  if (number < -2147483648) return -2147483648;
  return number;
}

// --- Player IDs ----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The 32-bit-safe player ID for a username, the same value
// detect-roblox-user.ps1 prints: crc32(lowercase name) & 0x7FFFFFFF, >= 16.
function localUserId(username) {
  let id = crc32(Buffer.from(String(username).toLowerCase(), 'utf8')) & 0x7fffffff;
  if (id < 16) id += 16;
  return String(id);
}

// This PC's Tailscale IPv4 address (Tailscale hands out 100.64.0.0/10), or
// null when Tailscale is not installed or not connected. "tailscale" in
// config/server.json hosts and "tailscale:<port>" as a host's public game
// address resolve through this, so the IP never has to be typed in.
function tailscaleIPv4() {
  const os = require('os');
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.internal || (address.family !== 'IPv4' && address.family !== 4)) continue;
      const [a, b] = address.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) candidates.push({ name, address: address.address });
    }
  }
  const named = candidates.find((candidate) => /tailscale/i.test(candidate.name));
  return (named || candidates[0] || { address: null }).address;
}

module.exports = {
  ROOT, WEBSERVER, WWW, localUserId, tailscaleIPv4,
  rootPath, cacheDir, stripBom, readText, readJsonFile, writeFileAtomic, mtimeMs, isFile, isDirectory,
  decimal, decimalCompare, versionIdForAsset, assetForVersionId,
  settingsFile, assetConfig,
  gmdate, isoDate, appendLog, assetLog,
  phpJson, phpJsonString, strtr, parseQuery, lowerKeys, phpInt,
};
