'use strict';

// The Android app's native Chat tab (com.roblox.client.chat): its chat API on
// chat.<domain>, the realtime connection it waits for before it loads
// anything, and the few other calls the chat screens make. The chats are the
// launcher's and the website's (lib/chat.js).
//
// chat.<domain>   GET  v2/get-user-conversations?pageNumber=&pageSize=   (newest first)
//                 GET  v2/get-conversations?conversationIds=
//                 GET  v2/get-messages?conversationId=&pageSize=[&exclusiveStartMessageId=]  (newest first)
//                 GET  v2/multi-get-latest-messages?conversationIds=..&pageSize=
//                 GET  v2/get-unread-conversation-count, v2/chat-settings
//                 POST v2/send-message {conversationId, message}
//                      v2/start-one-to-one-conversation {participantUserId}
//                      v2/start-group-conversation {participantUserIds}
//                      v2/add-to-conversation {conversationId, participantUserIds}
//                      v2/remove-from-conversation {conversationId, participantUserId}
//                      v2/rename-group-conversation {conversationId, newTitle}
//                      v2/mark-as-read {conversationId, endMessageId}
//                      v2/update-user-typing-status {conversationId, isTyping}
// m.<domain>      friends/list?userId=&pageSize=&startIndex=, presence/users?userIds=..,
//                 thumbnail/avatar-headshots?userIds=.. (both answered in the order asked)
// api.<domain>    incoming-items/counts (users/<id> is lib/studio.js's)
//
// Realtime: the app's SignalR 2 client (Microsoft's Java client, protocol
// 1.3) connects to UserNotificationHub at m.<domain>/notifications (the
// SignalRUrl app setting, lib/mobile.js): notifications/negotiate, then a
// WebSocket at notifications/signalr/connect (lib/websocket.js; server.js
// hands upgrades here). Its client never falls back when the WebSocket is
// refused, but long polling is answered too:
//   notifications/connect -> poll, poll, ... (abort, ping, send)
// Its chat screens count as connected only after the hub calls
// subscriptionStatus("Subscribed", ...); after that, chat changes arrive as
// notification("ChatNotifications", {"ConversationId": n, "Type": ...}).
//
// Every answer is JSON (the app parses every answer without a fallback).
// The app's message IDs are our message numbers (seq), as strings. Its dates
// are parsed as yyyy-MM-dd'T'HH:mm:ss.SSSZ (3 fraction digits, or none).

const crypto = require('crypto');
const websocket = require('./websocket');
const accounts = require('./accounts');
const chat = require('./chat');
const friends = require('./friends');
const messages = require('./messages');

const HUB = 'UserNotificationHub';
const POLL_HOLD_MS = 25 * 1000;
const CONNECTION_IDLE_MS = 2 * 60 * 1000;
const MAX_CONNECTIONS = 2000;
const MAX_QUEUED = 200;
// The WebSocket gets an empty message this often (the client needs a keep-alive
// timeout in the negotiate answer and reconnects after it passes in silence).
const KEEP_ALIVE_S = 10;

