'use strict';

// The forums, like 2017's (data/forums.json):
//   { nextThread, nextPost, threads: [{ id, forumId, title, author, created, lastPostAt,
//     lastPoster, pinned, locked, views, posts: [{ id, author, text, at, edited, deleted }] }] }
// Fixed sections and forums (FORUMS). Anyone with an account posts; only
// server admins start threads in Announcements. Admins pin, lock, move and
// delete; everyone can edit or delete their own posts. Deleted posts keep
// their place ("This post was deleted"). Kept in memory after the first
// read; only this process writes the file.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'forums.json');
const SECTIONS = [
  { name: 'rbx2017', forums: [
    { id: 1, name: 'Announcements', description: 'News from the admins.', adminOnly: true },
    { id: 2, name: 'General Discussion', description: 'Talk about anything rbx2017.' },
    { id: 3, name: 'Suggestions & Ideas', description: 'What should come next?' },
    { id: 4, name: 'Help', description: 'Accounts, the launcher, the app and bugs.' },
  ] },
  { name: 'Games', forums: [
    { id: 5, name: 'Game Discussion', description: 'The games on this server.' },
    { id: 6, name: 'Building & Scripting', description: 'Studio, Lua and making games.' },
    { id: 7, name: 'Let\'s Make a Deal', description: 'Trading limiteds.' },
  ] },
  { name: 'Club Houses', forums: [
    { id: 8, name: 'Off Topic', description: 'Anything else.' },
    { id: 9, name: 'Groups & Clans', description: 'Find a group, or members for yours.' },
  ] },
];
const FORUMS = new Map(SECTIONS.flatMap((section) => section.forums.map((forum) => [forum.id, Object.assign({ section: section.name }, forum)])));
const MAX_TITLE = 80;
const MAX_TEXT = 4000;
const MAX_POSTS_PER_THREAD = 2000;
const POST_EVERY_MS = 15 * 1000;
const THREADS_PER_HOUR = 5;

let cache = null;
const lastPost = new Map(); // userId -> time
const threadTimes = new Map(); // userId -> [times]
let viewsDirty = false;

function load() {
  if (cache) return cache;
  const raw = core.readJsonFile(FILE) || {};
  cache = { nextThread: Number(raw.nextThread) || 1, nextPost: Number(raw.nextPost) || 1, threads: [] };
  for (const t of Array.isArray(raw.threads) ? raw.threads : []) {
    if (!t || !(Number(t.id) > 0) || !FORUMS.has(Number(t.forumId)) || !Array.isArray(t.posts)) continue;
    const thread = {
      id: Number(t.id), forumId: Number(t.forumId), title: String(t.title || ''), author: Number(t.author) || 0,
      created: t.created || core.isoDate(), lastPostAt: t.lastPostAt || t.created || core.isoDate(), lastPoster: Number(t.lastPoster) || Number(t.author) || 0,
      pinned: Boolean(t.pinned), locked: Boolean(t.locked), views: Number(t.views) || 0,
      posts: t.posts.filter((p) => p && Number(p.id) > 0).map((p) => ({
        id: Number(p.id), author: Number(p.author) || 0, text: String(p.text || ''), at: p.at || core.isoDate(), edited: p.edited || null, deleted: Boolean(p.deleted),
      })),
    };
    if (!thread.posts.length) continue;
    cache.threads.push(thread);
    cache.nextThread = Math.max(cache.nextThread, thread.id + 1);
    for (const post of thread.posts) cache.nextPost = Math.max(cache.nextPost, post.id + 1);
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  viewsDirty = false;
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save the forums');
}

// Views are saved with the next change, or every few minutes.
setInterval(() => { if (viewsDirty && cache) save(); }, 5 * 60 * 1000).unref();

const isAdmin = (userId) => {
  try {
    const account = require('./accounts').byUserId(userId);
    return Boolean(account && account.admin);
  } catch (error) {
    return false;
  }
};
const cleanTitle = (text) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanText = (text) => String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{5,}/g, '\n\n\n\n').trim();

function forum(id) {
  return FORUMS.get(Number(id)) || null;
}

