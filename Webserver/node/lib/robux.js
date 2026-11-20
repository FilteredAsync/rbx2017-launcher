'use strict';

// Robux: each account's balance, kept on this server (data/robux.json).
// Nobody can buy it and players can't send it to each other, so it never
// has a real-money price. Players earn it:
//   - a starting amount, the first time their balance is looked up
//   - a daily bonus, the first time their launcher (or the website) checks in each day
//   - time in games: an amount every few minutes, up to a cap a day
//     (counted from the game servers' own player lists)
//   - each badge a game awards them (only the game's own Roblox badges)
//   - the Xbox app's Robux store: its packs cost nothing and add Robux, up to
//     storeDaily R$ a day per account (0 turns the store off)
// and spend it on game passes, items and developer products in games
// (lib/marketplace.js). Admins can give or take some on /manage.
//
// The amounts can be changed in config/server.json, for example
//   "robux": { "start": 200, "daily": 25, "playEvery": 10, "playAmount": 5, "playDailyMax": 60, "badge": 10, "storeDaily": 1000 }
// (playEvery in minutes; playDailyMax in R$).
//
// data/robux.json: { "<userId>": { balance, dailyDay, playDay, playMinutes,
//   playPaid, storeDay, storePaid, history: [{ at, amount, reason, balance }] } }

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'robux.json');
const DEFAULTS = { start: 200, daily: 25, playEvery: 10, playAmount: 5, playDailyMax: 60, badge: 10, storeDaily: 1000 };
const HISTORY = 30;
const MAX_AMOUNT = 1000000000;

let cache = null;

function load() {
  if (cache === null) {
    const data = core.readJsonFile(FILE);
    cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save Robux balances');
}

// The earning amounts (config/server.json "robux", else the defaults).
function rules() {
  const config = core.readJsonFile(core.rootPath('config', 'server.json')) || {};
  const given = config.robux && typeof config.robux === 'object' ? config.robux : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = Number(given[key]);
    out[key] = Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), MAX_AMOUNT) : fallback;
  }
  out.playEvery = Math.max(1, out.playEvery);
  return out;
}

// The server's own calendar day (the daily bonus and the play cap reset at its midnight).
function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const userKey = (userId) => (/^\d{1,15}$/.test(String(userId)) && Number(userId) > 0 ? String(Number(userId)) : null);

function note(entry, amount, reason) {
  entry.history = Array.isArray(entry.history) ? entry.history : [];
  entry.history.unshift({ at: core.isoDate(), amount, reason: String(reason || '').slice(0, 80), balance: entry.balance });
  entry.history.length = Math.min(entry.history.length, HISTORY);
}

// The account's entry, made with the starting amount the first time
// (null for guests and bad IDs). Callers save.
function entryFor(userId, data = load()) {
  const key = userKey(userId);
  if (!key) return null;
  if (!data[key] || typeof data[key] !== 'object') {
    const start = rules().start;
    data[key] = { balance: start, history: [] };
    if (start > 0) note(data[key], start, 'Welcome bonus');
    data[key].fresh = true;
  }
  const entry = data[key];
  if (!Number.isFinite(entry.balance) || entry.balance < 0) entry.balance = 0;
  return entry;
}

// Saves an entry made just now (its starting amount) along with any change.
function commit(entry) {
  if (entry) delete entry.fresh;
  save();
}

function balance(userId) {
  const entry = entryFor(userId);
  if (!entry) return 0;
  if (entry.fresh) commit(entry);
  return entry.balance;
}

// Adds amount (> 0) -> the new balance, or null for guests.
function credit(userId, amount, reason) {
  const entry = entryFor(userId);
  const add = Math.floor(Number(amount));
  if (!entry || !(add > 0)) return entry ? balance(userId) : null;
  entry.balance = Math.min(entry.balance + add, MAX_AMOUNT);
  note(entry, add, reason);
  commit(entry);
  return entry.balance;
}

// Takes amount (>= 0) if the account has it -> { ok, balance }.
function charge(userId, amount, reason) {
  const entry = entryFor(userId);
  const cost = Math.max(0, Math.floor(Number(amount) || 0));
  if (!entry) return { ok: false, balance: 0 };
  if (entry.balance < cost) {
    if (entry.fresh) commit(entry);
    return { ok: false, balance: entry.balance };
  }
  if (cost === 0) {
    if (entry.fresh) commit(entry);
    return { ok: true, balance: entry.balance };
  }
  entry.balance -= cost;
  note(entry, -cost, reason);
  try {
    commit(entry);
  } catch (error) {
    entry.balance += cost;
    entry.history.shift();
    throw error;
  }
  return { ok: true, balance: entry.balance };
}