module.exports = function mobileChat({ sendJson, jsonBody, launcher, baseUrl }) {
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : 'Deleted account';
  };
  const viewer = (ctx) => accounts.fromRequest(ctx.req);
  const stamp = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  };
  const listParam = (ctx, name) => {
    const params = new URL(ctx.req.url, 'http://x').searchParams;
    const lower = name.toLowerCase();
    const values = [];
    for (const [key, value] of params) if (key.toLowerCase() === lower) values.push(...String(value).split(','));
    return values.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 100);
  };
  const isJsonPost = (ctx) => ctx.method === 'POST' && /application\/json/i.test(String(ctx.req.headers['content-type'] || ''));

  // --- the app's objects -----------------------------------------------------------------

  function titleOf(c, userId) {
    if (c.type === 'group' && c.title) return c.title;
    const names = c.members.filter((id) => id !== Number(userId)).map(nameOf);
    return names.join(', ') || nameOf(userId);
  }

  function conversationJson(c, userId) {
    const title = titleOf(c, userId);
    return {
      id: c.id,
      title,
      initiator: { type: 'User', targetId: c.owner },
      hasUnreadMessages: chat.unreadIn(c, userId) > 0,
      participants: c.members.map((id) => ({ type: 'User', targetId: id, name: nameOf(id) })),
      conversationType: c.type === 'one' ? 'OneToOneConversation' : 'MultiUserConversation',
      conversationTitle: { titleForViewer: title, isDefaultTitle: !(c.type === 'group' && c.title) },
      lastUpdated: stamp(c.updated),
    };
  }

  function messageJson(c, m, userId) {
    const seen = Number(c.read[userId]) || 0;
    return {
      id: String(m.seq),
      senderType: 'User',
      senderTargetId: m.from,
      content: m.text,
      sent: stamp(m.at),
      read: m.from === Number(userId) || m.seq <= seen,
      messageType: 'PlainText',
      filteredForReceivers: false,
    };
  }

  // Newest first, `size` of them, older than `before` (a seq) when given.
  function newestFirst(c, size, before) {
    const older = Number(before) > 0 ? c.messages.filter((m) => m.seq < Number(before)) : c.messages;
    return older.slice(-size).reverse();
  }

  const pageSize = (ctx, fallback) => Math.min(100, Math.max(1, Number(ctx.queryLower.pagesize) || fallback));
  const fail = (ctx, statusMessage) => sendJson(ctx, 200, { resultType: 'Error', statusMessage });
  const signedOut = (ctx) => sendJson(ctx, 401, { errors: [{ code: 0, message: 'Authorization has been denied for this request.' }] });

  // --- chat.<domain> -----------------------------------------------------------------------

  function userConversations(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const size = pageSize(ctx, 30);
    const page = Math.max(1, Number(ctx.queryLower.pagenumber) || 1);
    const list = chat.list(who.userId).slice((page - 1) * size, page * size);
    sendJson(ctx, 200, list.map((c) => conversationJson(c, who.userId)));
  }

  function getConversations(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const list = listParam(ctx, 'conversationIds').map((id) => chat.get(id, who.userId)).filter(Boolean);
    sendJson(ctx, 200, list.map((c) => conversationJson(c, who.userId)));
  }

  function getMessages(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const c = chat.get(Number(ctx.queryLower.conversationid), who.userId);
    if (!c) return sendJson(ctx, 403, { errors: [{ code: 1, message: 'Not in this conversation.' }] });
    const list = newestFirst(c, pageSize(ctx, 30), ctx.queryLower.exclusivestartmessageid);
    sendJson(ctx, 200, list.map((m) => messageJson(c, m, who.userId)));
  }

  function latestMessages(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const size = pageSize(ctx, 1);
    const result = [];
    for (const id of listParam(ctx, 'conversationIds')) {
      const c = chat.get(id, who.userId);
      if (c) result.push({ conversationId: c.id, chatMessages: newestFirst(c, size).map((m) => messageJson(c, m, who.userId)) });
    }
    sendJson(ctx, 200, result);
  }

  function unreadCount(ctx) {
    const who = viewer(ctx);
    sendJson(ctx, 200, { count: who ? chat.unreadCount(who.userId) : 0 });
  }

  async function postBody(ctx) {
    if (!isJsonPost(ctx)) return null;
    return jsonBody(ctx);
  }

  async function sendMessage(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    const result = chat.send(Number(body.conversationId), who.userId, body.message);
    if (result.error) return fail(ctx, result.error);
    sendJson(ctx, 200, {
      resultType: 'Success', statusMessage: 'Success', messageId: String(result.message.seq), content: result.message.text,
      filteredForReceivers: false, sent: stamp(result.message.at),
    });
  }

  async function startConversation(ctx, group) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    const ids = group ? (Array.isArray(body.participantUserIds) ? body.participantUserIds : []).map(Number) : [Number(body.participantUserId)];
    const result = group && ids.length > 1 ? chat.startGroup(who.userId, ids, '') : chat.startOne(who.userId, ids[0]);
    if (result.error) return fail(ctx, result.error);
    sendJson(ctx, 200, { resultType: 'Success', statusMessage: 'Success', conversation: conversationJson(result.conversation, who.userId), rejectedParticipants: [] });
  }

  async function addTo(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    const result = chat.add(Number(body.conversationId), who.userId, (Array.isArray(body.participantUserIds) ? body.participantUserIds : []).map(Number));
    if (result.error) return fail(ctx, result.error);
    if (result.rejected.length) return fail(ctx, `Couldn't add ${result.rejected.map(nameOf).join(', ')}.`);
    sendJson(ctx, 200, { resultType: 'Success', statusMessage: 'Success', conversationId: result.conversation.id, rejectedParticipants: [] });
  }

  async function removeFrom(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    const result = chat.remove(Number(body.conversationId), who.userId, Number(body.participantUserId));
    if (result.error) return fail(ctx, result.error);
    sendJson(ctx, 200, { resultType: 'Success', statusMessage: 'Success' });
  }

  async function rename(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    const result = chat.rename(Number(body.conversationId), who.userId, body.newTitle);
    if (result.error) return fail(ctx, result.error);
    const title = titleOf(result.conversation, who.userId);
    sendJson(ctx, 200, {
      resultType: 'Success', statusMessage: 'Success', conversationTitle: title,
      title: { titleForViewer: title, isDefaultTitle: !result.conversation.title },
    });
  }

  async function markRead(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    const result = chat.markRead(Number(body.conversationId), who.userId, Number(body.endMessageId) || undefined);
    if (result.error) return fail(ctx, result.error);
    sendJson(ctx, 200, { resultType: 'Success', statusMessage: 'Success' });
  }

  async function typing(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    const body = await postBody(ctx);
    if (!body) return fail(ctx, 'Send it as JSON.');
    chat.setTyping(Number(body.conversationId), who.userId, body.isTyping !== false);
    sendJson(ctx, 200, { statusMessage: 'Success' });
  }

  // --- m.<domain> and api.<domain> -------------------------------------------------------

  function friendList(ctx) {
    const who = viewer(ctx);
    const userId = Number(ctx.queryLower.userid) || (who ? who.userId : 0);
    const size = pageSize(ctx, 30);
    const start = Math.max(0, Number(ctx.queryLower.startindex) || 0);
    const all = friends.friendIds(userId).map((id) => accounts.byUserId(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    sendJson(ctx, 200, {
      Friends: all.slice(start, start + size).map((account) => ({ Id: account.userId, Username: account.name, UserProfileLink: `${baseUrl(ctx)}users/${account.userId}/profile` })),
      TotalFriends: all.length, StartIndex: start, PageSize: size, TotalPages: Math.max(1, Math.ceil(all.length / size)),
    });
  }

  // 0 offline, 1 online, 2 in a game, 3 in Studio.
  function presenceUsers(ctx) {
    const result = listParam(ctx, 'userIds').map((id) => {
      const account = accounts.byUserId(id);
      const seen = account ? launcher.presence(account.userId, account.name) : { presence: 'offline' };
      const type = { online: 1, game: 2, studio: 3 }[seen.presence] || 0;
      const where = seen.online || {};
      return {
        UserPresenceType: type, UserId: id,
        LastLocation: type === 2 ? (where.gameName || 'In a game') : type === 3 ? 'Studio' : type === 1 ? 'Online' : '',
        PlaceId: type === 2 && where.placeId ? Number(where.placeId) : null,
        GameId: type === 2 && where.gameId && !where.privateServer ? String(where.gameId) : null,
        IsGamePlayableOnCurrentDevice: type === 2 && !where.privateServer,
      };
    });
    sendJson(ctx, 200, result);
  }

  function headshots(ctx) {
    const base = baseUrl(ctx);
    sendJson(ctx, 200, listParam(ctx, 'userIds').map((id) => ({
      Url: `${base}headshot-thumbnail/image?userId=${id}&width=150&height=150&format=png`, Final: true,
    })));
  }

  function incomingCounts(ctx) {
    const who = viewer(ctx);
    sendJson(ctx, 200, {
      unreadMessageCount: who ? messages.unreadCount(who.userId) : 0,
      friendRequestsCount: who ? friends.incoming(who.userId).filter((r) => accounts.byUserId(r.from)).length : 0,
    });
  }

  // --- SignalR 2 long polling -------------------------------------------------------------

  const connections = new Map(); // token -> { userId, id, queue: [], counter, waiter, seen }

  function sweep() {
    const now = Date.now();
    for (const [token, connection] of connections) {
      if (!connection.waiter && !connection.ws && now - connection.seen > CONNECTION_IDLE_MS) connections.delete(token);
    }
  }
  setInterval(sweep, 60 * 1000).unref();

  function hubMessage(method, args) {
    return { H: HUB, M: method, A: args };
  }

  function flush(connection) {
    if (!connection.waiter) return;
    const { ctx, timer } = connection.waiter;
    connection.waiter = null;
    clearTimeout(timer);
    const batch = connection.queue.splice(0);
    if (batch.length) connection.counter += 1;
    connection.seen = Date.now();
    sendJson(ctx, 200, { C: `s-0,${connection.counter.toString(16)}`, M: batch });
  }

  function queue(connection, message) {
    if (connection.ws) {
      connection.counter += 1;
      connection.ws.send(JSON.stringify({ C: `s-0,${connection.counter.toString(16)}`, M: [message] }));
      return;
    }
    connection.queue.push(message);
    if (connection.queue.length > MAX_QUEUED) connection.queue.splice(0, connection.queue.length - MAX_QUEUED);
    flush(connection);
  }

  // Sends a hub call to every connection of userId.
  function push(userId, method, args) {
    for (const connection of connections.values()) {
      if (connection.userId === Number(userId)) queue(connection, hubMessage(method, args));
    }
  }

  function chatNote(userId, type, conversationId, extra = {}) {
    push(userId, 'notification', ['ChatNotifications', JSON.stringify(Object.assign({ ConversationId: conversationId, Type: type }, extra))]);
  }

  chat.onChange((event) => {
    const c = event.conversation;
    const by = Number(event.by);
    const others = (list) => list.filter((id) => id !== by);
    if (event.type === 'send') {
      for (const id of others(c.members)) chatNote(id, 'NewMessage', c.id);
      chatNote(by, 'NewMessageBySelf', c.id);
    } else if (event.type === 'start') {
      for (const id of c.members) chatNote(id, 'NewConversation', c.id);
    } else if (event.type === 'add') {
      for (const id of event.added) chatNote(id, 'AddedToConversation', c.id);
      for (const id of c.members.filter((m) => !event.added.includes(m))) chatNote(id, 'ParticipantAdded', c.id);
    } else if (event.type === 'remove') {
      chatNote(event.removed, 'RemovedFromConversation', c.id);
      for (const id of c.members) chatNote(id, event.gone ? 'ConversationRemoved' : 'ParticipantLeft', c.id);
    } else if (event.type === 'rename') {
      for (const id of c.members) chatNote(id, 'ConversationTitleChanged', c.id, { ActorType: 'User', ActorTargetId: by });
    } else if (event.type === 'typing') {
      for (const id of others(c.members)) chatNote(id, 'ParticipantTyping', c.id, { UserId: by, IsTyping: Boolean(event.on) });
    }
  });

  function negotiate(ctx) {
    const who = viewer(ctx);
    if (!who) return signedOut(ctx);
    if (connections.size >= MAX_CONNECTIONS) sweep();
    if (connections.size >= MAX_CONNECTIONS) return sendJson(ctx, 503, { error: 'busy' });
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64');
    connections.set(token, { userId: who.userId, id, queue: [], counter: 0, waiter: null, ws: null, seen: Date.now() });
    sendJson(ctx, 200, {
      Url: '/notifications', ConnectionToken: token, ConnectionId: id, KeepAliveTimeout: KEEP_ALIVE_S * 2, DisconnectTimeout: 30,
      ConnectionTimeout: POLL_HOLD_MS / 1000, TryWebSockets: false, ProtocolVersion: String(ctx.queryLower.clientprotocol || '1.3').slice(0, 5),
      TransportConnectTimeout: 5, LongPollDelay: 0,
    });
  }

  function connectionOf(ctx) {
    const token = String(new URL(ctx.req.url, 'http://x').searchParams.get('connectionToken') || '');
    return connections.get(token) || null;
  }

  function longPoll(ctx, match) {
    const connection = connectionOf(ctx);
    if (!connection) return sendJson(ctx, 404, { error: 'Unrecognized user identity. The connection is gone.' });
    connection.seen = Date.now();
    const kind = match[1].toLowerCase();
    if (kind === 'connect') {
      // Initialized; the subscription follows in the first poll.
      connection.queue.push(hubMessage('subscriptionStatus', ['Subscribed', JSON.stringify({ SequenceNumber: 1, MillisecondsBeforeHandlingReconnect: 0 })]));
      return sendJson(ctx, 200, { C: `s-0,${connection.counter.toString(16)}`, S: 1, M: [] });
    }
    if (kind === 'reconnect' && !connection.queue.length) {
      connection.queue.push(hubMessage('subscriptionStatus', ['Subscribed', JSON.stringify({ SequenceNumber: 1, MillisecondsBeforeHandlingReconnect: 0 })]));
    }
    if (connection.waiter) flush(connection); // only one poll at a time
    const timer = setTimeout(() => flush(connection), POLL_HOLD_MS);
    connection.waiter = { ctx, timer };
    ctx.req.on('close', () => {
      if (connection.waiter && connection.waiter.ctx === ctx) {
        clearTimeout(connection.waiter.timer);
        connection.waiter = null;
      }
    });
    if (connection.queue.length) flush(connection);
  }

  function abort(ctx) {
    const connection = connectionOf(ctx);
    if (connection) {
      if (connection.waiter) flush(connection);
      for (const [token, entry] of connections) if (entry === connection) connections.delete(token);
    }
    sendJson(ctx, 200, {});
  }

  const SUBSCRIBED = () => hubMessage('subscriptionStatus', ['Subscribed', JSON.stringify({ SequenceNumber: 1, MillisecondsBeforeHandlingReconnect: 0 })]);
  const hubResult = (text) => {
    let id = '0';
    try {
      const data = JSON.parse(text);
      if (data && data.I !== undefined) id = String(data.I);
    } catch (error) { /* not a hub call */ }
    return JSON.stringify({ I: id });
  };

  // An HTTP upgrade (server.js): the WebSocket transport. -> true when handled.
  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (!/^\/notifications\/(?:signalr\/)?(?:connect|reconnect)\/?$/i.test(url.pathname)) return false;
    const connection = connections.get(String(url.searchParams.get('connectionToken') || ''));
    if (!connection) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return true;
    }
    if (connection.ws) connection.ws.close();
    if (connection.waiter) flush(connection);
    const ws = websocket.accept(req, socket, head, {
      onText: (text) => ws && ws.send(hubResult(text)),
      onClose: () => {
        if (connection.ws === ws) connection.ws = null;
        connection.seen = Date.now();
      },
    });
    if (!ws) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return true;
    }
    connection.ws = ws;
    connection.seen = Date.now();
    const beat = setInterval(() => {
      if (connection.ws !== ws || !ws.open) clearInterval(beat);
      else ws.send('{}');
    }, KEEP_ALIVE_S * 1000);
    beat.unref();
    // Initialized; then the subscription and anything that waited.
    ws.send(JSON.stringify({ C: `s-0,${connection.counter.toString(16)}`, S: 1, M: [] }));
    setTimeout(() => {
      if (connection.ws !== ws) return;
      const waiting = connection.queue.splice(0).filter((m) => m.M !== 'subscriptionStatus');
      for (const message of [SUBSCRIBED(), ...waiting]) queue(connection, message);
    }, 250);
    return true;
  }

  // Calls from the app to the hub: none are used; each gets an empty result.
  async function hubSend(ctx) {
    const text = (await ctx.body(16 * 1024)).toString('utf8');
    let id = '0';
    try {
      const data = JSON.parse(new URLSearchParams(text).get('data') || '{}');
      if (data && data.I !== undefined) id = String(data.I);
    } catch (error) { /* not a hub call */ }
    sendJson(ctx, 200, { I: id });
  }

  const post = (handler) => (ctx, match) => (ctx.method === 'POST' ? handler(ctx, match) : sendJson(ctx, 405, { resultType: 'Error', statusMessage: 'use POST' }));

  return {
    routes: [
      [/^v2\/get-user-conversations\/?$/i, userConversations],
      [/^v2\/get-conversations\/?$/i, getConversations],
      [/^v2\/get-messages\/?$/i, getMessages],
      [/^v2\/multi-get-latest-messages\/?$/i, latestMessages],
      [/^v2\/get-unread-conversation-count\/?$/i, unreadCount],
      [/^v2\/chat-settings\/?$/i, (ctx) => sendJson(ctx, 200, { chatEnabled: true })],
      [/^v2\/send-message\/?$/i, post(sendMessage)],
      [/^v2\/start-one-to-one-conversation\/?$/i, post((ctx) => startConversation(ctx, false))],
      [/^v2\/start-group-conversation\/?$/i, post((ctx) => startConversation(ctx, true))],
      [/^v2\/add-to-conversation\/?$/i, post(addTo)],
      [/^v2\/remove-from-conversation\/?$/i, post(removeFrom)],
      [/^v2\/rename-group-conversation\/?$/i, post(rename)],
      [/^v2\/mark-as-read\/?$/i, post(markRead)],
      [/^v2\/update-user-typing-status\/?$/i, post(typing)],
      [/^friends\/list\/?$/i, friendList],
      [/^presence\/users\/?$/i, presenceUsers],
      [/^thumbnail\/avatar-headshots\/?$/i, headshots],
      [/^incoming-items\/counts\/?$/i, incomingCounts],
      [/^notifications\/negotiate\/?$/i, negotiate],
      [/^notifications\/(connect|reconnect|poll)\/?$/i, longPoll],
      [/^notifications\/start\/?$/i, (ctx) => sendJson(ctx, 200, { Response: 'started' })],
      [/^notifications\/ping\/?$/i, (ctx) => sendJson(ctx, 200, { Response: 'pong' })],
      [/^notifications\/abort\/?$/i, abort],
      [/^notifications\/send\/?$/i, hubSend],
    ],
    push,
    upgrade,
  };
};
