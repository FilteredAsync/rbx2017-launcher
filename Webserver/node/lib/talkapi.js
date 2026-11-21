'use strict';

// Chat and messages for the launcher and the website (under /api/launcher/,
// all need a session; lib/launcherapi.js sends them here):
//
//   GET  counts                 {chat, messages, friendRequests}: what's unread
//   GET  chat                   your conversations, newest first
//   GET  chat/<id>              ?after=<seq> newer messages | ?before=<seq> older ones
//                               -> {conversation, messages (oldest first), typing: [names]}
//   POST chat/start             {userId}: the one-to-one with a friend (made if needed)
//   POST chat/group             {userIds: [...], title}: a group chat with friends
//   POST chat/<id>/send         {text}
//   POST chat/<id>/read         {upTo?}: marks it read
//   POST chat/<id>/typing       {on}
//   POST chat/<id>/add          {userIds}: brings friends into a group
//   POST chat/<id>/remove       {userId}: the group's maker takes someone out
//   POST chat/<id>/leave
//   POST chat/<id>/rename       {title}
//   GET  messages               ?folder=inbox|sent|archive&page=
//   GET  messages/<id>          one message (opening yours marks it read)
//   POST messages               {to: name | userId, subject, body, replyTo?}
//   POST messages/<id>/read     {read}   | messages/<id>/archive {archived}
//
// Rules live in lib/chat.js and lib/messages.js.

const accounts = require('./accounts');
const chat = require('./chat');
const messages = require('./messages');
const friends = require('./friends');

const DELETED = 'Deleted account';

