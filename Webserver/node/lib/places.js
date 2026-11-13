'use strict';

// The server's game library: every place it can host, each with a permanent
// place ID. Uploading a place gives it the next free ID, which never changes
// and is never handed out again (saves and thumbnails are kept by place ID).
//
//   Webserver/node/data/places.json            the library
//   Server/content/places/<placeId>.rbxlx      uploaded places
//   Server/content/places/old/                 replaced versions (last 3 kept)
//   Server/content/places/deleted/             removed places
//
// "enabled": true means the always-on server (dedicated.js) keeps the game
// running. The web server changes the library (lib/routes.js, /manage);
// dedicated.js reads it, takes restart requests from data/control.json and
// reports what runs in data/runner-status.json.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const LIBRARY = path.join(DATA, 'places.json');
const CONTROL = path.join(DATA, 'control.json');
const STATUS = path.join(DATA, 'runner-status.json');
const CONTENT = core.rootPath('Server', 'content');
const PLACES_DIR = path.join(CONTENT, 'places');
const FIRST_UPLOAD_ID = 2000;
const KEEP_OLD_VERSIONS = 3;

function now() {
  return new Date().toISOString();
}

function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
}

function placeKey(value) {
  const id = core.decimal(String(value === undefined || value === null ? '' : value));
  return id !== null && id !== '0' && id.length <= 15 ? id : null;
}

// --- library file -----------------------------------------------------------------

// The first library: Lumber Tycoon 2 as place 1818 (Server/content/place.rbxlx),
// plus any games an older config/dedicated.json listed.
function initialLibrary() {
  const library = { nextPlaceId: FIRST_UPLOAD_ID, places: {} };
  const add = (placeId, fields) => {
    const id = placeKey(placeId);
    if (id === null || library.places[id]) return;
    library.places[id] = Object.assign({
      name: `Place ${id}`, description: '', file: 'place.rbxlx', enabled: false, universeId: '',
      version: 1, createdAt: now(), updatedAt: now(), uploadedFrom: 'this PC', notes: [],
    }, fields);
  };
  const dedicated = core.readJsonFile(core.rootPath('config', 'dedicated.json'));
  if (dedicated && Array.isArray(dedicated.games)) {
    for (const game of dedicated.games) {
      add(game.placeId, { name: cleanText(game.name, 60) || undefined, file: game.placeFile || 'place.rbxlx', enabled: game.enabled !== false });
    }
  }
  if (core.isFile(path.join(CONTENT, 'place.rbxlx'))) {
    const config = core.assetConfig();
    add('1818', { name: 'Lumber Tycoon 2', enabled: true, universeId: config.gameUniverseId ? String(config.gameUniverseId) : '' });
  }
  for (const id of Object.keys(library.places)) {
    if (Number(id) >= library.nextPlaceId && id.length < 10) library.nextPlaceId = Number(id) + 1;
  }
  return library;
}

// The saved library, or the first one (not saved until something changes or
// ensure() is called, so a PC that is not the always-on server gets no
// library file just from someone listing games).
function load() {
  const library = core.readJsonFile(LIBRARY);
  if (library && library.places && typeof library.places === 'object') {
    if (!Number.isFinite(library.nextPlaceId)) library.nextPlaceId = FIRST_UPLOAD_ID;
    return library;
  }
  return initialLibrary();
}

function exists() {
  return core.isFile(LIBRARY);
}

// Saves the first library if there is none yet (the always-on server does this).
function ensure() {
  if (!exists()) save(initialLibrary());
  return load();
}

function save(library) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(LIBRARY, `${JSON.stringify(library, null, 2)}\n`)) throw new Error('could not save the place library');
}

function filePath(place) {
  return path.join(CONTENT, ...String(place.file).split('/'));
}

// Who made a game -> { id, name, type: 'User' | 'Group', source } or null:
// the Studio owner for games made here ("owner"); for imported Roblox games
// the original creator, looked up from the universe ID by lib/creators.js
// ("roblox"), or a name typed on /manage ("manual"). An empty typed name
// means "nobody": no lookup, and the client shows no creator.
function creatorOf(place) {
  if (!place) return null;
  if (place.owner && place.owner.userId) {
    // The account's name now (it may have been renamed since).
    let name = String(place.owner.name || '');
    try {
      const account = require('./accounts').byUserId(place.owner.userId);
      if (account && account.name) name = account.name;
    } catch (error) { /* no accounts here */ }
    return { id: Number(place.owner.userId), name, type: 'User', source: 'owner' };
  }
  const creator = place.creator;
  if (!creator || !creator.name) return null;
  return {
    id: Number(creator.id) || 0,
    name: String(creator.name),
    type: creator.type === 'Group' ? 'Group' : 'User',
    source: creator.source === 'roblox' ? 'roblox' : 'manual',
  };
}

