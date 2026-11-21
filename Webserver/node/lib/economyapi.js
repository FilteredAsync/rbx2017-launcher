'use strict';

// Builders Club, limited items and trades for the launcher and the website
// (under /api/launcher/, from lib/launcherapi.js). Rules: lib/membership.js,
// lib/limiteds.js, lib/trades.js.
//
//   GET  membership                (session) your tier, until, auto-renew, the tiers and prices
//   POST membership/buy            (session) {tier: "BC"|"TBC"|"OBC"}
//   POST membership/renew          (session) {on}
//   GET  limiteds/of/<userId>      a player's limited copies (public, like 2017 inventories)
//   GET  limiteds/item/<assetId>   an item's stock, RAP, sellers and your copies
//   POST limiteds/<uaid>/sell      (session) {price} (null takes it off sale)
//   GET  trades                    (session) ?kind=inbound|outbound|completed|inactive
//   GET  trades/<id>               (session)
//   POST trades                    (session) {userId, offer: {uaids, robux}, request: {uaids, robux}}
//   POST trades/<id>/accept | decline   (session) (decline by the sender cancels)

const accounts = require('./accounts');
const membership = require('./membership');
const limiteds = require('./limiteds');
const trades = require('./trades');
const robux = require('./robux');

module.exports = function economyApi({ sendJson, jsonBody }) {
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : 'Deleted account';
  };
  const person = (userId) => ({ userId: Number(userId), name: nameOf(userId), membership: membership.tierOf(userId) });

  function sideView(side) {
    return {
      robux: side.robux,
      items: side.uaids.map((uaid) => {
        const copy = limiteds.copyOf(uaid);
        const record = copy ? limiteds.summary(copy.assetId) : null;
        return { uaid, assetId: copy ? copy.assetId : null, name: record ? record.name : 'Gone', serial: copy ? copy.serial : null, stock: record ? record.stock : null, rap: limiteds.rapOf(uaid) };
      }),
    };
  }

  function tradeView(trade, viewer) {
    return {
      id: trade.id, status: trade.status, created: trade.created, updated: trade.updated,
      from: person(trade.from), to: person(trade.to), mine: trade.from === Number(viewer) ? 'sent' : 'received',
      offer: sideView(trade.offer), request: sideView(trade.request),
    };
  }

  const fail = (ctx, result, status = 400) => sendJson(ctx, status, { error: result.error });
  const isJson = (ctx) => /application\/json/i.test(String(ctx.req.headers['content-type'] || ''));

  function handles(action) {
    return /^(?:membership|limiteds|trades)(?:\/|$)/.test(action);
  }

  async function route(ctx, viewer, action, method) {
    if (method === 'POST' && !isJson(ctx)) return sendJson(ctx, 415, { error: 'Send JSON.' });
    let match = /^limiteds\/of\/(\d{1,15})$/.exec(action);
    if (match && method === 'GET') return sendJson(ctx, 200, { items: limiteds.inventory(match[1]) });
    match = /^limiteds\/item\/(\d{1,15})$/.exec(action);
    if (match && method === 'GET') {
      const summary = limiteds.summary(match[1], viewer ? viewer.userId : null);
      if (!summary) return sendJson(ctx, 404, { error: 'This limited isn\'t sold here yet.' });
      summary.listings = summary.listings.map((l) => Object.assign({}, l, { seller: { userId: l.seller, name: nameOf(l.seller) } }));
      return sendJson(ctx, 200, summary);
    }
    if (!viewer) return sendJson(ctx, 401, { error: 'Sign in first.' });
    const me = viewer.userId;

    if (action === 'membership' && method === 'GET') return sendJson(ctx, 200, Object.assign(membership.status(me), { balance: robux.balance(me) }));
    if (action === 'membership/buy' && method === 'POST') {
      const body = await jsonBody(ctx);
      const result = membership.buy(me, String(body.tier || ''));
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, Object.assign(result.status, { balance: result.balance }));
    }
    if (action === 'membership/renew' && method === 'POST') {
      const body = await jsonBody(ctx);
      const result = membership.setAutoRenew(me, body.on !== false);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, result.status);
    }
    match = /^limiteds\/(\d{1,12})\/sell$/.exec(action);
    if (match && method === 'POST') {
      const body = await jsonBody(ctx);
      const result = limiteds.setListing(me, Number(match[1]), body.price === null || body.price === undefined ? null : body.price);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { ok: true, items: limiteds.inventory(me) });
    }
    if (action === 'trades' && method === 'GET') {
      const kind = ['inbound', 'outbound', 'completed', 'inactive'].includes(ctx.queryLower.kind) ? ctx.queryLower.kind : 'inbound';
      return sendJson(ctx, 200, { kind, trades: trades.list(me, kind).map((t) => tradeView(t, me)), inbound: trades.openCount(me), membership: membership.tierOf(me) });
    }
    if (action === 'trades' && method === 'POST') {
      const body = await jsonBody(ctx);
      const other = accounts.byUserId(String(body.userId || ''));
      if (!other) return sendJson(ctx, 404, { error: 'No such player.' });
      const result = trades.send(me, other.userId, body.offer, body.request);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { trade: tradeView(result.trade, me) });
    }
    match = /^trades\/(\d{1,12})(?:\/(accept|decline))?$/.exec(action);
    if (match) {
      if (!match[2]) {
        if (method !== 'GET') return sendJson(ctx, 405, { error: 'use GET' });
        const trade = trades.get(match[1], me);
        return trade ? sendJson(ctx, 200, { trade: tradeView(trade, me) }) : sendJson(ctx, 404, { error: 'No such trade.' });
      }
      if (method !== 'POST') return sendJson(ctx, 405, { error: 'use POST' });
      const result = match[2] === 'accept' ? trades.accept(match[1], me) : trades.decline(match[1], me);
      return result.error ? fail(ctx, result) : sendJson(ctx, 200, { trade: tradeView(result.trade, me), balance: robux.balance(me) });
    }
    return sendJson(ctx, 404, { error: 'unknown request' });
  }

  return { handles, route, tradeView };
};
