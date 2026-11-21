'use strict';

// The Android app's Forums (More > Forum opens Forum/default.aspx; the APK
// build points it here): 2017's addresses, plain HTML and forms on m.<domain>
// with the app's session cookie (lib/mobile.js). Rules: lib/forums.js.
// Pinning, locking and moving are done on the website.
//
//   GET  Forum/default.aspx                         sections and forums
//   GET  Forum/ShowForum.aspx?ForumID=&page=        a forum's threads
//   GET  Forum/ShowPost.aspx?PostID=<thread>&page=  a thread (PostID is the thread's ID here)
//   GET  Forum/AddPost.aspx?ForumID=                a new thread
//   POST Forum/AddPost.aspx                         forumId, title, text  |  threadId, text (a reply)
//   POST Forum/DeletePost.aspx                      postId (your own)

const accounts = require('./accounts');
const forums = require('./forums');

const FORM_LIMIT = 16 * 1024;

const STYLE = `<style>
.msg{border-radius:4px;padding:10px;margin-bottom:10px;background:#e8f8ee;color:#027a3a}.msg.bad{background:#fdeaea;color:#a12b2b}
h2{font-size:14px;font-weight:600;margin:16px 2px 6px;color:#555;text-transform:uppercase;letter-spacing:.5px}
.row{display:block;background:#fff;border-radius:4px;padding:10px;margin-bottom:6px;color:#191919;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.row b{display:block}.sub{font-size:13px;color:#757575}.pin{color:#f68802;font-weight:600}
.post{background:#fff;border-radius:4px;padding:10px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.post .who{font-weight:600}.post .who a{color:#191919;text-decoration:none}.post .txt{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}
.post.gone .txt{color:#999;font-style:italic}
.b{border:0;border-radius:4px;font-weight:600;font-size:14px;padding:8px 14px;background:#00a2ff;color:#fff;text-decoration:none;display:inline-block}
.b.grey{background:#fff;color:#191919;box-shadow:inset 0 0 0 1px #bbb}.b.small{font-size:12px;padding:4px 8px}
.form label{display:block;margin-bottom:10px;font-size:14px;color:#555}.form input,.form textarea{display:block;width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px;margin-top:3px;font-family:inherit}
.pages{display:flex;justify-content:space-between;margin:10px 0;font-size:14px}.pages a{color:#00a2ff}
.crumbs{font-size:13px;margin:0 2px 8px}.crumbs a{color:#00a2ff;text-decoration:none}
</style>`;

