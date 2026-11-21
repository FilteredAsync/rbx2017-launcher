'use strict';

// Player reports (data/reports.json), shown to admins on /manage:
//   { "reports": [{ "id", "at", "source": "game"|"launcher", "reporterId", "reporterName",
//                   "reportedId" (null: the game itself), "reportedName", "reason", "text",
//                   "placeId", "gameName", "jobId", "messages": [lines],
//                   "status": "open"|"resolved", "resolvedAt", "resolvedBy" }] }
// From a game: the 2017 client's Report menu (Players:ReportAbuse) goes to
// the game server, which posts it to /AbuseReport/InGameChatHandler.ashx
// (routes.js). From the launcher: lib/launcherapi.js. The newest 500 are kept.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const accounts = require('./accounts');
const games = require('./games');
const places = require('./places');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'reports.json');
const MAX = 500;
const MAX_TEXT = 1000;
const MAX_REASON = 100;
const MAX_MESSAGES = 50;
const MAX_LINE = 300;
const MAX_BODY = 64 * 1024; // of a report the game server posts
const PER_HOUR = 10;        // reports one player may send in an hour

function load() {
  const data = core.readJsonFile(FILE);
  const list = data && Array.isArray(data.reports) ? data.reports : [];
  return list.filter((item) => item && typeof item.id === 'string');
}

function save(list) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify({ reports: list }, null, 2)}\n`)) throw new Error('Could not save the report. Try again later.');
}

const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at));

// A player's user ID (guests' are negative), or null.
function userId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number !== 0 ? number : null;
}

// An account's name, Guest_<n> for a guest, or null.
function nameOf(id) {
  id = userId(id);
  if (id === null) return null;
  if (id < 0) return `Guest_${-id}`;
  const account = accounts.byUserId(id);
  return account ? account.name : `User ${id}`;
}

// The library's name for a place, else a listed game's.
function gameNameOf(placeId) {
  if (placeId === null) return null;
  try {
    const place = places.exists() ? places.load().places[placeId] : null;
    if (place && place.name) return String(place.name);
  } catch (error) { /* no library on this PC */ }
  const listed = games.listAll().find((game) => game.placeId === placeId);
  return listed ? listed.name : null;
}

function cleanLine(value, max) {
  return String(value || '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, MAX_TEXT);
}

// { source, reporterId, reportedId, reason, text, placeId, gameName, jobId, messages }
// -> the stored report, or throws with a message for the player (status 429:
// too many from this player in the last hour).
function add(fields = {}) {
  const reporterId = userId(fields.reporterId);
  const reportedId = userId(fields.reportedId);
  const reason = cleanLine(fields.reason, MAX_REASON);
  const text = cleanText(fields.text);
  if (!reason && !text) throw new Error('Say what happened first.');
  if (reportedId !== null && reportedId === reporterId) throw new Error("You can't report yourself.");

  const list = load();
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const recent = list.filter((item) => item.reporterId === reporterId && String(item.at) > hourAgo).length;
  if (recent >= PER_HOUR) throw Object.assign(new Error("You've sent a lot of reports. Try again later."), { status: 429 });

  const placeId = fields.placeId === undefined || fields.placeId === null ? null : core.decimal(String(fields.placeId));
  const usablePlace = placeId !== null && placeId !== '0' && placeId.length <= 15 ? placeId : null;
  const messages = (Array.isArray(fields.messages) ? fields.messages : [])
    .map((line) => cleanLine(line, MAX_LINE)).filter(Boolean).slice(-MAX_MESSAGES);
  const report = {
    id: crypto.randomBytes(6).toString('hex'),
    at: new Date().toISOString(),
    source: ['launcher', 'forum'].includes(fields.source) ? fields.source : 'game',
    reporterId,
    reporterName: nameOf(reporterId) || cleanLine(fields.reporterName, 40) || null,
    reportedId,
    reportedName: reportedId === null ? null : nameOf(reportedId),
    reason,
    text,
    placeId: usablePlace,
    gameName: gameNameOf(usablePlace) || cleanLine(fields.gameName, 60) || null,
    jobId: /^[\w-]{1,64}$/.test(String(fields.jobId || '')) ? String(fields.jobId) : null,
    messages,
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
  };
  save([report, ...list].sort(newestFirst).slice(0, MAX));
  return report;
}

// Every report, newest first.
function list() {
  return load().sort(newestFirst).map((item) => Object.assign({}, item, {
    messages: Array.isArray(item.messages) ? item.messages : [],
    status: item.status === 'resolved' ? 'resolved' : 'open',
  }));
}

// -> the report, or null when there is no such report.
function resolve(id, byName) {
  const all = load();
  const report = all.find((item) => item.id === String(id));
  if (!report) return null;
  report.status = 'resolved';
  report.resolvedAt = new Date().toISOString();
  report.resolvedBy = byName ? String(byName) : null;
  save(all);
  return report;
}

function remove(id) {
  const before = load();
  const after = before.filter((item) => item.id !== String(id));
  if (after.length === before.length) return false;
  save(after);
  return true;
}

function openCount() {
  return load().filter((item) => item.status !== 'resolved').length;
}

module.exports = { add, list, resolve, remove, openCount, nameOf, MAX_BODY, MAX_TEXT, MAX_REASON };