function thread(id) {
  return load().threads.find((t) => t.id === Number(id)) || null;
}

function findPost(postId) {
  for (const t of load().threads) {
    const post = t.posts.find((p) => p.id === Number(postId));
    if (post) return { thread: t, post };
  }
  return null;
}

// Post counts by user (non-deleted posts).
function postCount(userId) {
  let count = 0;
  for (const t of load().threads) for (const p of t.posts) if (p.author === Number(userId) && !p.deleted) count += 1;
  return count;
}

// The index: every section with its forums' counts and latest thread.
function sections() {
  const data = load();
  return SECTIONS.map((section) => ({
    name: section.name,
    forums: section.forums.map((f) => {
      const threads = data.threads.filter((t) => t.forumId === f.id);
      const latest = threads.slice().sort((a, b) => (a.lastPostAt < b.lastPostAt ? 1 : -1))[0] || null;
      return {
        id: f.id, name: f.name, description: f.description, adminOnly: Boolean(f.adminOnly),
        threads: threads.length, posts: threads.reduce((n, t) => n + t.posts.filter((p) => !p.deleted).length, 0),
        last: latest ? { threadId: latest.id, title: latest.title, by: latest.lastPoster, at: latest.lastPostAt } : null,
      };
    }),
  }));
}

// A forum's threads: pinned first, then by the latest post.
function threadsOf(forumId, { page = 1, size = 25, search = '' } = {}) {
  const needle = cleanTitle(search).toLowerCase();
  const list = load().threads.filter((t) => t.forumId === Number(forumId) && (!needle || t.title.toLowerCase().includes(needle)))
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (a.lastPostAt < b.lastPostAt ? 1 : -1));
  const pages = Math.max(1, Math.ceil(list.length / size));
  const number = Math.min(pages, Math.max(1, Number(page) || 1));
  return { threads: list.slice((number - 1) * size, number * size), total: list.length, page: number, pages };
}

function postsOf(t, { page = 1, size = 20 } = {}) {
  const pages = Math.max(1, Math.ceil(t.posts.length / size));
  const number = Math.min(pages, Math.max(1, Number(page) || 1));
  return { posts: t.posts.slice((number - 1) * size, number * size), total: t.posts.length, page: number, pages, size };
}

function view(threadId) {
  const t = thread(threadId);
  if (t) {
    t.views += 1;
    viewsDirty = true;
  }
  return t;
}

function checkRate(userId) {
  if (Date.now() - (lastPost.get(Number(userId)) || 0) < POST_EVERY_MS) return 'Wait a few seconds between posts.';
  return null;
}

function checkText(text) {
  const body = cleanText(text);
  if (body.length < 2) return { error: 'Write something first.' };
  if (body.length > MAX_TEXT) return { error: `Posts can be up to ${MAX_TEXT} characters.` };
  return { body };
}

// -> { thread } or { error }
function startThread(userId, forumId, title, text) {
  const by = Number(userId);
  if (!(by > 0)) return { error: 'Guests can\'t post.' };
  const f = forum(forumId);
  if (!f) return { error: 'No such forum.' };
  if (f.adminOnly && !isAdmin(by)) return { error: 'Only admins start threads here.' };
  const heading = cleanTitle(title);
  if (heading.length < 3) return { error: 'Give the thread a title.' };
  if (heading.length > MAX_TITLE) return { error: `Titles can be up to ${MAX_TITLE} characters.` };
  const checked = checkText(text);
  if (checked.error) return checked;
  const slow = checkRate(by);
  if (slow) return { error: slow };
  const now = Date.now();
  const times = (threadTimes.get(by) || []).filter((t) => now - t < 3600 * 1000);
  if (times.length >= THREADS_PER_HOUR && !isAdmin(by)) return { error: 'You started a lot of threads this hour. Try again later.' };
  times.push(now);
  threadTimes.set(by, times);
  lastPost.set(by, now);
  const data = load();
  const at = core.isoDate();
  const t = { id: data.nextThread++, forumId: f.id, title: heading, author: by, created: at, lastPostAt: at, lastPoster: by, pinned: false, locked: false, views: 0,
    posts: [{ id: data.nextPost++, author: by, text: checked.body, at, edited: null, deleted: false }] };
  data.threads.push(t);
  save();
  return { thread: t };
}

