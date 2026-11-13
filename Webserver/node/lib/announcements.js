'use strict';

// Announcements from the host to every launcher (data/announcements.json):
//   { "announcements": [{ "id", "title", "text", "level": "info"|"important",
//                         "postedAt": iso, "expiresAt": iso|null }] }
// Posted and removed on the /manage page (host key). Launchers 1.5.2 and newer
// ask for them every few minutes (GET /api/launcher/announcements) and show
// the ones a player has not dismissed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'announcements.json');
const MAX = 20;
const MAX_TITLE = 80;
const MAX_TEXT = 1000;
const LEVELS = new Set(['info', 'important']);

function load() {
  const data = core.readJsonFile(FILE);
  const list = data && Array.isArray(data.announcements) ? data.announcements : [];
  return list.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string');
}

function save(list) {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify({ announcements: list }, null, 2)}\n`)) throw new Error('could not save announcements');
}

function expired(item, now = Date.now()) {
  return Boolean(item.expiresAt) && Date.parse(item.expiresAt) <= now;
}

// Current announcements, newest first.
function list() {
  return load().filter((item) => !expired(item))
    .sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)))
    .map((item) => ({
      id: item.id,
      title: String(item.title || ''),
      text: item.text,
      level: LEVELS.has(item.level) ? item.level : 'info',
      postedAt: item.postedAt || null,
      expiresAt: item.expiresAt || null,
    }));
}

// { title, text, level, expiresHours } -> the new announcement, or throws with a reason.
function post({ title, text, level, expiresHours } = {}) {
  const cleanText = String(text || '').replace(/\r\n/g, '\n').trim();
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) throw new Error('write the announcement first');
  if (cleanText.length > MAX_TEXT) throw new Error(`announcements can be up to ${MAX_TEXT} characters`);
  if (cleanTitle.length > MAX_TITLE) throw new Error(`titles can be up to ${MAX_TITLE} characters`);
  const hours = Number(expiresHours);
  const item = {
    id: crypto.randomBytes(6).toString('hex'),
    title: cleanTitle,
    text: cleanText,
    level: LEVELS.has(level) ? level : 'info',
    postedAt: new Date().toISOString(),
    expiresAt: Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + Math.min(hours, 24 * 365) * 3600000).toISOString() : null,
  };
  // Expired ones are dropped; past MAX the oldest go.
  const kept = load().filter((old) => !expired(old)).sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)));
  save([item, ...kept].slice(0, MAX));
  return item;
}

function remove(id) {
  const before = load();
  const after = before.filter((item) => item.id !== String(id));
  if (after.length === before.length) return false;
  save(after);
  return true;
}

module.exports = { list, post, remove, MAX_TEXT, MAX_TITLE };
