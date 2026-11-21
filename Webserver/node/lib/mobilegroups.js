'use strict';

// The Android app's Groups pages (More > Groups opens my/groups; its search
// opens search/groups?keyword=): plain HTML and forms on m.<domain> with the
// app's session cookie (lib/mobile.js). Rules: lib/groups.js. Ranks, roles,
// emblems and settings are changed on the launcher or the website.
//
//   GET  my/groups                      your groups, search, Create
//   GET  search/groups?keyword=         groups by name
//   GET  groups/<id>[/<name>]           a group (web views only; the engine's groups/<id> goes on)
//   GET  groups/<id>/members?page=
//   GET  groups/create                  POST groups/create  name, description, public
//   POST groups/<id>/join | leave | wall (text) | shout (text) | requests (userId, accept=1|0)

const accounts = require('./accounts');
const groups = require('./groups');

const FORM_LIMIT = 8 * 1024;

const STYLE = `<style>
.msg{border-radius:4px;padding:10px;margin-bottom:10px;background:#e8f8ee;color:#027a3a}.msg.bad{background:#fdeaea;color:#a12b2b}
h2{font-size:16px;font-weight:600;margin:16px 2px 8px}
.search{display:flex;gap:6px;margin-bottom:10px}.search input{flex:1;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px}
.list{display:flex;flex-direction:column;gap:6px}
.row{display:flex;align-items:center;gap:10px;background:#fff;border-radius:4px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,.12);color:#191919;text-decoration:none}
.row img,.row .ph{width:52px;height:52px;border-radius:6px;background:#eee;object-fit:cover;flex:none}
.row .t{flex:1;min-width:0}.row b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{font-size:13px;color:#757575}
.card{background:#fff;border-radius:4px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.12);margin-bottom:10px}
.head{display:flex;gap:12px;align-items:center}.head img,.head .ph{width:96px;height:96px;border-radius:8px;background:#eee;object-fit:cover;flex:none}
.head h1{margin:0 0 2px;overflow-wrap:anywhere}.desc{white-space:pre-wrap;overflow-wrap:anywhere}
.shout{border-left:3px solid #00a2ff;padding:6px 10px;background:#f2f9ff;margin-top:8px;overflow-wrap:anywhere}
.btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.btns form{margin:0}
.b{border:0;border-radius:4px;font-weight:600;font-size:14px;padding:8px 14px;background:#00a2ff;color:#fff;text-decoration:none;display:inline-block}
.b.green{background:#02b757}.b.grey{background:#fff;color:#191919;box-shadow:inset 0 0 0 1px #bbb}
.post{border-top:1px solid #eee;padding:8px 0}.post:first-child{border-top:0}.post .who{font-weight:600;font-size:14px}.post .when{font-size:12px;color:#757575}
.post .txt{white-space:pre-wrap;overflow-wrap:anywhere}
.form label{display:block;margin-bottom:10px;font-size:14px;color:#555}.form input[type=text],.form textarea{display:block;width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px;margin-top:3px;font-family:inherit}
.pages{display:flex;justify-content:space-between;margin:10px 0;font-size:14px}.pages a{color:#00a2ff}
</style>`;

