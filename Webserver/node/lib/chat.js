'use strict';

// Chat between friends: one-to-one and group conversations (data/chat.json):
//   { "seq": n, "nextId": n, "conversations": [{ id, type: "one"|"group", title,
//     owner, members: [ids], created, updated, read: { userId: seq },
//     messages: [{ seq, from, text, at }] }] }
// Used by the launcher's Chat tab and the website (lib/launcherapi.js) and the
// phone app's native chat (lib/mobilechat.js). Kept in memory after the first
// read and written on every change; only this process writes the file.
// Message numbers (seq) count up across all conversations, so "what came
// after N" is one comparison. Typing is memory only.
//
// Rules: you chat with friends. A one-to-one needs the two to be friends
// (and stops taking messages when they no longer are); anyone in a group can
// add their own friends; a block between two players keeps them apart.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'chat.json');
const MAX_TEXT = 200;
const MAX_TITLE = 50;
const MAX_MEMBERS = 10;
const MAX_KEPT = 300; // messages kept per conversation
const MAX_CONVERSATIONS = 200; // per player
const RATE = { count: 20, perMs: 30 * 1000 };
const TYPING_MS = 6 * 1000;

let cache = null;
const sent = new Map(); // userId -> [times]
const listeners = [];

// Changes, for the phone's realtime connection (lib/mobilechat.js):
// { type: 'start'|'send'|'add'|'remove'|'rename'|'typing', conversation, by, ... }
function onChange(listener) {
  listeners.push(listener);
}

function emit(event) {
  for (const listener of listeners) {
    try { listener(event); } catch (error) { /* a listener's problem */ }
  }
}
const typing = new Map(); // conversation id -> Map(userId -> until)

function clean(raw) {
  const data = { seq: 0, nextId: 1, conversations: [] };
  if (!raw || typeof raw !== 'object') return data;
  data.seq = Number(raw.seq) || 0;
  data.nextId = Number(raw.nextId) || 1;
  for (const c of Array.isArray(raw.conversations) ? raw.conversations : []) {
    if (!c || !(Number(c.id) > 0) || !Array.isArray(c.members)) continue;
    const messages = (Array.isArray(c.messages) ? c.messages : [])
      .filter((m) => m && Number(m.seq) > 0 && Number(m.from) > 0 && typeof m.text === 'string')
      .map((m) => ({ seq: Number(m.seq), from: Number(m.from), text: m.text, at: m.at || core.isoDate() }));
    data.conversations.push({
      id: Number(c.id), type: c.type === 'group' ? 'group' : 'one', title: typeof c.title === 'string' ? c.title : '',
      owner: Number(c.owner) || Number(c.members[0]) || 0, members: c.members.map(Number).filter((id) => id > 0),
      created: c.created || core.isoDate(), updated: c.updated || c.created || core.isoDate(),
      read: c.read && typeof c.read === 'object' ? c.read : {}, messages,
    });
    for (const m of messages) data.seq = Math.max(data.seq, m.seq);
    data.nextId = Math.max(data.nextId, Number(c.id) + 1);
  }
  return data;
}

function load() {
  if (!cache) cache = clean(core.readJsonFile(FILE));
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save chat');
}

const friendsOf = () => require('./friends');
const blocksOf = () => require('./blocks');
const valid = (id) => Number.isInteger(Number(id)) && Number(id) > 0;

function find(id) {
  return load().conversations.find((c) => c.id === Number(id)) || null;
}

function isMember(conversation, userId) {
  return Boolean(conversation && conversation.members.includes(Number(userId)));
}

// A conversation userId is in, or null.
function get(id, userId) {
  const conversation = find(id);
  return isMember(conversation, userId) ? conversation : null;
}

function lastOf(conversation) {
  return conversation.messages.length ? conversation.messages[conversation.messages.length - 1] : null;
}

function unreadIn(conversation, userId) {
  const seen = Number(conversation.read[userId]) || 0;
  return conversation.messages.filter((m) => m.seq > seen && m.from !== Number(userId)).length;
}

// userId's conversations, newest first.
function list(userId) {
  return load().conversations.filter((c) => isMember(c, userId)).sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : b.id - a.id));
}

// How many conversations have messages userId hasn't read.
function unreadCount(userId) {
  return list(userId).filter((c) => unreadIn(c, userId) > 0).length;
}