// Library entries as the API shows them.
function describe(placeId, place) {
  let size = null;
  try { size = fs.statSync(filePath(place)).size; } catch (error) { size = null; }
  return {
    placeId,
    name: place.name,
    description: place.description || '',
    enabled: Boolean(place.enabled),
    file: place.file,
    fileSize: size,
    universeId: place.universeId || '',
    version: place.version || 1,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt,
    uploadedFrom: place.uploadedFrom || '',
    notes: Array.isArray(place.notes) ? place.notes : [],
    // Studio: who made it (may publish over it and choose editors) and who
    // else may edit it. Places uploaded on /manage have no owner: only admins.
    owner: place.owner && place.owner.userId ? { userId: Number(place.owner.userId), name: String(place.owner.name || '') } : null,
    editors: Array.isArray(place.editors) ? place.editors.map((e) => ({ userId: Number(e.userId), name: String(e.name || '') })) : [],
    // Who made it, as the game client and the launcher show it (creatorOf).
    creator: creatorOf(place),
    // Team Create: Studio opens it on a shared cloud edit server.
    teamCreate: Boolean(place.teamCreate),
    // Where the current version came from: "teamcreate" (autosaves of a
    // Team Create server) goes live once nobody is playing; others at once.
    versionSource: place.versionSource || 'upload',
  };
}

function list() {
  const library = load();
  return Object.entries(library.places)
    .map(([id, place]) => describe(id, place))
    .sort((a, b) => Number(a.placeId) - Number(b.placeId));
}

function get(placeId) {
  const id = placeKey(placeId);
  const place = id === null ? null : load().places[id];
  return place ? describe(id, place) : null;
}

// --- changes -----------------------------------------------------------------------

function storePlaceFile(placeId, bytes) {
  fs.mkdirSync(PLACES_DIR, { recursive: true });
  const relative = `places/${placeId}.rbxlx`;
  const target = path.join(CONTENT, 'places', `${placeId}.rbxlx`);
  if (core.isFile(target)) {
    const oldDir = path.join(PLACES_DIR, 'old');
    fs.mkdirSync(oldDir, { recursive: true });
    const stamp = now().replace(/[-:]/g, '').replace(/\..*$/, '');
    fs.renameSync(target, path.join(oldDir, `${placeId}-${stamp}.rbxlx`));
    const old = fs.readdirSync(oldDir).filter((name) => name.startsWith(`${placeId}-`)).sort();
    for (const name of old.slice(0, Math.max(0, old.length - KEEP_OLD_VERSIONS))) {
      try { fs.unlinkSync(path.join(oldDir, name)); } catch (error) { /* in use */ }
    }
  }
  if (!core.writeFileAtomic(target, bytes)) throw new Error('could not save the place file');
  return relative;
}

// A new place from an already converted .rbxlx -> its description.
function create({ name, description, universeId, enabled, bytes, notes, from, owner }) {
  const library = load();
  let id = Math.max(library.nextPlaceId, FIRST_UPLOAD_ID);
  while (library.places[String(id)]) id++;
  const placeId = String(id);
  const file = storePlaceFile(placeId, bytes);
  library.places[placeId] = {
    name: cleanText(name, 60) || `Place ${placeId}`,
    description: cleanText(description, 1000),
    file,
    enabled: Boolean(enabled),
    universeId: placeKey(universeId) || '',
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    uploadedFrom: cleanText(from, 60),
    notes: Array.isArray(notes) ? notes.slice(0, 60) : [],
  };
  if (owner && owner.userId) library.places[placeId].owner = { userId: Number(owner.userId), name: String(owner.name || '') };
  library.nextPlaceId = id + 1;
  save(library);
  return describe(placeId, library.places[placeId]);
}

// A new file for an existing place; the always-on server restarts it.
function replaceFile(placeId, { bytes, notes, universeId, from, source }) {
  const id = placeKey(placeId);
  const library = load();
  const place = id === null ? null : library.places[id];
  if (!place) return null;
  place.file = storePlaceFile(id, bytes);
  place.version = (place.version || 1) + 1;
  place.updatedAt = now();
  place.uploadedFrom = cleanText(from, 60) || place.uploadedFrom;
  if (placeKey(universeId)) setUniverse(place, placeKey(universeId));
  place.notes = Array.isArray(notes) ? notes.slice(0, 60) : [];
  place.versionSource = source || 'upload';
  save(library);
  return describe(id, place);
}