// -> { thread, post } or { error }
function reply(userId, threadId, text) {
  const by = Number(userId);
  if (!(by > 0)) return { error: 'Guests can\'t post.' };
  const t = thread(threadId);
  if (!t) return { error: 'No such thread.' };
  if (t.locked && !isAdmin(by)) return { error: 'This thread is locked.' };
  if (t.posts.length >= MAX_POSTS_PER_THREAD) return { error: 'This thread is full. Start a new one.' };
  const checked = checkText(text);
  if (checked.error) return checked;
  const slow = checkRate(by);
  if (slow) return { error: slow };
  lastPost.set(by, Date.now());
  const data = load();
  const post = { id: data.nextPost++, author: by, text: checked.body, at: core.isoDate(), edited: null, deleted: false };
  t.posts.push(post);
  t.lastPostAt = post.at;
  t.lastPoster = by;
  save();
  return { thread: t, post };
}

function canChange(post, userId) {
  return post.author === Number(userId) || isAdmin(userId);
}

function edit(userId, postId, text) {
  const found = findPost(postId);
  if (!found || found.post.deleted) return { error: 'No such post.' };
  if (!canChange(found.post, userId)) return { error: 'You can only edit your own posts.' };
  if (found.thread.locked && !isAdmin(userId)) return { error: 'This thread is locked.' };
  const checked = checkText(text);
  if (checked.error) return checked;
  found.post.text = checked.body;
  found.post.edited = core.isoDate();
  save();
  return found;
}

// A post deleted keeps its place; the first post deleted takes the whole thread with it.
function removePost(userId, postId) {
  const found = findPost(postId);
  if (!found) return { error: 'No such post.' };
  if (!canChange(found.post, userId)) return { error: 'You can only delete your own posts.' };
  if (found.thread.posts[0] === found.post) return removeThread(userId, found.thread.id, true);
  found.post.deleted = true;
  found.post.text = '';
  save();
  return found;
}

function removeThread(userId, threadId, byAuthor = false) {
  const t = thread(threadId);
  if (!t) return { error: 'No such thread.' };
  const mine = byAuthor && t.author === Number(userId) && t.posts.filter((p) => !p.deleted).length <= 1;
  if (!mine && !isAdmin(userId)) return { error: byAuthor ? 'Threads with replies can only be deleted by admins.' : 'Only admins can delete threads.' };
  const data = load();
  data.threads = data.threads.filter((x) => x !== t);
  save();
  return { deletedThread: t.id, forumId: t.forumId };
}

// Admins: pin, lock, move.
function moderate(userId, threadId, change) {
  if (!isAdmin(userId)) return { error: 'Only admins can do that.' };
  const t = thread(threadId);
  if (!t) return { error: 'No such thread.' };
  if (typeof change.pinned === 'boolean') t.pinned = change.pinned;
  if (typeof change.locked === 'boolean') t.locked = change.locked;
  if (change.forumId !== undefined) {
    if (!forum(change.forumId)) return { error: 'No such forum.' };
    t.forumId = Number(change.forumId);
  }
  save();
  return { thread: t };
}

// A deleted account's posts go; threads it started stay if others replied.
function forget(userId) {
  const id = Number(userId);
  const data = load();
  let changed = false;
  data.threads = data.threads.filter((t) => {
    const before = t.posts.length;
    if (t.posts[0].author === id && t.posts.every((p) => p.author === id)) {
      changed = true;
      return false;
    }
    for (const post of t.posts) {
      if (post.author === id && !post.deleted) {
        post.deleted = true;
        post.text = '';
        changed = true;
      }
    }
    return before > 0;
  });
  if (changed) save();
}

module.exports = {
  SECTIONS, MAX_TITLE, MAX_TEXT, forum, thread, findPost, sections, threadsOf, postsOf, view, postCount, isAdmin,
  startThread, reply, edit, removePost, removeThread, moderate, forget,
};
