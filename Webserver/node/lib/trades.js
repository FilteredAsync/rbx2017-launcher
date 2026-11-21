'use strict';

// Trades of limited items between Builders Club members, like 2017's
// (data/trades.json):
//   { nextId, trades: [{ id, from, to, offer: { uaids, robux }, request: { uaids, robux },
//     status: 'open'|'accepted'|'declined'|'cancelled'|'expired'|'invalid', created, updated }] }
//
// Up to 4 items a side. R$ may go with the items, up to half the RAP of the
// items on the same side, and whoever gets R$ gets 70% of it (30% goes).
// Both players must be in Builders Club when the trade is sent and when it's
// accepted, and every copy must still belong to its side. Open trades end
// after 7 days. A block between the two stops trading.

const fs = require('fs');
const path = require('path');
const core = require('./core');
const limiteds = require('./limiteds');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'trades.json');
const MAX_ITEMS = 4;
const MAX_OPEN = 30;
const ROBUX_SHARE = 0.7;
const EXPIRE_MS = 7 * 24 * 3600 * 1000;
const KEEP = 2000;

let cache = null;

function load() {
  if (cache) return cache;
  const raw = core.readJsonFile(FILE) || {};
  cache = { nextId: Number(raw.nextId) || 1, trades: Array.isArray(raw.trades) ? raw.trades.filter((t) => t && Number(t.id) > 0) : [] };
  for (const trade of cache.trades) cache.nextId = Math.max(cache.nextId, trade.id + 1);
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (cache.trades.length > KEEP) cache.trades.splice(0, cache.trades.length - KEEP);
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save trades');
}

const membership = () => require('./membership');
const robux = () => require('./robux');
const bc = (userId) => Boolean(membership().tierOf(userId));

function expireOld() {
  let changed = false;
  for (const trade of load().trades) {
    if (trade.status === 'open' && Date.now() - Date.parse(trade.created) > EXPIRE_MS) {
      trade.status = 'expired';
      trade.updated = core.isoDate();
      changed = true;
    }
  }
  if (changed) save();
}