function update(placeId, fields) {
  const id = placeKey(placeId);
  const library = load();
  const place = id === null ? null : library.places[id];
  if (!place) return null;
  if (fields.name !== undefined) place.name = cleanText(fields.name, 60) || place.name;
  if (fields.description !== undefined) place.description = cleanText(fields.description, 1000);
  if (fields.enabled !== undefined) place.enabled = Boolean(fields.enabled);
  if (fields.universeId !== undefined) setUniverse(place, placeKey(fields.universeId) || '');
  if (fields.teamCreate !== undefined) place.teamCreate = Boolean(fields.teamCreate);
  // A typed creator name (/manage); empty means "nobody".
  if (fields.creator !== undefined && fields.creator !== null) {
    const name = cleanText(fields.creator, 60);
    const current = creatorOf(place);
    // Unchanged (or still empty) leaves a looked-up creator, or the lookup, alone.
    if (current ? (current.source !== 'owner' && name !== current.name) : name !== '') place.creator = { name, source: 'manual' };
  }
  place.updatedAt = now();
  save(library);
  return describe(id, place);
}

// A new universe ID: a creator looked up from the old one is looked up again.
function setUniverse(place, universeId) {
  if (universeId !== (place.universeId || '') && place.creator && place.creator.source === 'roblox') delete place.creator;
  place.universeId = universeId;
}

// The creator lib/creators.js found on Roblox. Only fills a place that has
// none (a typed name or an owner wins); does not count as an edit.
function setLookedUpCreator(placeId, creator) {
  const id = placeKey(placeId);
  const library = load();
  const place = id === null ? null : library.places[id];
  if (!place || place.creator !== undefined || !creator || !creator.name) return null;
  place.creator = { id: Number(creator.id) || 0, name: cleanText(creator.name, 60), type: creator.type === 'Group' ? 'Group' : 'User', source: 'roblox' };
  save(library);
  return describe(id, place);
}

// Owner and editors: { owner: {userId, name} | null, editors: [{userId, name}] }.
function setAccess(placeId, { owner, editors }) {
  const id = placeKey(placeId);
  const library = load();
  const place = id === null ? null : library.places[id];
  if (!place) return null;
  if (owner !== undefined) {
    if (owner && owner.userId) place.owner = { userId: Number(owner.userId), name: String(owner.name || '') };
    else delete place.owner;
  }
  if (editors !== undefined) {
    const seen = new Set();
    place.editors = (Array.isArray(editors) ? editors : [])
      .filter((e) => e && e.userId && !seen.has(Number(e.userId)) && seen.add(Number(e.userId)))
      .slice(0, 50)
      .map((e) => ({ userId: Number(e.userId), name: String(e.name || '') }));
  }
  place.updatedAt = now();
  save(library);
  return describe(id, place);
}

// Takes a place off the library. Its file moves to places/deleted; its saves
// and thumbnail stay, and its place ID is never given to another place.
function remove(placeId) {
  const id = placeKey(placeId);
  const library = load();
  const place = id === null ? null : library.places[id];
  if (!place) return false;
  if (place.file !== 'place.rbxlx') {
    const deletedDir = path.join(PLACES_DIR, 'deleted');
    fs.mkdirSync(deletedDir, { recursive: true });
    try { fs.renameSync(filePath(place), path.join(deletedDir, `${id}-${now().replace(/[-:]/g, '').replace(/\..*$/, '')}.rbxlx`)); } catch (error) { /* already gone */ }
  }
  delete library.places[id];
  save(library);
  return true;
}

// --- talking to the always-on server -------------------------------------------------

// Asks dedicated.js to restart (or start) a place soon.
function request(action, placeId) {
  const control = core.readJsonFile(CONTROL) || {};
  const requests = Array.isArray(control.requests) ? control.requests.slice(-50) : [];
  requests.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, placeId: String(placeId), at: now() });
  core.writeFileAtomic(CONTROL, JSON.stringify({ requests }, null, 2));
}

function requestRestart(placeId) {
  request('restart', placeId);
}

// Asks dedicated.js to start a Team Create (cloud edit) server for a place.
function requestCloudEdit(placeId) {
  request('cloudedit', placeId);
}

// Asks dedicated.js to do something with the whole server: 'update-check',
// 'update-install' or 'server-restart' (lib/updates.js, the /manage page).
function requestServer(action) {
  request(action, '0');
}

function readRequests() {
  const control = core.readJsonFile(CONTROL);
  return control && Array.isArray(control.requests) ? control.requests : [];
}

// What the always-on server last reported, or null when it is not running.
function runnerStatus() {
  const status = core.readJsonFile(STATUS);
  if (!status || !status.updatedAt) return null;
  const age = Date.now() - Date.parse(status.updatedAt);
  return Object.assign(status, { stale: !(age < 60000) });
}

function writeRunnerStatus(status) {
  fs.mkdirSync(DATA, { recursive: true });
  core.writeFileAtomic(STATUS, JSON.stringify(Object.assign({ updatedAt: now() }, status), null, 2));
}

module.exports = {
  load, exists, ensure, list, get, create, replaceFile, update, setAccess, remove, filePath, placeKey,
  creatorOf, setLookedUpCreator,
  requestRestart, requestCloudEdit, requestServer, readRequests, runnerStatus, writeRunnerStatus,
  LIBRARY, CONTROL, STATUS,
};
