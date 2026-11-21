'use strict';

// The Android app's friends, profile, player search and Messages pages: web
// pages it opens on m.<domain> (lib/mobile.js), plain HTML and forms with the
// app's session cookie. Chat itself is native (lib/mobilechat.js).
//
//   GET  users/<id>/friends        friends (yours: requests first; the app adds #!/friend-requests)
//   POST users/friends/<verb>      verb request|accept|decline|cancel|remove; userId, back
//   GET  users/<id>/profile        a profile with friend and message buttons
//   GET  users/search?keyword=     players
//   GET  my/messages/              ?folder=inbox|sent|archive&page=, ?id= one message, ?to= write one
//   POST my/messages/send          to, subject, body, replyTo
//   POST my/messages/<id>/archive  archived=1|0
//
// The game engine also asks users/<id>/friends (Players:GetFriendsAsync);
// only web views (Accept: text/html) get the page, others go on (NEXT).

const accounts = require('./accounts');
const blocks = require('./blocks');
const friends = require('./friends');
const messages = require('./messages');

const FORM_LIMIT = 8 * 1024;

const STYLE = `<style>
.msg{border-radius:4px;padding:10px;margin-bottom:10px;background:#e8f8ee;color:#027a3a}.msg.bad{background:#fdeaea;color:#a12b2b}
h2{font-size:16px;font-weight:600;margin:16px 2px 8px}
.people{display:flex;flex-direction:column;gap:6px}
.person{display:flex;align-items:center;gap:10px;background:#fff;border-radius:4px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.person img{width:48px;height:48px;border-radius:50%;background:#eee;object-fit:cover;flex:none}
.person .who{flex:1;min-width:0}.person a.n{color:#191919;font-weight:600;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.where{font-size:13px;color:#757575}.where.game{color:#02b757}.where.online{color:#00a2ff}.where.studio{color:#f68802}
.btns{display:flex;gap:4px;flex:none}.btns form{margin:0}
.b{border:0;border-radius:4px;font-weight:600;font-size:14px;padding:7px 12px;background:#00a2ff;color:#fff;text-decoration:none;display:inline-block}
.b.green{background:#02b757}.b.grey{background:#fff;color:#191919;box-shadow:inset 0 0 0 1px #bbb}
.card{background:#fff;border-radius:4px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.12);margin-bottom:10px}
.prof{display:flex;gap:12px;align-items:center}.prof img{width:96px;height:96px;border-radius:50%;background:#eee;object-fit:cover}
.prof h1{margin:0 0 2px}.stats{display:flex;gap:16px;margin:8px 0}.stats b{display:block;font-size:18px}.stats span{font-size:12px;color:#757575}
.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.row form{margin:0}.bio{white-space:pre-wrap;overflow-wrap:anywhere}
.search{display:flex;gap:6px;margin-bottom:10px}.search input{flex:1;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px}
.tabs{display:flex;gap:6px;margin-bottom:10px}.tabs a{flex:1;text-align:center;background:#fff;color:#191919;text-decoration:none;border-radius:4px;padding:8px;font-size:14px}
.tabs a.on{background:#00a2ff;color:#fff}
.mail{display:block;background:#fff;border-radius:4px;padding:10px;margin-bottom:6px;color:#191919;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.mail.unread{box-shadow:inset 3px 0 0 #00a2ff,0 1px 2px rgba(0,0,0,.12)}.mail b{display:block}.mail .s{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mail .t{float:right;font-size:12px;color:#757575}.body{white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid #e3e3e3;padding-top:10px;margin-top:8px}
.form label{display:block;margin-bottom:10px;font-size:14px;color:#555}.form input,.form textarea{display:block;width:100%;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px;margin-top:3px;font-family:inherit}
.pages{display:flex;justify-content:space-between;align-items:center;margin:10px 0;font-size:14px;color:#757575}.pages a{color:#00a2ff}
</style>`;

const WHERE = { game: 'In a game', studio: 'In Studio', online: 'Online', offline: 'Offline' };