// A Robux pack from the Xbox app's store -> { balance, added } or { error, left }.
// A pack bigger than what is left today is refused (not cut down), so a player
// can always see what a pack gives.
function storePack(userId, amount, packName) {
  const entry = entryFor(userId);
  const add = Math.floor(Number(amount));
  if (!entry) return { error: 'Sign in to an account to get Robux.', left: 0 };
  if (!(add > 0)) return { error: 'Unknown pack.', left: 0 };
  const limit = rules().storeDaily;
  const day = today();
  const paid = entry.storeDay === day ? Number(entry.storePaid) || 0 : 0;
  const left = Math.max(0, limit - paid);
  if (add > left) {
    if (entry.fresh) commit(entry);
    return { error: limit === 0 ? 'The Robux store is off on this server.' : `That's more than today's limit. You can get ${left} more R$ today.`, left };
  }
  entry.balance = Math.min(entry.balance + add, MAX_AMOUNT);
  entry.storeDay = day;
  entry.storePaid = paid + add;
  note(entry, add, `Xbox store: ${packName}`);
  commit(entry);
  return { balance: entry.balance, added: add };
}

// An admin's change (+ or -) -> { balance } or { error }.
function adjust(userId, amount, reason) {
  const change = Math.trunc(Number(amount));
  if (!Number.isFinite(change) || change === 0 || Math.abs(change) > MAX_AMOUNT) return { error: 'Type an amount, such as 100 or -50.' };
  if (change > 0) return { balance: credit(userId, change, reason || 'From an admin') };
  const result = charge(userId, -change, reason || 'Taken by an admin');
  return result.ok ? { balance: result.balance } : { error: `They only have R$ ${result.balance}.` };
}

// The launcher checked in: the daily bonus, once a day -> the amount given (0 if not).
function checkIn(userId) {
  const entry = entryFor(userId);
  if (!entry) return 0;
  const day = today();
  const { daily } = rules();
  if (entry.dailyDay === day || daily <= 0) {
    if (entry.fresh) commit(entry);
    return 0;
  }
  entry.dailyDay = day;
  entry.balance = Math.min(entry.balance + daily, MAX_AMOUNT);
  note(entry, daily, 'Daily bonus');
  commit(entry);
  return daily;
}

// One more minute in a game for each of these accounts (the play clock calls
// this every minute): every playEvery minutes pays playAmount, up to
// playDailyMax a day.
function playMinute(userIds) {
  const data = load();
  const day = today();
  const { playEvery, playAmount, playDailyMax } = rules();
  let changed = false;
  for (const userId of new Set(userIds.map(userKey).filter(Boolean))) {
    const entry = entryFor(userId, data);
    if (entry.playDay !== day) Object.assign(entry, { playDay: day, playMinutes: 0, playPaid: 0 });
    entry.playMinutes = (Number(entry.playMinutes) || 0) + 1;
    delete entry.fresh;
    changed = true;
    const room = playDailyMax - (Number(entry.playPaid) || 0);
    if (entry.playMinutes % playEvery !== 0 || room <= 0 || playAmount <= 0) continue;
    const pay = Math.min(playAmount, room);
    entry.playPaid = (Number(entry.playPaid) || 0) + pay;
    entry.balance = Math.min(entry.balance + pay, MAX_AMOUNT);
    note(entry, pay, 'Playing games');
  }
  if (changed) save();
}

// A game awarded a badge for the first time -> the amount given.
function badgeEarned(userId, badgeName) {
  const { badge } = rules();
  if (!(badge > 0) || !userKey(userId)) return 0;
  credit(userId, badge, `Badge: ${badgeName || 'a badge'}`);
  return badge;
}

// What the launcher shows.
function summary(userId) {
  const entry = entryFor(userId);
  if (!entry) return null;
  if (entry.fresh) commit(entry);
  const day = today();
  const r = rules();
  const playPaid = entry.playDay === day ? Number(entry.playPaid) || 0 : 0;
  return {
    balance: entry.balance,
    earn: {
      daily: r.daily, dailyDone: entry.dailyDay === day,
      playAmount: r.playAmount, playEvery: r.playEvery, playToday: playPaid, playMax: r.playDailyMax,
      badge: r.badge,
    },
    history: (entry.history || []).slice(0, HISTORY),
  };
}

// For /manage: balances by user ID, without making entries.
function balances() {
  const data = load();
  const out = {};
  for (const [key, entry] of Object.entries(data)) if (entry && Number.isFinite(entry.balance)) out[key] = entry.balance;
  return out;
}

module.exports = { rules, balance, credit, charge, adjust, storePack, checkIn, playMinute, badgeEarned, summary, balances, DEFAULTS };
