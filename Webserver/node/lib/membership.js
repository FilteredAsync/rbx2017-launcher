'use strict';

// Builders Club (data/membership.json): { userId: { tier, until, autoRenew, paidDay } }
// Bought with R$ for 30 days, like 2017's monthly plans: BC 400, TBC 800,
// OBC 1500. Members get daily R$ (15 / 35 / 60), can trade (lib/trades.js),
// can be in more groups (lib/groups.js), and games see their membership
// (Player.MembershipType, from the join script in lib/routes.js).
//
// Buying the tier you have adds 30 days to it; a higher tier starts now
// (what is left of the lower one is not refunded); a lower tier waits until
// the higher one ends. With auto-renew on, the next 30 days are bought when
// the time runs out, if the R$ are there.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'membership.json');
const DAY_MS = 24 * 3600 * 1000;
const TERM_DAYS = 30;
const TIERS = {
  BC: { name: 'Builders Club', price: 400, daily: 15, level: 1, membershipType: 'BuildersClub' },
  TBC: { name: 'Turbo Builders Club', price: 800, daily: 35, level: 2, membershipType: 'TurboBuildersClub' },
  OBC: { name: 'Outrageous Builders Club', price: 1500, daily: 60, level: 3, membershipType: 'OutrageousBuildersClub' },
};

let cache = null;

function load() {
  if (cache) return cache;
  const raw = core.readJsonFile(FILE) || {};
  cache = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!/^\d{1,15}$/.test(id) || !entry || !TIERS[entry.tier]) continue;
    cache[id] = { tier: entry.tier, until: entry.until, autoRenew: Boolean(entry.autoRenew), paidDay: entry.paidDay || null };
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache, null, 1)}\n`)) throw new Error('could not save memberships');
}

const robux = () => require('./robux');
const today = () => core.isoDate().slice(0, 10);

// Renews or ends a membership that ran out -> the entry or null.
function settle(userId) {
  const id = String(Number(userId));
  const data = load();
  const entry = data[id];
  if (!entry) return null;
  if (Date.parse(entry.until) > Date.now()) return entry;
  if (entry.autoRenew) {
    const tier = TIERS[entry.tier];
    const paid = robux().charge(Number(id), tier.price, `${tier.name} (30 days)`);
    if (paid.ok) {
      entry.until = new Date(Date.now() + TERM_DAYS * DAY_MS).toISOString();
      save();
      return entry;
    }
  }
  delete data[id];
  save();
  return null;
}

// 'BC' | 'TBC' | 'OBC' | null
function tierOf(userId) {
  if (!(Number(userId) > 0)) return null;
  const entry = settle(userId);
  return entry ? entry.tier : null;
}

function membershipType(userId) {
  const tier = tierOf(userId);
  return tier ? TIERS[tier].membershipType : 'None';
}

function status(userId) {
  const entry = settle(userId);
  return {
    tier: entry ? entry.tier : null,
    name: entry ? TIERS[entry.tier].name : null,
    until: entry ? entry.until : null,
    autoRenew: Boolean(entry && entry.autoRenew),
    tiers: Object.entries(TIERS).map(([key, tier]) => ({ key, name: tier.name, price: tier.price, daily: tier.daily, days: TERM_DAYS })),
  };
}

// -> { status, balance } or { error }
function buy(userId, tierKey) {
  const id = String(Number(userId));
  if (!(Number(id) > 0)) return { error: 'Guests cannot join Builders Club.' };
  const tier = TIERS[tierKey];
  if (!tier) return { error: 'No such membership.' };
  const current = settle(id);
  if (current && TIERS[current.tier].level > tier.level) {
    return { error: `You have ${TIERS[current.tier].name} until ${current.until.slice(0, 10)}.` };
  }
  const paid = robux().charge(Number(id), tier.price, `${tier.name} (30 days)`);
  if (!paid.ok) return { error: `${tier.name} costs R$ ${tier.price}. You have R$ ${paid.balance}.` };
  const data = load();
  const start = current && current.tier === tierKey ? Date.parse(current.until) : Date.now();
  data[id] = { tier: tierKey, until: new Date(start + TERM_DAYS * DAY_MS).toISOString(), autoRenew: current ? current.autoRenew : false, paidDay: current ? current.paidDay : null };
  save();
  checkIn(id);
  return { status: status(id), balance: robux().balance(Number(id)) };
}

function setAutoRenew(userId, on) {
  const entry = settle(userId);
  if (!entry) return { error: 'You are not in Builders Club.' };
  entry.autoRenew = Boolean(on);
  save();
  return { status: status(userId) };
}

// The daily R$, once a day (from robux.checkIn) -> the amount given.
function checkIn(userId) {
  const entry = settle(userId);
  if (!entry || entry.paidDay === today()) return 0;
  entry.paidDay = today();
  save();
  const tier = TIERS[entry.tier];
  robux().credit(Number(userId), tier.daily, `${tier.name} daily R$`);
  return tier.daily;
}

// A server admin's gift (/manage), days from now (0 ends it).
function grant(userId, tierKey, days) {
  const id = String(Number(userId));
  const data = load();
  if (!Number(days)) {
    delete data[id];
    save();
    return { status: status(id) };
  }
  if (!TIERS[tierKey]) return { error: 'No such membership.' };
  data[id] = { tier: tierKey, until: new Date(Date.now() + Number(days) * DAY_MS).toISOString(), autoRenew: false, paidDay: data[id] ? data[id].paidDay : null };
  save();
  return { status: status(id) };
}

function forget(userId) {
  const data = load();
  if (data[String(Number(userId))]) {
    delete data[String(Number(userId))];
    save();
  }
}

module.exports = { TIERS, TERM_DAYS, tierOf, membershipType, status, buy, setAutoRenew, checkIn, grant, forget };