module.exports = function mobileSocial({ page, escapeHtml, send, launcher, hostOf, NEXT }) {
  const q = (ctx, name) => String(ctx.queryLower[name.toLowerCase()] ?? '');
  const redirect = (ctx, location) => send(ctx, 303, { Location: location, 'Cache-Control': 'no-store' }, '');
  const wantsHtml = (ctx) => /text\/html/i.test(String(ctx.req.headers.accept || ''));
  const picture = (userId) => `/headshot-thumbnail/image?userId=${encodeURIComponent(userId)}&width=150&height=150&format=png`;
  const note = (ctx) => {
    const text = q(ctx, 'msg').slice(0, 200);
    return text ? `<div class="msg${q(ctx, 'ok') === '1' ? '' : ' bad'}">${escapeHtml(text)}</div>` : '';
  };
  const backTo = (path, text, ok) => `${path}${path.includes('?') ? '&' : '?'}${ok ? 'ok=1&' : ''}msg=${encodeURIComponent(text)}`;
  const safeBack = (value, fallback) => (/^\/(?![/\\])[A-Za-z0-9\-_/.?=&%]*$/.test(String(value || '')) ? String(value).replace(/[?&](?:ok|msg)=[^&]*/g, '') : fallback);

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

  function whereOf(account) {
    const seen = launcher.presence(account.userId, account.name);
    const kind = seen.presence || 'offline';
    const text = kind === 'game' && seen.online && seen.online.gameName ? seen.online.gameName : WHERE[kind] || 'Offline';
    return `<div class="where ${kind}">${escapeHtml(text)}</div>`;
  }

  function friendButton(verb, userId, label, kind, back) {
    return `<form method="post" action="/users/friends/${verb}"><input type="hidden" name="userId" value="${userId}">`
      + `<input type="hidden" name="back" value="${escapeHtml(back)}"><button class="b ${kind}">${label}</button></form>`;
  }

  function personRow(account, buttons = '') {
    return `<div class="person"><img src="${picture(account.userId)}" alt="" loading="lazy"><div class="who">`
      + `<a class="n" href="/users/${account.userId}/profile">${escapeHtml(account.name)}</a>${whereOf(account)}</div>`
      + `${buttons ? `<div class="btns">${buttons}</div>` : ''}</div>`;
  }

  const live = (ids) => ids.map((id) => accounts.byUserId(id)).filter(Boolean);

  function friendsPage(ctx, match) {
    if (!wantsHtml(ctx) || ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    const owner = accounts.byUserId(match[1]);
    if (!owner) return page(ctx, 'Friends', `${STYLE}<p class="note">Nobody here has that user ID.</p>`);
    const mine = Boolean(who && who.userId === owner.userId);
    const back = `/users/${owner.userId}/friends`;
    let body = `${STYLE}<h1>${mine ? 'Friends' : `${escapeHtml(owner.name)}'s Friends`}</h1>${note(ctx)}`
      + '<form class="search" method="get" action="/users/search"><input name="keyword" placeholder="Find players" maxlength="20"></form>';
    if (mine) {
      const incoming = live(friends.incoming(who.userId).map((r) => r.from));
      if (incoming.length) {
        body += `<h2>Friend Requests (${incoming.length})</h2><div class="people">${incoming.map((account) => personRow(account,
          friendButton('accept', account.userId, 'Accept', 'green', back) + friendButton('decline', account.userId, 'Decline', 'grey', back))).join('')}</div>`;
      }
    }
    const list = live(friends.friendIds(owner.userId)).sort((a, b) => a.name.localeCompare(b.name));
    body += `<h2>Friends (${list.length})</h2>`;
    body += list.length ? `<div class="people">${list.map((account) => personRow(account)).join('')}</div>`
      : `<p class="note">${mine ? 'No friends yet. Find players above.' : 'No friends yet.'}</p>`;
    if (mine) {
      const outgoing = live(friends.outgoing(who.userId).map((r) => r.to));
      if (outgoing.length) {
        body += `<h2>Sent Requests (${outgoing.length})</h2><div class="people">${outgoing.map((account) => personRow(account,
          friendButton('cancel', account.userId, 'Take back', 'grey', back))).join('')}</div>`;
      }
    }
    return page(ctx, 'Friends', body);
  }

  const DONE = {
    request: (r, name) => (r.became === 'friends' ? `You and ${name} are now friends!` : `Friend request sent to ${name}.`),
    accept: (r, name) => `You and ${name} are now friends!`,
    decline: (r, name) => `Declined ${name}'s request.`,
    cancel: (r, name) => `Took back your request to ${name}.`,
    remove: (r, name) => `${name} is no longer your friend.`,
  };

  async function friendAction(ctx, match) {
    if (ctx.method !== 'POST') return send(ctx, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Do this from the app.');
    const who = accounts.fromRequest(ctx.req);
    const fields = await form(ctx);
    const back = safeBack(fields.get('back'), '/users/search');
    if (!who) return redirect(ctx, backTo(back, 'Sign in to the app first.'));
    const other = accounts.byUserId(String(fields.get('userId') || ''));
    if (!other) return redirect(ctx, backTo(back, 'No such player.'));
    const verb = match[1].toLowerCase();
    let result;
    if (verb === 'request') result = friends.request(who.userId, other.userId);
    else if (verb === 'accept') result = friends.accept(who.userId, other.userId);
    else if (verb === 'decline' || verb === 'cancel') result = friends.dropRequest(who.userId, other.userId);
    else result = friends.unfriend(who.userId, other.userId);
    if (result.error) return redirect(ctx, backTo(back, result.error));
    return redirect(ctx, backTo(back, DONE[verb](result, other.name), true));
  }

  function profilePage(ctx, match) {
    if (!wantsHtml(ctx) || ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    const person = accounts.profile(match[1]);
    if (!person) return page(ctx, 'Profile', `${STYLE}<p class="note">Nobody here has that user ID.</p>`);
    const back = `/users/${person.userId}/profile`;
    const self = Boolean(who && who.userId === person.userId);
    const friendCount = live(friends.friendIds(person.userId)).length;
    let buttons = '';
    if (who && !self && !blocks.between(who.userId, person.userId)) {
      const status = friends.status(who.userId, person.userId);
      if (status === 'Friend') buttons += friendButton('remove', person.userId, 'Unfriend', 'grey', back);
      else if (status === 'FriendRequestSent') buttons += friendButton('cancel', person.userId, 'Request Sent', 'grey', back);
      else if (status === 'FriendRequestReceived') {
        buttons += friendButton('accept', person.userId, 'Accept', 'green', back) + friendButton('decline', person.userId, 'Decline', 'grey', back);
      } else buttons += friendButton('request', person.userId, 'Add Friend', 'green', back);
      buttons += `<a class="b" href="/my/messages/?to=${encodeURIComponent(person.name)}">Message</a>`;
      if (require('./membership').tierOf(person.userId)) buttons += `<a class="b grey" href="/my/trades/new?with=${person.userId}">Trade</a>`;
    }
    buttons += `<a class="b grey" href="/users/${person.userId}/friends">Friends</a><a class="b grey" href="/users/${person.userId}/inventory">Inventory</a>`;
    const joined = person.joinedAt ? `<p class="where">Joined ${escapeHtml(new Date(person.joinedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}</p>` : '';
    page(ctx, person.name, `${STYLE}${note(ctx)}<div class="card"><div class="prof"><img src="${picture(person.userId)}" alt="">`
      + `<div><h1>${escapeHtml(person.name)}</h1>${whereOf(person)}</div></div>`
      + `<div class="stats"><div><b>${friendCount}</b><span>Friends</span></div></div><div class="row">${buttons}</div></div>`
      + `<div class="card"><h2 style="margin-top:0">About</h2><p class="bio">${person.bio ? escapeHtml(person.bio) : '<span class="where">No bio yet.</span>'}</p>${joined}</div>`
      + groupList(person.userId));
  }

  // A profile's groups, as links.
  function groupList(userId) {
    const list = require('./groups').groupsOf(userId);
    if (!list.length) return '';
    return `<div class="card"><h2 style="margin-top:0">Groups (${list.length})</h2><div class="people">${list.slice(0, 30).map(({ group, membership }) => `<div class="person">`
      + `${group.emblem ? `<img src="/group-thumbnail/image?groupId=${group.id}" alt="" loading="lazy" style="border-radius:6px">` : '<img alt="" style="border-radius:6px">'}`
      + `<div class="who"><a class="n" href="/groups/${group.id}">${escapeHtml(group.name)}</a><div class="where">${escapeHtml(membership.role)}</div></div></div>`).join('')}</div></div>`;
  }

  function searchPage(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    const keyword = q(ctx, 'keyword').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
    const found = keyword ? accounts.search(keyword, 40).filter((account) => !who || account.userId !== who.userId) : [];
    const back = `/users/search?keyword=${encodeURIComponent(keyword)}`;
    let body = `${STYLE}<h1>Players</h1>${note(ctx)}<form class="search" method="get" action="/users/search">`
      + `<input name="keyword" value="${escapeHtml(keyword)}" placeholder="Find players" maxlength="20"></form>`;
    if (!keyword) body += '<p class="note">Type a name.</p>';
    else if (!found.length) body += '<p class="note">Nobody found.</p>';
    else {
      body += `<div class="people">${found.map((account) => {
        const status = who ? friends.status(who.userId, account.userId) : null;
        const button = status === 'NotFriend' && !blocks.between(who.userId, account.userId) ? friendButton('request', account.userId, 'Add', 'green', back)
          : status === 'FriendRequestReceived' ? friendButton('accept', account.userId, 'Accept', 'green', back) : '';
        return personRow(account, button);
      }).join('')}</div>`;
    }
    page(ctx, 'Players', body);
  }

  // --- Messages ------------------------------------------------------------------------------

  const when = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  function messagesPage(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) return page(ctx, 'Messages', `${STYLE}<p class="note">Sign in to the app first.</p>`);
    if (q(ctx, 'to') || q(ctx, 'compose')) return writePage(ctx, q(ctx, 'to'), q(ctx, 'subject'), q(ctx, 'replyto'));
    if (/^\d{1,12}$/.test(q(ctx, 'id'))) return readPage(ctx, who, q(ctx, 'id'));
    const folder = ['inbox', 'sent', 'archive'].includes(q(ctx, 'folder')) ? q(ctx, 'folder') : 'inbox';
    const result = messages.folder(who.userId, folder, q(ctx, 'page'), 20);
    const tab = (key, label) => `<a class="${key === folder ? 'on' : ''}" href="/my/messages/?folder=${key}">${label}</a>`;
    let body = `${STYLE}<h1>Messages</h1>${note(ctx)}<div class="row" style="margin:0 0 10px"><a class="b" href="/my/messages/?compose=1">New Message</a></div>`
      + `<nav class="tabs">${tab('inbox', 'Inbox')}${tab('sent', 'Sent')}${tab('archive', 'Archive')}</nav>`;
    if (!result.messages.length) body += `<p class="note">${folder === 'inbox' ? 'No messages.' : folder === 'sent' ? 'Nothing sent yet.' : 'Nothing archived.'}</p>`;
    for (const m of result.messages) {
      const mine = m.from === who.userId;
      const other = accounts.byUserId(mine ? m.to : m.from);
      const name = other ? other.name : 'Deleted account';
      body += `<a class="mail${!mine && !m.read ? ' unread' : ''}" href="/my/messages/?id=${m.id}"><span class="t">${escapeHtml(when(m.at))}</span>`
        + `<b>${mine ? 'To ' : ''}${escapeHtml(name)}</b><span class="s">${escapeHtml(m.subject)}</span></a>`;
    }
    if (result.pages > 1) {
      const link = (n, label) => `<a href="/my/messages/?folder=${folder}&page=${n}">${label}</a>`;
      body += `<div class="pages">${result.page > 1 ? link(result.page - 1, '‹ Newer') : '<span></span>'}<span>Page ${result.page} of ${result.pages}</span>`
        + `${result.page < result.pages ? link(result.page + 1, 'Older ›') : '<span></span>'}</div>`;
    }
    page(ctx, 'Messages', body);
  }

  function readPage(ctx, who, id) {
    const m = messages.get(id, who.userId);
    if (!m) return page(ctx, 'Messages', `${STYLE}<p class="note">No such message.<br><br><a href="/my/messages/">Messages</a></p>`);
    if (m.to === who.userId && !m.read) messages.mark(m.id, who.userId, { read: true });
    const mine = m.from === who.userId;
    const other = accounts.byUserId(mine ? m.to : m.from);
    const name = other ? other.name : 'Deleted account';
    const subject = m.subject.startsWith('RE: ') ? m.subject : `RE: ${m.subject}`;
    let buttons = '<a class="b grey" href="/my/messages/">Back</a>';
    if (!mine && other) {
      buttons += `<a class="b" href="/my/messages/?to=${encodeURIComponent(name)}&subject=${encodeURIComponent(subject)}&replyTo=${m.id}">Reply</a>`;
      buttons += `<form method="post" action="/my/messages/${m.id}/archive"><input type="hidden" name="archived" value="${m.archived ? '0' : '1'}">`
        + `<button class="b grey">${m.archived ? 'Move to Inbox' : 'Archive'}</button></form>`;
    }
    page(ctx, m.subject, `${STYLE}${note(ctx)}<div class="card"><h1 style="margin:0 0 4px;overflow-wrap:anywhere">${escapeHtml(m.subject)}</h1>`
      + `<div class="where">${mine ? 'To' : 'From'} ${other ? `<a href="/users/${other.userId}/profile">${escapeHtml(name)}</a>` : escapeHtml(name)} · ${escapeHtml(when(m.at))}</div>`
      + `<div class="body">${escapeHtml(m.body)}</div><div class="row">${buttons}</div></div>`);
  }

  function writePage(ctx, to, subject, replyTo) {
    page(ctx, 'New Message', `${STYLE}<h1>New Message</h1>${note(ctx)}<form class="form card" method="post" action="/my/messages/send">`
      + `<label>To<input name="to" value="${escapeHtml(String(to || '').slice(0, 20))}" maxlength="20" autocomplete="off"></label>`
      + `<label>Subject<input name="subject" value="${escapeHtml(String(subject || '').slice(0, 64))}" maxlength="64"></label>`
      + `<label>Message<textarea name="body" rows="8" maxlength="${messages.MAX_BODY}"></textarea></label>`
      + `<input type="hidden" name="replyTo" value="${/^\d{1,12}$/.test(String(replyTo || '')) ? replyTo : ''}">`
      + '<div class="row"><button class="b">Send</button><a class="b grey" href="/my/messages/">Cancel</a></div></form>');
  }

  async function sendMessage(ctx) {
    if (ctx.method !== 'POST') return send(ctx, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Send it from the app.');
    const who = accounts.fromRequest(ctx.req);
    if (!who) return redirect(ctx, '/my/messages/');
    const fields = await form(ctx);
    const to = String(fields.get('to') || '').trim();
    const target = accounts.byName(to);
    const again = (text) => redirect(ctx, `/my/messages/?to=${encodeURIComponent(to || ' ')}&subject=${encodeURIComponent(fields.get('subject') || '')}&msg=${encodeURIComponent(text)}`);
    if (!target) return again(to ? `Nobody here is called "${to}".` : 'Who is it for?');
    const result = messages.send(who.userId, target.userId, fields.get('subject'), fields.get('body'), fields.get('replyTo'));
    if (result.error) return again(result.error);
    return redirect(ctx, `/my/messages/?folder=sent&ok=1&msg=${encodeURIComponent(`Sent to ${target.name}.`)}`);
  }

  async function archive(ctx, match) {
    if (ctx.method !== 'POST') return send(ctx, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Do this from the app.');
    const who = accounts.fromRequest(ctx.req);
    if (!who) return redirect(ctx, '/my/messages/');
    const fields = await form(ctx);
    const result = messages.mark(match[1], who.userId, { archived: fields.get('archived') !== '0' });
    if (result.error) return redirect(ctx, `/my/messages/?msg=${encodeURIComponent(result.error)}`);
    return redirect(ctx, `/my/messages/?ok=1&msg=${encodeURIComponent(result.message.archived ? 'Archived.' : 'Moved to your inbox.')}`);
  }

  return {
    pageRoutes: [
      [/^users\/(\d{1,15})\/friends\/?$/i, friendsPage],
      [/^users\/friends\/(request|accept|decline|cancel|remove)\/?$/i, friendAction],
      [/^users\/(\d{1,15})\/profile\/?$/i, profilePage],
      [/^users\/search\/?$/i, searchPage],
      [/^my\/messages\/?$/i, (ctx) => (ctx.method === 'GET' ? messagesPage(ctx) : NEXT)],
      [/^my\/messages\/send\/?$/i, sendMessage],
      [/^my\/messages\/(\d{1,12})\/archive\/?$/i, archive],
    ],
  };
};
