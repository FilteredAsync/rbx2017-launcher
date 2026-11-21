'use strict';

// The forums for the website (under /api/launcher/, from lib/launcherapi.js).
// Reading needs no sign-in; posting does. Rules: lib/forums.js.
//
//   GET  forum                         sections, forums, counts, latest thread
//   GET  forum/<forumId>               ?page=&search= its threads
//   GET  forum/thread/<id>             ?page= its posts (each view counts)
//   POST forum/<forumId>/threads       {title, text}
//   POST forum/thread/<id>/reply       {text}
//   POST forum/thread/<id>/moderate    {pinned?, locked?, forumId?}   (admins)
//   POST forum/thread/<id>/delete      (admins; the author while nobody replied)
//   POST forum/post/<id>/edit {text} | delete | report {reason}

const accounts = require('./accounts');
const forums = require('./forums');

module.exports = function forumApi({ sendJson, jsonBody }) {
  const people = new Map();
  const person = (userId) => {
    if (!people.has(userId)) {
      const found = accounts.byUserId(userId);
      let membership = null;
      try { membership = require('./membership').tierOf(userId); } catch (error) { /* no memberships */ }
      people.set(userId, { userId, name: found ? found.name : 'Deleted account', admin: Boolean(found && found.admin), membership, posts: forums.postCount(userId) });
    }
    return people.get(userId);
  };

  function threadSummary(t) {
    return {
      id: t.id, forumId: t.forumId, title: t.title, author: { userId: t.author, name: person(t.author).name },
      replies: Math.max(0, t.posts.length - 1), views: t.views, created: t.created, lastPostAt: t.lastPostAt,
      lastPoster: { userId: t.lastPoster, name: person(t.lastPoster).name }, pinned: t.pinned, locked: t.locked,
    };
  }

  const fail = (ctx, result, status = 400) => sendJson(ctx, status, { error: result.error });
  const isJson = (ctx) => /application\/json/i.test(String(ctx.req.headers['content-type'] || ''));

  function handles(action) {
    return /^forum(?:\/|$)/.test(action);
  }

  async function route(ctx, viewer, action, method) {
    people.clear();
    const me = viewer ? viewer.userId : 0;
    const admin = Boolean(me && forums.isAdmin(me));
    const q = ctx.queryLower;
    if (method === 'POST' && !isJson(ctx)) return sendJson(ctx, 415, { error: 'Send JSON.' });

    if (action === 'forum' && method === 'GET') {
      const sections = forums.sections().map((section) => Object.assign({}, section, {
        forums: section.forums.map((f) => Object.assign({}, f, { last: f.last ? Object.assign({}, f.last, { by: { userId: f.last.by, name: person(f.last.by).name } }) : null })),
      }));
      return sendJson(ctx, 200, { sections, signedIn: Boolean(viewer), admin });
    }
    let match = /^forum\/(\d{1,3})$/.exec(action);
    if (match && method === 'GET') {
      const f = forums.forum(match[1]);
      if (!f) return sendJson(ctx, 404, { error: 'No such forum.' });
      const page = forums.threadsOf(f.id, { page: q.page, search: q.search || '' });
      return sendJson(ctx, 200, {
        forum: { id: f.id, name: f.name, description: f.description, section: f.section, adminOnly: Boolean(f.adminOnly) },
        threads: page.threads.map(threadSummary), total: page.total, page: page.page, pages: page.pages,
        canPost: Boolean(viewer) && (!f.adminOnly || admin), admin,
      });
    }
    match = /^forum\/thread\/(\d{1,12})$/.exec(action);
    if (match && method === 'GET') {
      const t = forums.view(match[1]);
      if (!t) return sendJson(ctx, 404, { error: 'No such thread.' });
      const f = forums.forum(t.forumId);
      const page = forums.postsOf(t, { page: q.page === 'last' ? 1e9 : q.page });
      return sendJson(ctx, 200, {
        thread: threadSummary(t), forum: { id: f.id, name: f.name, section: f.section },
        posts: page.posts.map((p) => ({
          id: p.id, author: person(p.author), text: p.deleted ? '' : p.text, deleted: p.deleted, at: p.at, edited: p.edited,
          canEdit: Boolean(me) && !p.deleted && (p.author === me || admin), first: p.id === t.posts[0].id,
        })),
        total: page.total, page: page.page, pages: page.pages, canReply: Boolean(viewer) && (!t.locked || admin), admin,
        forums: admin ? forums.SECTIONS.flatMap((s) => s.forums.map((x) => ({ id: x.id, name: x.name }))) : undefined,
      });
    }
    if (method !== 'POST') return sendJson(ctx, 404, { error: 'unknown forum request' });
    if (!viewer) return sendJson(ctx, 401, { error: 'Log in to post.' });
    const body = await jsonBody(ctx);
    match = /^forum\/(\d{1,3})\/threads$/.exec(action);
    if (match) {
      const result = forums.startThread(me, match[1], body.title, body.text);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { thread: threadSummary(result.thread) });
    }
    match = /^forum\/thread\/(\d{1,12})\/(reply|moderate|delete)$/.exec(action);
    if (match) {
      let result;
      if (match[2] === 'reply') result = forums.reply(me, match[1], body.text);
      else if (match[2] === 'moderate') result = forums.moderate(me, match[1], { pinned: body.pinned, locked: body.locked, forumId: body.forumId });
      else result = forums.removeThread(me, match[1]);
      if (result.error) return fail(ctx, result);
      if (result.deletedThread) return sendJson(ctx, 200, { deleted: true, forumId: result.forumId });
      const t = result.thread;
      return sendJson(ctx, 200, { thread: threadSummary(t), postId: result.post ? result.post.id : null, pages: forums.postsOf(t).pages });
    }
    match = /^forum\/post\/(\d{1,12})\/(edit|delete|report)$/.exec(action);
    if (match) {
      if (match[2] === 'report') {
        const found = forums.findPost(match[1]);
        if (!found || found.post.deleted) return sendJson(ctx, 404, { error: 'No such post.' });
        try {
          require('./reports').add({
            source: 'forum', reporterId: me, reportedId: found.post.author, reason: String(body.reason || 'Forum post').slice(0, 80),
            text: `Forum post ${found.post.id} in "${found.thread.title}":\n${found.post.text.slice(0, 1500)}`,
          });
        } catch (error) {
          return sendJson(ctx, error.status || 400, { error: error.message });
        }
        return sendJson(ctx, 200, { ok: true });
      }
      const result = match[2] === 'edit' ? forums.edit(me, match[1], body.text) : forums.removePost(me, match[1]);
      if (result.error) return fail(ctx, result);
      if (result.deletedThread) return sendJson(ctx, 200, { deleted: true, forumId: result.forumId });
      return sendJson(ctx, 200, { ok: true, thread: threadSummary(result.thread) });
    }
    return sendJson(ctx, 404, { error: 'unknown forum request' });
  }

  return { handles, route };
};