module.exports = function mobileGroups({ page, escapeHtml, send, hostOf, NEXT }) {
  const q = (ctx, name) => String(ctx.queryLower[name.toLowerCase()] ?? '');
  const redirect = (ctx, location) => send(ctx, 303, { Location: location, 'Cache-Control': 'no-store' }, '');
  const wantsHtml = (ctx) => /text\/html/i.test(String(ctx.req.headers.accept || ''));
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : 'Deleted account';
  };
  const ownerName = (g) => (g.owner ? nameOf(g.owner) : groups.WEBSITE);
  const emblem = (g, cls = '') => (g.emblem
    ? `<img${cls} src="/group-thumbnail/image?groupId=${g.id}&amp;v=${Date.parse(g.emblem.at).toString(36)}" alt="" loading="lazy">`
    : `<span class="ph"${cls}></span>`);
  const note = (ctx) => {
    const text = q(ctx, 'msg').slice(0, 200);
    return text ? `<div class="msg${q(ctx, 'ok') === '1' ? '' : ' bad'}">${escapeHtml(text)}</div>` : '';
  };
  const back = (path, text, ok) => `${path}${path.includes('?') ? '&' : '?'}${ok ? 'ok=1&' : ''}msg=${encodeURIComponent(text)}`;
  const when = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  function sameSite(ctx) {
    const from = String(ctx.req.headers.origin || ctx.req.headers.referer || '');
    try {
      return new URL(from).hostname.toLowerCase() === hostOf(ctx);
    } catch (error) {
      return false;
    }
  }

  async function form(ctx) {
    return new URLSearchParams((await ctx.body(FORM_LIMIT)).toString('utf8'));
  }

  function groupRow(g, extra = '') {
    return `<a class="row" href="/groups/${g.id}">${emblem(g)}<span class="t"><b>${escapeHtml(g.name)}</b>`
      + `<span class="sub">${extra ? `${escapeHtml(extra)} · ` : ''}${g.members.length} ${g.members.length === 1 ? 'member' : 'members'}</span></span></a>`;
  }

  const searchBox = (keyword = '') => '<form class="search" method="get" action="/search/groups">'
    + `<input name="keyword" value="${escapeHtml(keyword)}" placeholder="Find groups" maxlength="50"></form>`;

  function myGroups(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    let body = `${STYLE}<h1>Groups</h1>${note(ctx)}${searchBox()}`;
    if (!who) return page(ctx, 'Groups', `${body}<p class="note">Sign in to the app to join groups.</p>`);
    const mine = groups.groupsOf(who.userId);
    body += `<div class="btns" style="margin:0 0 10px"><a class="b green" href="/groups/create">Create Group</a></div>`;
    body += mine.length ? `<div class="list">${mine.map(({ group, membership }) => groupRow(group, membership.role)).join('')}</div>`
      : '<p class="note">You are not in any groups yet. Find some above.</p>';
    if (!q(ctx, 'keyword')) {
      const popular = groups.search('', 10).filter((g) => !groups.memberOf(g, who.userId));
      if (popular.length) body += `<h2>Popular</h2><div class="list">${popular.map((g) => groupRow(g)).join('')}</div>`;
    }
    page(ctx, 'Groups', body);
  }

  function searchPage(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const keyword = q(ctx, 'keyword').slice(0, 50);
    const found = groups.search(keyword, 40);
    page(ctx, 'Groups', `${STYLE}<h1>Groups</h1>${searchBox(keyword)}`
      + (found.length ? `<div class="list">${found.map((g) => groupRow(g)).join('')}</div>` : '<p class="note">No groups found.</p>'));
  }

  function action(path, label, kind, fields = '') {
    return `<form method="post" action="${path}">${fields}<button class="b ${kind}">${label}</button></form>`;
  }

  function groupPage(ctx, match) {
    if (!wantsHtml(ctx) || ctx.method !== 'GET') return NEXT;
    const g = groups.get(match[1]);
    if (!g) return page(ctx, 'Groups', `${STYLE}<p class="note">No such group.<br><br><a href="/my/groups">Groups</a></p>`);
    const who = accounts.fromRequest(ctx.req);
    const mine = who ? groups.membership(g.id, who.userId) : null;
    const manage = Boolean(who && groups.canManage(g, who.userId));
    const base = `/groups/${g.id}`;
    let buttons = '';
    if (who) {
      if (mine) {
        if (g.owner !== who.userId) buttons += action(`${base}/leave`, 'Leave Group', 'grey');
      } else if (g.requests.some((r) => r.userId === who.userId)) {
        buttons += action(`${base}/leave`, 'Request Sent (cancel)', 'grey');
      } else buttons += action(`${base}/join`, g.public ? 'Join Group' : 'Ask to Join', 'green');
    }
    let body = `${STYLE}${note(ctx)}<div class="card"><div class="head">${emblem(g)}<div><h1>${escapeHtml(g.name)}</h1>`
      + `<div class="sub">By ${escapeHtml(ownerName(g))} · ${g.members.length} ${g.members.length === 1 ? 'member' : 'members'}</div>`
      + `${mine ? `<div class="sub">Your rank: ${escapeHtml(mine.role)}</div>` : ''}</div></div>`
      + (g.shout ? `<div class="shout">${escapeHtml(g.shout.text)}<div class="sub">${escapeHtml(nameOf(g.shout.by))} · ${escapeHtml(when(g.shout.at))}</div></div>` : '')
      + `<div class="btns">${buttons}<a class="b grey" href="${base}/members">Members</a></div></div>`;
    if (g.description) body += `<div class="card"><h2 style="margin-top:0">About</h2><div class="desc">${escapeHtml(g.description)}</div></div>`;
    if (manage) {
      body += `<div class="card"><h2 style="margin-top:0">Shout</h2><form class="form" method="post" action="${base}/shout">`
        + `<label><input type="text" name="text" maxlength="${groups.MAX_SHOUT}" value="${escapeHtml(g.shout ? g.shout.text : '')}"></label><button class="b">Shout</button></form></div>`;
      if (g.requests.length) {
        body += `<div class="card"><h2 style="margin-top:0">Requests (${g.requests.length})</h2>${g.requests.slice(0, 30).map((r) => `<div class="post"><span class="who">${escapeHtml(nameOf(r.userId))}</span>`
          + `<div class="btns">${action(`${base}/requests`, 'Accept', 'green', `<input type="hidden" name="userId" value="${r.userId}"><input type="hidden" name="accept" value="1">`)}`
          + `${action(`${base}/requests`, 'Decline', 'grey', `<input type="hidden" name="userId" value="${r.userId}"><input type="hidden" name="accept" value="0">`)}</div></div>`).join('')}</div>`;
      }
    }
    body += '<div class="card"><h2 style="margin-top:0">Wall</h2>';
    if (mine) {
      body += `<form class="form" method="post" action="${base}/wall"><label><textarea name="text" rows="3" maxlength="${groups.MAX_POST}" placeholder="Say something"></textarea></label><button class="b">Post</button></form>`;
    }
    const posts = g.wall.slice(-20).reverse();
    body += posts.length ? posts.map((p) => `<div class="post"><span class="who">${escapeHtml(nameOf(p.from))}</span> <span class="when">${escapeHtml(when(p.at))}</span><div class="txt">${escapeHtml(p.text)}</div></div>`).join('')
      : '<p class="sub">No posts yet.</p>';
    body += '</div>';
    page(ctx, g.name, body);
  }

  function membersPage(ctx, match) {
    if (ctx.method !== 'GET') return NEXT;
    const g = groups.get(match[1]);
    if (!g) return page(ctx, 'Groups', `${STYLE}<p class="note">No such group.</p>`);
    const list = g.members.map((m) => ({ m, role: groups.roleOf(g, m.roleId) || groups.lowestRole(g) }))
      .sort((a, b) => b.role.rank - a.role.rank || nameOf(a.m.userId).localeCompare(nameOf(b.m.userId)));
    const per = 40;
    const pages = Math.max(1, Math.ceil(list.length / per));
    const number = Math.min(pages, Math.max(1, Number(q(ctx, 'page')) || 1));
    let body = `${STYLE}<h1>${escapeHtml(g.name)}</h1><div class="list">${list.slice((number - 1) * per, number * per).map(({ m, role }) => `<a class="row" href="/users/${m.userId}/profile">`
      + `<img src="/headshot-thumbnail/image?userId=${m.userId}&amp;width=150&amp;height=150&amp;format=png" alt="" loading="lazy"><span class="t"><b>${escapeHtml(nameOf(m.userId))}</b><span class="sub">${escapeHtml(role.name)}</span></span></a>`).join('')}</div>`;
    if (!list.length) body += '<p class="note">No members yet.</p>';
    if (pages > 1) {
      body += `<div class="pages">${number > 1 ? `<a href="/groups/${g.id}/members?page=${number - 1}">‹ Back</a>` : '<span></span>'}<span>${number} / ${pages}</span>`
        + `${number < pages ? `<a href="/groups/${g.id}/members?page=${number + 1}">More ›</a>` : '<span></span>'}</div>`;
    }
    body += `<p><a href="/groups/${g.id}">Back to the group</a></p>`;
    page(ctx, g.name, body);
  }

  function createPage(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) return page(ctx, 'Create Group', `${STYLE}<p class="note">Sign in to the app first.</p>`);
    page(ctx, 'Create Group', `${STYLE}<h1>Create Group</h1>${note(ctx)}<form class="form card" method="post" action="/groups/create">`
      + `<label>Name<input type="text" name="name" maxlength="${groups.MAX_NAME}" value="${escapeHtml(q(ctx, 'name').slice(0, groups.MAX_NAME))}"></label>`
      + `<label>Description<textarea name="description" rows="4" maxlength="${groups.MAX_DESCRIPTION}"></textarea></label>`
      + '<label><input type="checkbox" name="public" value="1" checked> Anyone can join</label>'
      + `<button class="b green">Create for R$ ${groups.COST}</button></form><p class="sub">Add a picture from the launcher or the website.</p>`);
  }

  async function post(ctx, match) {
    if (ctx.method !== 'POST') return send(ctx, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Do this from the app.');
    const who = accounts.fromRequest(ctx.req);
    const fields = await form(ctx);
    if (match[1] === 'create') {
      if (!who) return redirect(ctx, '/my/groups');
      const result = groups.create(who.userId, { name: fields.get('name'), description: fields.get('description'), public: fields.get('public') === '1' });
      if (result.error) return redirect(ctx, back(`/groups/create?name=${encodeURIComponent(fields.get('name') || '')}`, result.error));
      return redirect(ctx, back(`/groups/${result.group.id}`, `Made ${result.group.name}.`, true));
    }
    const base = `/groups/${match[1]}`;
    if (!who) return redirect(ctx, back(base, 'Sign in to the app first.'));
    const verb = match[2];
    let result;
    let done = '';
    if (verb === 'join') {
      result = groups.join(match[1], who.userId);
      done = result.requested ? 'Asked to join.' : 'Joined.';
    } else if (verb === 'leave') {
      result = groups.leave(match[1], who.userId);
      done = 'Left the group.';
    } else if (verb === 'wall') {
      result = groups.post(match[1], who.userId, fields.get('text'));
      done = 'Posted.';
    } else if (verb === 'shout') {
      result = groups.setShout(match[1], who.userId, fields.get('text'));
      done = 'Shout updated.';
    } else {
      result = groups.answerRequest(match[1], who.userId, Number(fields.get('userId')), fields.get('accept') === '1');
      done = fields.get('accept') === '1' ? 'Accepted.' : 'Declined.';
    }
    return redirect(ctx, result.error ? back(base, result.error) : back(base, done, true));
  }

  return {
    pageRoutes: [
      [/^my\/groups\/?$/i, myGroups],
      [/^search\/groups\/?$/i, searchPage],
      [/^groups\/create\/?$/i, (ctx) => (ctx.method === 'GET' ? createPage(ctx) : post(ctx, ['', 'create']))],
      [/^groups\/(\d{1,15})\/members\/?$/i, membersPage],
      [/^groups\/(\d{1,15})\/(join|leave|wall|shout|requests)\/?$/i, post],
      [/^groups\/(\d{1,15})(?:\/[^/]*)?\/?$/i, groupPage],
    ],
  };
};