function cleanSide(side) {
  const uaids = [...new Set((Array.isArray(side && side.uaids) ? side.uaids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const amount = Math.max(0, Math.floor(Number(side && side.robux) || 0));
  return { uaids, robux: amount };
}

// Checks one side: its copies belong to owner and its R$ fit -> error text or null.
function sideProblem(side, owner, whose) {
  if (side.uaids.length > MAX_ITEMS) return `Up to ${MAX_ITEMS} items a side.`;
  let value = 0;
  for (const uaid of side.uaids) {
    const copy = limiteds.copyOf(uaid);
    if (!copy || copy.owner !== Number(owner)) return `${whose} no longer ${whose === 'You' ? 'have' : 'has'} one of those items.`;
    value += limiteds.rapOf(uaid);
  }
  if (side.robux > Math.floor(value / 2)) return `R$ can be at most half the value of the items with it (R$ ${Math.floor(value / 2)}${whose === 'You' ? ' on your side' : ' on their side'}).`;
  return null;
}

// -> { trade } or { error }
function send(from, to, offer, request) {
  expireOld();
  const a = Number(from);
  const b = Number(to);
  if (!(a > 0) || !(b > 0)) return { error: 'Guests cannot trade.' };
  if (a === b) return { error: 'You can\'t trade with yourself.' };
  if (!bc(a)) return { error: 'Trading needs Builders Club.' };
  if (!bc(b)) return { error: 'They need Builders Club to trade.' };
  if (require('./blocks').between(a, b)) return { error: 'You can\'t trade with this player.' };
  const give = cleanSide(offer);
  const get = cleanSide(request);
  if (!give.uaids.length && !get.uaids.length) return { error: 'Put items in the trade.' };
  if (!give.uaids.length || !get.uaids.length) return { error: 'Both sides need at least one item.' };
  const problem = sideProblem(give, a, 'You') || sideProblem(get, b, 'They');
  if (problem) return { error: problem };
  if (give.robux > robux().balance(a)) return { error: `You only have R$ ${robux().balance(a)}.` };
  const data = load();
  if (data.trades.filter((t) => t.status === 'open' && t.from === a).length >= MAX_OPEN) return { error: `You have ${MAX_OPEN} trades waiting already.` };
  const now = core.isoDate();
  const trade = { id: data.nextId++, from: a, to: b, offer: give, request: get, status: 'open', created: now, updated: now };
  data.trades.push(trade);
  save();
  return { trade };
}

function get(tradeId, userId) {
  expireOld();
  const trade = load().trades.find((t) => t.id === Number(tradeId));
  return trade && (trade.from === Number(userId) || trade.to === Number(userId)) ? trade : null;
}

// inbound | outbound | completed | inactive
function list(userId, kind) {
  expireOld();
  const me = Number(userId);
  return load().trades.filter((t) => {
    if (kind === 'outbound') return t.status === 'open' && t.from === me;
    if (kind === 'completed') return t.status === 'accepted' && (t.from === me || t.to === me);
    if (kind === 'inactive') return ['declined', 'cancelled', 'expired', 'invalid'].includes(t.status) && (t.from === me || t.to === me);
    return t.status === 'open' && t.to === me;
  }).sort((x, y) => (x.updated < y.updated ? 1 : -1)).slice(0, 100);
}

function close(trade, status) {
  trade.status = status;
  trade.updated = core.isoDate();
  save();
}

// -> { trade } or { error }
function accept(tradeId, userId) {
  const trade = get(tradeId, userId);
  if (!trade || trade.to !== Number(userId)) return { error: 'No such trade.' };
  if (trade.status !== 'open') return { error: 'This trade is no longer open.' };
  if (!bc(trade.from) || !bc(trade.to)) return { error: 'Both players need Builders Club to trade.' };
  const problem = sideProblem(trade.offer, trade.from, 'They') || sideProblem(trade.request, trade.to, 'You');
  if (problem) {
    close(trade, 'invalid');
    return { error: `${problem} The trade can't go through.` };
  }
  // R$ first, so a short balance stops it before any item moves.
  const fromPaid = trade.offer.robux ? robux().charge(trade.from, trade.offer.robux, `Trade #${trade.id}`) : { ok: true };
  if (!fromPaid.ok) {
    close(trade, 'invalid');
    return { error: 'They no longer have the R$ in this trade.' };
  }
  const toPaid = trade.request.robux ? robux().charge(trade.to, trade.request.robux, `Trade #${trade.id}`) : { ok: true };
  if (!toPaid.ok) {
    if (trade.offer.robux) robux().credit(trade.from, trade.offer.robux, `Trade #${trade.id} refund`);
    return { error: `You need R$ ${trade.request.robux} for this trade.` };
  }
  for (const uaid of trade.offer.uaids) limiteds.transfer(uaid, trade.from, trade.to);
  for (const uaid of trade.request.uaids) limiteds.transfer(uaid, trade.to, trade.from);
  if (trade.offer.robux) robux().credit(trade.to, Math.floor(trade.offer.robux * ROBUX_SHARE), `Trade #${trade.id}`);
  if (trade.request.robux) robux().credit(trade.from, Math.floor(trade.request.robux * ROBUX_SHARE), `Trade #${trade.id}`);
  close(trade, 'accepted');
  // Other open trades with these copies can't happen now.
  const moved = new Set([...trade.offer.uaids, ...trade.request.uaids]);
  for (const other of load().trades) {
    if (other.status === 'open' && [...other.offer.uaids, ...other.request.uaids].some((u) => moved.has(u))) close(other, 'invalid');
  }
  return { trade };
}

function decline(tradeId, userId) {
  const trade = get(tradeId, userId);
  if (!trade) return { error: 'No such trade.' };
  if (trade.status !== 'open') return { error: 'This trade is no longer open.' };
  close(trade, trade.from === Number(userId) ? 'cancelled' : 'declined');
  return { trade };
}

function openCount(userId) {
  return list(userId, 'inbound').length;
}

function forget(userId) {
  const me = Number(userId);
  let changed = false;
  for (const trade of load().trades) {
    if (trade.status === 'open' && (trade.from === me || trade.to === me)) {
      trade.status = 'cancelled';
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = { MAX_ITEMS, ROBUX_SHARE, send, get, list, accept, decline, openCount, forget };
