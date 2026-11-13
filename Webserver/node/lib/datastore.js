'use strict';

// DataStoreService for RCC (the 2017 "persistence" web API), kept in one JSON
// file per place: Webserver/node/data/datastore-<placeId>.json.
//
// RCC's calls, as seen from Lumber Tycoon 2:
//   POST persistence/getV2?placeId=&type=standard&scope=
//        body: qkeys[0].scope=..&qkeys[0].target=<key>&qkeys[0].key=<store name>
//        reply: {"data":[{"Key":{"Scope":..,"Target":..,"Key":..},"Value":"<json>"}]}
//        (only the keys that exist; GetAsync reads a missing key as nil)
//   POST persistence/set?placeId=&key=<store>&type=&scope=&target=<key>&valueLength=
//        body: value=<json>   (UpdateAsync also sends expectedValue=)
//        reply: {"data":"<json>"}
//   POST persistence/increment?placeId=&key=&type=&scope=&target=&value=<delta>
//        reply: {"data":<new number>}
//   POST persistence/remove?placeId=&key=&type=&scope=&target=
//        reply: {"data":"<old json>"|null}
//   POST persistence/getSortedValues?placeId=&type=sorted&scope=&key=&pageSize=&ascending=
//        reply: {"data":{"Entries":[{"Target":..,"Value":..}],"ExclusiveStartKey":null}}
//
// A reply without "data" makes SetAsync fail inside RCC. Lumber Tycoon 2
// retries a failed save forever, so the old stub ({"success":true}) left
// endless retry loops behind every player who left.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_DELAY_MS = 1000;

const places = new Map(); // placeId -> { file, values: {id: string}, timer }

function placeKey(placeId) {
  const id = String(placeId || '0').replace(/[^0-9]/g, '');
  return id === '' ? '0' : id;
}

function load(placeId) {
  const id = placeKey(placeId);
  let place = places.get(id);
  if (place) return place;
  const file = path.join(DATA_DIR, `datastore-${id}.json`);
  let values = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object') values = parsed.values;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Keep a damaged file for inspection instead of overwriting it.
      try { fs.renameSync(file, `${file}.damaged-${Date.now()}`); } catch (ignored) { /* leave it */ }
    }
  }
  place = { id, file, values, timer: null };
  places.set(id, place);
  return place;
}

function writeNow(place) {
  if (place.timer) {
    clearTimeout(place.timer);
    place.timer = null;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    core.writeFileAtomic(place.file, JSON.stringify({ placeId: place.id, values: place.values }, null, 1));
  } catch (error) {
    core.appendLog(core.rootPath('local-api-requests.log'), `${core.isoDate()} datastore: could not write ${place.file}: ${error.message}`);
  }
}

function scheduleWrite(place) {
  if (place.timer) return;
  place.timer = setTimeout(() => writeNow(place), SAVE_DELAY_MS);
}

function flushAll() {
  for (const place of places.values()) if (place.timer) writeNow(place);
}

function entryId(type, scope, store, key) {
  return JSON.stringify([String(type || 'standard').toLowerCase(), String(scope || 'global'), String(store || ''), String(key || '')]);
}

// "qkeys[0].scope=a&qkeys[0].target=b&qkeys[0].key=c&qkeys[1]..." -> [{scope, target, key}]
function queryKeys(form) {
  const list = [];
  for (const [name, value] of Object.entries(form)) {
    const match = /^qkeys\[(\d+)\]\.(scope|target|key)$/i.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    if (index > 1000) continue;
    list[index] = list[index] || {};
    list[index][match[2].toLowerCase()] = value;
  }
  return list.filter(Boolean);
}

function getV2(query, form) {
  const place = load(query.placeId);
  const data = [];
  for (const item of queryKeys(form)) {
    const scope = item.scope !== undefined ? item.scope : query.scope;
    const id = entryId(query.type, scope, item.key, item.target);
    if (Object.prototype.hasOwnProperty.call(place.values, id)) {
      data.push({ Key: { Scope: scope, Target: item.target, Key: item.key }, Value: place.values[id] });
    }
  }
  return { data };
}

function set(query, form) {
  const place = load(query.placeId);
  const value = form.value !== undefined ? form.value : (query.value !== undefined ? query.value : '');
  place.values[entryId(query.type, query.scope, query.key, query.target)] = value;
  scheduleWrite(place);
  return { data: value };
}

function increment(query, form) {
  const place = load(query.placeId);
  const id = entryId(query.type, query.scope, query.key, query.target);
  const delta = Number(query.value !== undefined ? query.value : (query.by !== undefined ? query.by : form.value));
  const current = Number(place.values[id] !== undefined ? place.values[id] : 0);
  if (!Number.isFinite(delta) || !Number.isFinite(current)) return { data: null, error: 'value is not a number' };
  const next = Math.trunc(current + delta);
  place.values[id] = String(next);
  scheduleWrite(place);
  return { data: next };
}

function remove(query) {
  const place = load(query.placeId);
  const id = entryId(query.type, query.scope, query.key, query.target);
  const old = Object.prototype.hasOwnProperty.call(place.values, id) ? place.values[id] : null;
  delete place.values[id];
  scheduleWrite(place);
  return { data: old };
}

function sortedValues(query) {
  const place = load(query.placeId);
  const prefix = entryId(query.type || 'sorted', query.scope, query.key, '');
  const stem = prefix.slice(0, prefix.lastIndexOf(','));
  const entries = [];
  for (const [id, value] of Object.entries(place.values)) {
    if (!id.startsWith(`${stem},`)) continue;
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    entries.push({ Target: JSON.parse(id)[3], Value: number });
  }
  const ascending = String(query.ascending).toLowerCase() === 'true';
  entries.sort((a, b) => (ascending ? a.Value - b.Value : b.Value - a.Value));
  const min = query.inclusiveMinValue !== undefined && query.inclusiveMinValue !== '' ? Number(query.inclusiveMinValue) : -Infinity;
  const max = query.inclusiveMaxValue !== undefined && query.inclusiveMaxValue !== '' ? Number(query.inclusiveMaxValue) : Infinity;
  const filtered = entries.filter((entry) => entry.Value >= min && entry.Value <= max);
  const start = Math.max(0, Number(query.exclusiveStartKey) || 0);
  const size = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
  const page = filtered.slice(start, start + size);
  const next = start + size < filtered.length ? String(start + size) : null;
  return { data: { Entries: page, ExclusiveStartKey: next } };
}

const HANDLERS = { getv2: getV2, set, increment, remove, getsortedvalues: sortedValues };

function handle(action, query, form) {
  const handler = HANDLERS[String(action).toLowerCase()];
  return handler ? handler(query, form) : null;
}

module.exports = { handle, flushAll, DATA_DIR };