// Messages of a conversation: { after } newer than a seq, or { before } the
// `limit` older than a seq (default: the newest), oldest first.
function messagesOf(conversation, { after = 0, before = 0, limit = 50 } = {}) {
  const size = Math.min(100, Math.max(1, Number(limit) || 50));
  if (Number(after) > 0) return conversation.messages.filter((m) => m.seq > Number(after)).slice(0, size);
  const older = Number(before) > 0 ? conversation.messages.filter((m) => m.seq < Number(before)) : conversation.messages;
  return older.slice(-size);
}

function canTalk(a, b) {
  return friendsOf().areFriends(a, b) && !blocksOf().between(a, b);
}

function roomFor(userId) {
  return list(userId).length < MAX_CONVERSATIONS;
}

// -> { conversation } (the one they already have, or a new one) or { error }
function startOne(from, to) {
  if (!valid(from) || !valid(to)) return { error: 'Guests cannot chat.' };
  if (Number(from) === Number(to)) return { error: 'That is you.' };
  const data = load();
  const existing = data.conversations.find((c) => c.type === 'one' && isMember(c, from) && isMember(c, to));
  if (existing) return { conversation: existing };
  if (!canTalk(from, to)) return { error: 'You can only chat with your friends.' };
  if (!roomFor(from) || !roomFor(to)) return { error: 'Too many chats. Leave some first.' };
  const now = core.isoDate();
  const conversation = { id: data.nextId++, type: 'one', title: '', owner: Number(from), members: [Number(from), Number(to)], created: now, updated: now, read: {}, messages: [] };
  data.conversations.push(conversation);
  save();
  emit({ type: 'start', conversation, by: Number(from) });
  return { conversation };
}

function cleanTitle(title) {
  return String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

// Who of ids `by` may bring into a conversation: their friends, no blocks with anyone already in it.
function addable(by, ids, members = []) {
  const ok = [];
  const rejected = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!valid(id) || id === Number(by) || members.includes(id) || ok.includes(id)) continue;
    if (canTalk(by, id) && !members.some((m) => blocksOf().between(m, id)) && roomFor(id)) ok.push(id);
    else rejected.push(id);
  }
  return { ok, rejected };
}

// -> { conversation, rejected } or { error }
function startGroup(owner, ids, title) {
  if (!valid(owner)) return { error: 'Guests cannot chat.' };
  if (!roomFor(owner)) return { error: 'Too many chats. Leave some first.' };
  const { ok, rejected } = addable(owner, Array.isArray(ids) ? ids : [], [Number(owner)]);
  if (!ok.length) return { error: 'Pick at least one friend.', rejected };
  if (ok.length + 1 > MAX_MEMBERS) return { error: `A group chat can have up to ${MAX_MEMBERS} people.` };
  const data = load();
  const now = core.isoDate();
  const conversation = { id: data.nextId++, type: 'group', title: cleanTitle(title), owner: Number(owner), members: [Number(owner), ...ok], created: now, updated: now, read: {}, messages: [] };
  data.conversations.push(conversation);
  save();
  emit({ type: 'start', conversation, by: Number(owner) });
  return { conversation, rejected };
}

// -> { conversation, rejected } or { error }
function add(id, by, ids) {
  const conversation = get(id, by);
  if (!conversation) return { error: 'No such chat.' };
  if (conversation.type !== 'group') return { error: 'Start a group chat to add people.' };
  const { ok, rejected } = addable(by, Array.isArray(ids) ? ids : [ids], conversation.members);
  if (conversation.members.length + ok.length > MAX_MEMBERS) return { error: `A group chat can have up to ${MAX_MEMBERS} people.` };
  if (ok.length) {
    conversation.members.push(...ok);
    conversation.updated = core.isoDate();
    save();
    emit({ type: 'add', conversation, by: Number(by), added: ok });
  }
  return { conversation, rejected };
}

// Leaving (who === by) or the owner taking someone out. -> { ok } or { error }
function remove(id, by, who) {
  const conversation = get(id, by);
  if (!conversation) return { error: 'No such chat.' };
  const target = Number(who);
  if (target !== Number(by) && (conversation.type !== 'group' || conversation.owner !== Number(by))) return { error: 'Only the one who made the group can take people out.' };
  if (!isMember(conversation, target)) return { ok: true };
  conversation.members = conversation.members.filter((m) => m !== target);
  delete conversation.read[target];
  if (conversation.owner === target) conversation.owner = conversation.members[0] || 0;
  const data = load();
  const gone = conversation.members.length === 0 || (conversation.type === 'one' && conversation.members.length < 2);
  if (gone) {
    data.conversations = data.conversations.filter((c) => c !== conversation);
    typing.delete(conversation.id);
  }
  save();
  emit({ type: 'remove', conversation, by: Number(by), removed: target, gone });
  return { ok: true };
}

