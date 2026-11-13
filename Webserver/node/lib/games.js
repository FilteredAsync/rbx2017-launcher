'use strict';

// Live list of hosted games for multiplayer. Each RCC host (hostGame.bat)
// registers its game with the shared host key, then checks in every few
// seconds; a game that stops checking in drops off the list. The list lives
// in memory only: hosts simply register again after a web server restart.
// Each entry is one game server. The always-on server (dedicated.js) gives
// each of its servers a job ID, kept when it registers again, and says which
// are private servers (lib/privateservers.js): those are not listed publicly.

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const core = require('./core');

const HEARTBEAT_SECONDS = 15;
const EXPIRE_MS = HEARTBEAT_SECONDS * 3 * 1000;
const games = new Map();

function hostKeyPath() {
  return core.rootPath('config', 'host-key.txt');
}

function readHostKey() {
  const text = core.readText(hostKeyPath());
  if (text === null) return null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const value = line.trim();
    if (value !== '' && value[0] !== '#') return value;
  }
  return null;
}

// Creates config/host-key.txt on first start; returns the key.
function ensureHostKey() {
  const existing = readHostKey();
  if (existing !== null) return existing;
  const key = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, (c) => ({ '+': 'A', '/': 'B', '=': '' }[c]));
  fs.writeFileSync(hostKeyPath(), '# Shared secret that lets a PC host games on this web server (hostGame.bat).\n'
    + '# Give it only to people who may host. Delete this file and restart the web server to make a new one.\n'
    + `${key}\n`);
  return key;
}

function checkHostKey(given) {
  const key = readHostKey();
  if (key === null || typeof given !== 'string' || given === '') return false;
  const expected = Buffer.from(key, 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// "host:port" or "[ipv6]:port"
function parseAddress(text) {
  if (typeof text !== 'string') return null;
  const match = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(text.trim()) || /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(text.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

function cleanName(text) {
  const name = String(text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
  return name === '' ? 'Unnamed game' : name;
}

function prune() {
  const now = Date.now();
  for (const [id, game] of games) {
    if (now - game.lastSeen > EXPIRE_MS) games.delete(id);
  }
}

function register(fields, remote) {
  const address = parseAddress(fields.address);
  if (address === null) return { error: 'address must look like host:port (the playit UDP address of the game)' };
  const placeId = core.decimal(fields.placeId === undefined ? '1818' : String(fields.placeId));
  if (placeId === null || placeId.length > 15) return { error: 'placeId must be a number' };
  const jobId = /^[0-9a-f]{16,32}$/.test(String(fields.jobId || '')) ? String(fields.jobId) : null;
  const id = jobId || crypto.randomBytes(8).toString('hex');
  const privateId = /^[0-9a-f]{12}$/.test(String(fields.privateId || '')) ? String(fields.privateId) : null;
  const maxPlayers = Math.round(Number(fields.maxPlayers));
  const now = Date.now();
  const before = games.get(id);
  const game = {
    id,
    name: cleanName(fields.name),
    placeId,
    privateId,
    maxPlayers: maxPlayers >= 1 && maxPlayers <= 100 ? maxPlayers : null,
    address,
    registeredFrom: remote,
    startedAt: before ? before.startedAt : now,
    lastSeen: now,
  };
  games.set(id, game);
  return { game };
}

function heartbeat(id) {
  prune();
  const game = games.get(id);
  if (!game) return false;
  game.lastSeen = Date.now();
  return true;
}

function close(id) {
  return games.delete(id);
}

function get(id) {
  prune();
  return games.get(id) || null;
}

function addressText(address) {
  return `${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;
}

// Every server, private ones too (privateId set).
function listAll() {
  prune();
  return [...games.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((game) => ({
      id: game.id,
      name: game.name,
      placeId: game.placeId,
      privateId: game.privateId,
      maxPlayers: game.maxPlayers,
      address: addressText(game.address),
      upSeconds: Math.round((Date.now() - game.startedAt) / 1000),
    }));
}

// The public list (/api/games): no private servers.
function list() {
  return listAll().filter((game) => !game.privateId).map((game) => {
    delete game.privateId;
    return game;
  });
}

// The join script needs an IP address: resolve a playit hostname here.
async function resolve(game) {
  const { host, port } = game.address;
  if (net.isIP(host) !== 0) return { ip: host, port };
  try {
    const result = await dns.lookup(host, { family: 4 });
    return { ip: result.address, port };
  } catch (error) {
    return null;
  }
}

module.exports = {
  HEARTBEAT_SECONDS, ensureHostKey, checkHostKey, parseAddress,
  register, heartbeat, close, get, list, listAll, resolve, addressText,
};