module.exports = function mobileForum({ page, escapeHtml, send, hostOf, NEXT }) {
  const q = (ctx, name) => String(ctx.queryLower[name.toLowerCase()] ?? '');
  const redirect = (ctx, location) => send(ctx, 303, { Location: location, 'Cache-Control': 'no-store' }, '');
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : 'Deleted account';
  };
  const when = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const note = (ctx) => {
    const text = q(ctx, 'msg').slice(0, 200);
    return text ? `<div class="msg${q(ctx, 'ok') === '1' ? '' : ' bad'}">${escapeHtml(text)}</div>` : '';
  };
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const back = (path, text, ok) => `${path}${path.includes('?') ? '&' : '?'}${ok ? 'ok=1&' : ''}msg=${encodeURIComponent(text)}`;
  const pager = (pageInfo, href) => (pageInfo.pages > 1
    ? `<div class="pages">${pageInfo.page > 1 ? `<a href="${href(pageInfo.page - 1)}">‹ Back</a>` : '<span></span>'}<span>${pageInfo.page} / ${pageInfo.pages}</span>${pageInfo.page < pageInfo.pages ? `<a href="${href(pageInfo.page + 1)}">Next ›</a>` : '<span></span>'}</div>`
    : '');

  function sameSite(ctx) {
    const from = String(ctx.req.headers.origin || ctx.req.headers.referer || '');
    try {
      return new URL(from).hostname.toLowerCase() === hostOf(ctx);
    } catch (error) {
      return false;
    }
  }

  function index(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    let body = `${STYLE}<h1>Forums</h1>`;
    for (const section of forums.sections()) {
      body += `<h2>${escapeHtml(section.name)}</h2>`;
      for (const f of section.forums) {
        body += `<a class="row" href="/Forum/ShowForum.aspx?ForumID=${f.id}"><b>${escapeHtml(f.name)}</b><span class="sub">${escapeHtml(f.description)}</span>`
          + `<div class="sub">${count(f.threads, 'thread', 'threads')} · ${count(f.posts, 'post', 'posts')}${f.last ? ` · last ${escapeHtml(when(f.last.at))} by ${escapeHtml(nameOf(f.last.by))}` : ''}</div></a>`;
      }
    }
    page(ctx, 'Forums', body);
  }

  function showForum(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const f = forums.forum(q(ctx, 'ForumID'));
    if (!f) return page(ctx, 'Forums', `${STYLE}<p class="note">No such forum.<br><br><a href="/Forum/default.aspx">Forums</a></p>`);
    const who = accounts.fromRequest(ctx.req);
    const result = forums.threadsOf(f.id, { page: q(ctx, 'page') });
    let body = `${STYLE}<div class="crumbs"><a href="/Forum/default.aspx">Forums</a> › ${escapeHtml(f.section)}</div><h1>${escapeHtml(f.name)}</h1>${note(ctx)}`;
    if (who && (!f.adminOnly || forums.isAdmin(who.userId))) body += `<p><a class="b" href="/Forum/AddPost.aspx?ForumID=${f.id}">New Thread</a></p>`;
    if (!result.threads.length) body += '<p class="note">No threads yet.</p>';
    for (const t of result.threads) {
      body += `<a class="row" href="/Forum/ShowPost.aspx?PostID=${t.id}"><b>${t.pinned ? '<span class="pin">Pinned · </span>' : ''}${t.locked ? '🔒 ' : ''}${escapeHtml(t.title)}</b>`
        + `<div class="sub">${escapeHtml(nameOf(t.author))} · ${count(t.posts.length - 1, 'reply', 'replies')} · ${count(t.views, 'view', 'views')} · last ${escapeHtml(when(t.lastPostAt))}</div></a>`;
    }
    body += pager(result, (n) => `/Forum/ShowForum.aspx?ForumID=${f.id}&page=${n}`);
    page(ctx, f.name, body);
  }

  function showPost(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const t = forums.view(q(ctx, 'PostID'));
    if (!t) return page(ctx, 'Forums', `${STYLE}<p class="note">No such thread.<br><br><a href="/Forum/default.aspx">Forums</a></p>`);
    const f = forums.forum(t.forumId);
    const who = accounts.fromRequest(ctx.req);
    const result = forums.postsOf(t, { page: q(ctx, 'page') === 'last' ? 1e9 : q(ctx, 'page') });
    let body = `${STYLE}<div class="crumbs"><a href="/Forum/default.aspx">Forums</a> › <a href="/Forum/ShowForum.aspx?ForumID=${f.id}">${escapeHtml(f.name)}</a></div>`
      + `<h1>${t.locked ? '🔒 ' : ''}${escapeHtml(t.title)}</h1>${note(ctx)}`;
    for (const p of result.posts) {
      const mine = who && p.author === who.userId && !p.deleted;
      body += `<div class="post${p.deleted ? ' gone' : ''}"><div class="who"><a href="/users/${p.author}/profile">${escapeHtml(nameOf(p.author))}</a></div>`
        + `<div class="sub">${escapeHtml(when(p.at))}${p.edited ? ' · edited' : ''} · ${count(forums.postCount(p.author), 'post', 'posts')}</div>`
        + `<div class="txt">${p.deleted ? 'This post was deleted.' : escapeHtml(p.text)}</div>`
        + (mine ? `<form method="post" action="/Forum/DeletePost.aspx" style="margin-top:6px"><input type="hidden" name="postId" value="${p.id}"><button class="b grey small">Delete</button></form>` : '')
        + '</div>';
    }
    body += pager(result, (n) => `/Forum/ShowPost.aspx?PostID=${t.id}&page=${n}`);
    if (who && (!t.locked || forums.isAdmin(who.userId))) {
      body += `<form class="form" method="post" action="/Forum/AddPost.aspx"><input type="hidden" name="threadId" value="${t.id}">`
        + `<label>Reply<textarea name="text" rows="5" maxlength="${forums.MAX_TEXT}"></textarea></label><button class="b">Post Reply</button></form>`;
    } else if (t.locked) body += '<p class="sub">This thread is locked.</p>';
    else body += '<p class="sub">Sign in to the app to reply.</p>';
    page(ctx, t.title, body);
  }

  function addPostPage(ctx) {
    const who = accounts.fromRequest(ctx.req);
    const f = forums.forum(q(ctx, 'ForumID'));
    if (!who || !f) return page(ctx, 'Forums', `${STYLE}<p class="note">${who ? 'No such forum.' : 'Sign in to the app first.'}</p>`);
    page(ctx, 'New Thread', `${STYLE}<div class="crumbs"><a href="/Forum/ShowForum.aspx?ForumID=${f.id}">${escapeHtml(f.name)}</a></div><h1>New Thread</h1>${note(ctx)}`
      + `<form class="form" method="post" action="/Forum/AddPost.aspx"><input type="hidden" name="forumId" value="${f.id}">`
      + `<label>Title<input name="title" maxlength="${forums.MAX_TITLE}" value="${escapeHtml(q(ctx, 'title').slice(0, forums.MAX_TITLE))}"></label>`
      + `<label>Post<textarea name="text" rows="8" maxlength="${forums.MAX_TEXT}"></textarea></label><button class="b">Post Thread</button></form>`);
  }

  async function addPost(ctx) {
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Post from the app.');
    const who = accounts.fromRequest(ctx.req);
    const fields = new URLSearchParams((await ctx.body(FORM_LIMIT)).toString('utf8'));
    if (!who) return redirect(ctx, '/Forum/default.aspx');
    if (fields.get('threadId')) {
      const threadId = Number(fields.get('threadId'));
      const result = forums.reply(who.userId, threadId, fields.get('text'));
      if (result.error) return redirect(ctx, back(`/Forum/ShowPost.aspx?PostID=${threadId}&page=last`, result.error));
      return redirect(ctx, back(`/Forum/ShowPost.aspx?PostID=${threadId}&page=last`, 'Posted.', true));
    }
    const forumId = Number(fields.get('forumId'));
    const result = forums.startThread(who.userId, forumId, fields.get('title'), fields.get('text'));
    if (result.error) return redirect(ctx, back(`/Forum/AddPost.aspx?ForumID=${forumId}&title=${encodeURIComponent(fields.get('title') || '')}`, result.error));
    return redirect(ctx, `/Forum/ShowPost.aspx?PostID=${result.thread.id}`);
  }

  async function deletePost(ctx) {
    if (ctx.method !== 'POST') return NEXT;
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Do this from the app.');
    const who = accounts.fromRequest(ctx.req);
    const fields = new URLSearchParams((await ctx.body(FORM_LIMIT)).toString('utf8'));
    const found = forums.findPost(fields.get('postId'));
    if (!who || !found) return redirect(ctx, '/Forum/default.aspx');
    const result = forums.removePost(who.userId, found.post.id);
    if (result.deletedThread) return redirect(ctx, back(`/Forum/ShowForum.aspx?ForumID=${result.forumId}`, 'Thread deleted.', true));
    return redirect(ctx, back(`/Forum/ShowPost.aspx?PostID=${found.thread.id}`, result.error || 'Post deleted.', !result.error));
  }

  return {
    pageRoutes: [
      [/^forum\/?(?:default\.aspx)?$/i, index],
      [/^forum\/showforum\.aspx$/i, showForum],
      [/^forum\/showpost\.aspx$/i, showPost],
      [/^forum\/addpost\.aspx$/i, (ctx) => (ctx.method === 'POST' ? addPost(ctx) : addPostPage(ctx))],
      [/^forum\/deletepost\.aspx$/i, deletePost],
    ],
  };
};