function rename(id, by, title) {
  const conversation = get(id, by);
  if (!conversation) return { error: 'No such chat.' };
  if (conversation.type !== 'group') return { error: 'Only group chats have names.' };
  conversation.title = cleanTitle(title);
  save();
  emit({ type: 'rename', conversation, by: Number(by) });
  return { conversation };
}

function cleanText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// -> { message } or { error }
function send(id, by, text) {
  const conversation = get(id, by);
  if (!conversation) return { error: 'No such chat.' };
  const body = cleanText(text);
  if (!body) return { error: 'Type a message first.' };
  if (body.length > MAX_TEXT) return { error: `Messages can be up to ${MAX_TEXT} characters.` };
  if (conversation.type === 'one') {
    const other = conversation.members.find((m) => m !== Number(by));
    if (!other || !canTalk(by, other)) return { error: "You can't chat with this player now: you're no longer friends." };
  } else if (conversation.members.length < 2) {
    return { error: 'Everyone else left this chat.' };
  }
  const now = Date.now();
  const times = (sent.get(Number(by)) || []).filter((t) => now - t < RATE.perMs);
  if (times.length >= RATE.count) return { error: 'Slow down a little.' };
  times.push(now);
  sent.set(Number(by), times);
  const data = load();
  const message = { seq: ++data.seq, from: Number(by), text: body, at: core.isoDate() };
  conversation.messages.push(message);
  if (conversation.messages.length > MAX_KEPT) conversation.messages.splice(0, conversation.messages.length - MAX_KEPT);
  conversation.updated = message.at;
  conversation.read[by] = message.seq;
  const typers = typing.get(conversation.id);
  if (typers) typers.delete(Number(by));
  save();
  emit({ type: 'send', conversation, by: Number(by), message });
  return { message, conversation };
}

// Marks everything up to `upTo` (default: the newest) read for userId.
function markRead(id, userId, upTo) {
  const conversation = get(id, userId);
  if (!conversation) return { error: 'No such chat.' };
  const last = lastOf(conversation);
  const target = Math.min(Number(upTo) > 0 ? Number(upTo) : Infinity, last ? last.seq : 0);
  if (target > (Number(conversation.read[userId]) || 0)) {
    conversation.read[userId] = target;
    save();
  }
  return { ok: true };
}

function setTyping(id, userId, on = true) {
  const conversation = get(id, userId);
  if (!conversation) return { error: 'No such chat.' };
  let typers = typing.get(conversation.id);
  if (!typers) typing.set(conversation.id, (typers = new Map()));
  const was = typers.has(Number(userId)) && typers.get(Number(userId)) > Date.now();
  if (on) typers.set(Number(userId), Date.now() + TYPING_MS);
  else typers.delete(Number(userId));
  if (was !== Boolean(on)) emit({ type: 'typing', conversation, by: Number(userId), on: Boolean(on) });
  return { ok: true };
}

// Who is typing in a conversation (not counting `except`).
function typingIn(id, except) {
  const typers = typing.get(Number(id));
  if (!typers) return [];
  const now = Date.now();
  const result = [];
  for (const [userId, until] of typers) {
    if (until < now) typers.delete(userId);
    else if (userId !== Number(except)) result.push(userId);
  }
  return result;
}

// A deleted account leaves every chat (lib/accounts.js remove).
function forget(userId) {
  const id = Number(userId);
  const data = load();
  let changed = false;
  for (const conversation of [...data.conversations]) {
    if (!isMember(conversation, id)) continue;
    changed = true;
    conversation.members = conversation.members.filter((m) => m !== id);
    delete conversation.read[id];
    if (conversation.owner === id) conversation.owner = conversation.members[0] || 0;
    if (conversation.type === 'one' || conversation.members.length === 0) data.conversations = data.conversations.filter((c) => c !== conversation);
  }
  if (changed) save();
}

module.exports = {
  MAX_TEXT, MAX_TITLE, MAX_MEMBERS, get, list, lastOf, unreadIn, unreadCount, messagesOf, startOne, startGroup,
  add, remove, rename, send, markRead, setTyping, typingIn, forget, canTalk, onChange,
};
