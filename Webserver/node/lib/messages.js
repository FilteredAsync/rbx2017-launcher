'use strict';

// Private messages, like 2017's Messages page (data/messages.json):
//   { "nextId": n, "messages": [{ id, from, to, subject, body, at, read, archived, replyTo }] }
// Inbox = to you and not archived, Sent = from you, Archive = to you and archived.
// Anyone with an account can write to anyone else unless one blocked the
// other. Used by the launcher, the website and the phone's Messages page.
// Kept in memory after the first read; only this process writes the file.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'messages.json');
const MAX_SUBJECT = 64;
const MAX_BODY = 1000;
const MAX_PER_PLAYER = 500; // kept per recipient; the oldest go first
const RATE = { count: 10, perMs: 10 * 60 * 1000 };
const DAILY = 50;

let cache = null;
const sent = new Map(); // userId -> [times]

function load() {
  if (cache) return cache;
  const raw = core.readJsonFile(FILE);
  cache = { nextId: 1, messages: [] };
  for (const m of raw && Array.isArray(raw.messages) ? raw.messages : []) {
    if (!m || !(Number(m.id) > 0) || !(Number(m.from) > 0) || !(Number(m.to) > 0)) continue;
    cache.messages.push({
      id: Number(m.id), from: Number(m.from), to: Number(m.to), subject: String(m.subject || ''), body: String(m.body || ''),
      at: m.at || core.isoDate(), read: Boolean(m.read), archived: Boolean(m.archived), replyTo: Number(m.replyTo) || null,
    });
    cache.nextId = Math.max(cache.nextId, Number(m.id) + 1);
  }
  cache.nextId = Math.max(cache.nextId, Number(raw && raw.nextId) || 1);
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save messages');
}

const oneLine = (text, max) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanBody = (text) => String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();

// -> { message } or { error }
function send(from, to, subject, body, replyTo = null) {
  const a = Number(from);
  const b = Number(to);
  if (!(a > 0)) return { error: 'Guests cannot send messages.' };
  if (!(b > 0)) return { error: 'Nobody on this server has that name.' };
  if (a === b) return { error: "You can't send a message to yourself." };
  if (require('./blocks').between(a, b)) return { error: "You can't send this player messages." };
  const title = oneLine(subject, MAX_SUBJECT + 1);
  const text = cleanBody(body);
  if (!title) return { error: 'Give it a subject.' };
  if (title.length > MAX_SUBJECT) return { error: `Subjects can be up to ${MAX_SUBJECT} characters.` };
  if (!text) return { error: 'Write a message first.' };
  if (text.length > MAX_BODY) return { error: `Messages can be up to ${MAX_BODY} characters.` };
  const now = Date.now();
  const times = (sent.get(a) || []).filter((t) => now - t < RATE.perMs);
  if (times.length >= RATE.count) return { error: 'You sent a lot of messages just now. Try again in a few minutes.' };
  const data = load();
  const today = core.isoDate().slice(0, 10);
  if (data.messages.filter((m) => m.from === a && m.at.slice(0, 10) === today).length >= DAILY) return { error: `You can send ${DAILY} messages a day.` };
  times.push(now);
  sent.set(a, times);
  const original = Number(replyTo) > 0 ? data.messages.find((m) => m.id === Number(replyTo) && (m.to === a || m.from === a)) : null;
  const message = { id: data.nextId++, from: a, to: b, subject: title, body: text, at: core.isoDate(), read: false, archived: false, replyTo: original ? original.id : null };
  data.messages.push(message);
  const theirs = data.messages.filter((m) => m.to === b);
  if (theirs.length > MAX_PER_PLAYER) {
    const drop = new Set(theirs.slice(0, theirs.length - MAX_PER_PLAYER));
    data.messages = data.messages.filter((m) => !drop.has(m));
  }
  save();
  return { message };
}

function inFolder(message, userId, folder) {
  const id = Number(userId);
  if (folder === 'sent') return message.from === id;
  if (folder === 'archive') return message.to === id && message.archived;
  return message.to === id && !message.archived;
}

// -> { messages (newest first), total, page, pages }
function folder(userId, name, page = 1, size = 20) {
  const which = ['inbox', 'sent', 'archive'].includes(name) ? name : 'inbox';
  const all = load().messages.filter((m) => inFolder(m, userId, which)).reverse();
  const per = Math.min(50, Math.max(1, Number(size) || 20));
  const pages = Math.max(1, Math.ceil(all.length / per));
  const number = Math.min(pages, Math.max(1, Number(page) || 1));
  return { folder: which, messages: all.slice((number - 1) * per, number * per), total: all.length, page: number, pages };
}

// A message userId sent or got, or null.
function get(id, userId) {
  const message = load().messages.find((m) => m.id === Number(id));
  return message && (message.to === Number(userId) || message.from === Number(userId)) ? message : null;
}

// Only the recipient's copy has read/archived.
function mark(id, userId, change) {
  const message = get(id, userId);
  if (!message) return { error: 'No such message.' };
  if (message.to !== Number(userId)) return { message };
  let changed = false;
  for (const key of ['read', 'archived']) {
    if (typeof change[key] === 'boolean' && message[key] !== change[key]) {
      message[key] = change[key];
      changed = true;
    }
  }
  if (changed) save();
  return { message };
}

function unreadCount(userId) {
  return load().messages.filter((m) => m.to === Number(userId) && !m.read && !m.archived).length;
}

// A deleted account's messages go with it (lib/accounts.js remove).
function forget(userId) {
  const data = load();
  const before = data.messages.length;
  data.messages = data.messages.filter((m) => m.from !== Number(userId) && m.to !== Number(userId));
  if (data.messages.length !== before) save();
}

module.exports = { MAX_SUBJECT, MAX_BODY, send, folder, get, mark, unreadCount, forget };