module.exports = function talkApi({ sendJson, jsonBody, presenceOf, presenceContext }) {
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : DELETED;
  };

  function messageView(m, viewer) {
    return { seq: m.seq, from: m.from, name: nameOf(m.from), mine: m.from === Number(viewer), text: m.text, at: m.at };
  }

  // A conversation as `viewer` sees it.
  function conversationView(c, viewer, context = presenceContext()) {
    const others = c.members.filter((id) => id !== Number(viewer));
    const members = c.members.map((userId) => {
      const name = nameOf(userId);
      return Object.assign({ userId, name, self: userId === Number(viewer) }, presenceOf(userId, name, context));
    });
    const otherNames = members.filter((m) => !m.self).map((m) => m.name);
    let canSend = true;
    let reason = null;
    if (c.type === 'one') {
      const other = others[0];
      if (!other || !chat.canTalk(viewer, other)) {
        canSend = false;
        reason = "You're no longer friends.";
      }
    } else if (!others.length) {
      canSend = false;
      reason = 'Everyone else left.';
    }
    const last = chat.lastOf(c);
    return {
      id: c.id,
      type: c.type,
      title: c.type === 'group' && c.title ? c.title : otherNames.join(', ') || 'Just you',
      customTitle: c.type === 'group' ? c.title : '',
      owner: c.owner,
      isOwner: c.owner === Number(viewer),
      members,
      updated: c.updated,
      last: last ? messageView(last, viewer) : null,
      unread: chat.unreadIn(c, viewer),
      canSend,
      reason,
    };
  }

  function letterView(m, viewer) {
    return {
      id: m.id,
      from: { userId: m.from, name: nameOf(m.from) },
      to: { userId: m.to, name: nameOf(m.to) },
      mine: m.from === Number(viewer),
      subject: m.subject,
      body: m.body,
      at: m.at,
      read: m.to === Number(viewer) ? m.read : true,
      archived: m.to === Number(viewer) ? m.archived : false,
      replyTo: m.replyTo,
    };
  }

  function counts(who) {
    return {
      chat: chat.unreadCount(who.userId),
      messages: messages.unreadCount(who.userId),
      friendRequests: friends.incoming(who.userId).filter((r) => accounts.byUserId(r.from)).length,
    };
  }

  const fail = (ctx, result, status = 400) => sendJson(ctx, status, { error: result.error });
  const ids = (list) => (Array.isArray(list) ? list : [list]).map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 50);

  async function chatRoute(ctx, who, action, method) {
    if (action === 'chat') {
      if (method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
      const context = presenceContext();
      return sendJson(ctx, 200, {
        conversations: chat.list(who.userId).map((c) => conversationView(c, who.userId, context)),
        maxText: chat.MAX_TEXT, maxMembers: chat.MAX_MEMBERS, counts: counts(who),
      });
    }
    if (method !== 'POST' && action !== 'chat' && !/^chat\/\d{1,12}$/.test(action)) return sendJson(ctx, 405, { error: 'use POST' });
    if (action === 'chat/start') {
      const body = await jsonBody(ctx);
      const result = chat.startOne(who.userId, Number(body.userId));
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { conversation: conversationView(result.conversation, who.userId) });
    }
    if (action === 'chat/group') {
      const body = await jsonBody(ctx);
      const result = chat.startGroup(who.userId, ids(body.userIds), body.title);
      if (result.error) return fail(ctx, result);
      return sendJson(ctx, 200, { conversation: conversationView(result.conversation, who.userId), rejected: result.rejected.map(nameOf) });
    }
    const match = /^chat\/(\d{1,12})(?:\/(send|read|typing|add|remove|leave|rename))?$/.exec(action);
    if (!match) return sendJson(ctx, 404, { error: 'unknown chat request' });
    const id = Number(match[1]);
    const verb = match[2];
    if (!verb) {
      if (method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
      const c = chat.get(id, who.userId);
      if (!c) return sendJson(ctx, 404, { error: 'No such chat.' });
      const q = ctx.queryLower;
      return sendJson(ctx, 200, {
        conversation: conversationView(c, who.userId),
        messages: chat.messagesOf(c, { after: q.after, before: q.before, limit: q.limit }).map((m) => messageView(m, who.userId)),
        typing: chat.typingIn(id, who.userId).map(nameOf),
      });
    }
    const body = await jsonBody(ctx);
    let result;
    if (verb === 'send') result = chat.send(id, who.userId, body.text);
    else if (verb === 'read') result = chat.markRead(id, who.userId, body.upTo);
    else if (verb === 'typing') result = chat.setTyping(id, who.userId, body.on !== false);
    else if (verb === 'add') result = chat.add(id, who.userId, ids(body.userIds !== undefined ? body.userIds : body.userId));
    else if (verb === 'remove') result = chat.remove(id, who.userId, Number(body.userId));
    else if (verb === 'leave') result = chat.remove(id, who.userId, who.userId);
    else result = chat.rename(id, who.userId, body.title);
    if (result.error) return fail(ctx, result);
    const c = chat.get(id, who.userId);
    return sendJson(ctx, 200, {
      ok: true,
      message: result.message ? messageView(result.message, who.userId) : null,
      conversation: c ? conversationView(c, who.userId) : null,
      rejected: result.rejected ? result.rejected.map(nameOf) : [],
    });
  }

  async function messagesRoute(ctx, who, action, method) {
    if (action === 'messages' && method === 'GET') {
      const q = ctx.queryLower;
      const page = messages.folder(who.userId, q.folder, q.page, q.size);
      return sendJson(ctx, 200, Object.assign({}, page, { messages: page.messages.map((m) => letterView(m, who.userId)), counts: counts(who) }));
    }
    if (action === 'messages' && method === 'POST') {
      const body = await jsonBody(ctx);
      const typed = String(body.to === undefined ? '' : body.to).trim();
      const target = /^\d{1,15}$/.test(typed) && accounts.byUserId(typed) ? accounts.byUserId(typed) : accounts.byName(typed);
      if (!target) return sendJson(ctx, 404, { error: typed ? `Nobody on this server is called "${typed}".` : 'Who is it for?' });
      const result = messages.send(who.userId, target.userId, body.subject, body.body, body.replyTo);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { message: letterView(result.message, who.userId) });
    }
    const match = /^messages\/(\d{1,12})(?:\/(read|archive))?$/.exec(action);
    if (!match) return sendJson(ctx, 404, { error: 'unknown messages request' });
    if (!match[2]) {
      if (method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
      const found = messages.get(match[1], who.userId);
      if (!found) return sendJson(ctx, 404, { error: 'No such message.' });
      if (found.to === who.userId && !found.read) messages.mark(found.id, who.userId, { read: true });
      return sendJson(ctx, 200, { message: letterView(found, who.userId), counts: counts(who) });
    }
    if (method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
    const body = await jsonBody(ctx);
    const change = match[2] === 'read' ? { read: body.read !== false } : { archived: body.archived !== false };
    const result = messages.mark(match[1], who.userId, change);
    return result.error ? fail(ctx, result, 404) : sendJson(ctx, 200, { message: letterView(result.message, who.userId), counts: counts(who) });
  }

  // True when the action is one of these (the caller checked the session).
  function handles(action) {
    return action === 'counts' || /^(?:chat|messages)(?:\/|$)/.test(action);
  }

  async function route(ctx, who, action, method) {
    // Writes come as JSON (the launcher and the website send it); a form from
    // another site can't, even with a session cookie the browser holds.
    if (method === 'POST' && !/application\/json/i.test(String(ctx.req.headers['content-type'] || ''))) {
      return sendJson(ctx, 415, { error: 'Send JSON.' });
    }
    if (action === 'counts') return sendJson(ctx, 200, counts(who));
    if (action === 'chat' || action.startsWith('chat/')) return chatRoute(ctx, who, action, method);
    return messagesRoute(ctx, who, action, method);
  }

  return { handles, route, counts, conversationView, messageView, letterView };
};
