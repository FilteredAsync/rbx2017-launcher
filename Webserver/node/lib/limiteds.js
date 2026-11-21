'use strict';

// Limited items (data/limiteds.json):
//   { nextUaid, items: { assetId: { name, typeId, price, stock, sold, rap, sales: [{ price, at }] } },
//     copies: [{ uaid, assetId, owner, serial, at }], listings: [{ uaid, price, at }] }
//
// Each limited Roblox made before 2018 sells STOCK copies here, at the
// price Roblox's resale market had when it was first seen (fixed for the
// stock). Every copy has its own ID (uaid) and serial number. Once the stock
// is gone, owners can put copies up for sale: a buyer gets the cheapest,
// the seller keeps 70% (30% goes, like 2017's marketplace fee). Copies also
// move in trades (lib/trades.js). RAP (recent average price) follows each
// sale, as 2017's did: RAP = RAP * 0.9 + price * 0.1.
//
// Owning any copy lets a player wear the item (lib/catalog.js owns).

const fs = require('fs');
const path = require('path');
const core = require('./core');

const DATA = core.rootPath('Webserver', 'node', 'data');
const FILE = path.join(DATA, 'limiteds.json');
const STOCK = 10;
const SELLER_SHARE = 0.7;
const MAX_PRICE = 100000000;
const MAX_SALES_KEPT = 30;

let cache = null;

function load() {
  if (cache) return cache;
  const raw = core.readJsonFile(FILE) || {};
  cache = {
    nextUaid: Number(raw.nextUaid) || 1,
    items: raw.items && typeof raw.items === 'object' ? raw.items : {},
    copies: Array.isArray(raw.copies) ? raw.copies.filter((c) => c && Number(c.uaid) > 0) : [],
    listings: Array.isArray(raw.listings) ? raw.listings.filter((l) => l && Number(l.uaid) > 0 && Number(l.price) > 0) : [],
  };
  for (const copy of cache.copies) cache.nextUaid = Math.max(cache.nextUaid, Number(copy.uaid) + 1);
  return cache;
}

function save() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!core.writeFileAtomic(FILE, `${JSON.stringify(cache)}\n`)) throw new Error('could not save limiteds');
}

const robux = () => require('./robux');
const id = (value) => String(Number(value));

// The item's record, made the first time it's seen with its Roblox resale price.
function ensure(assetId, seed = {}) {
  const data = load();
  const key = id(assetId);
  let item = data.items[key];
  if (!item) {
    const price = Math.min(MAX_PRICE, Math.max(1, Math.round(Number(seed.price) || 0)));
    if (!(Number(seed.price) > 0)) return null;
    item = { name: String(seed.name || `Item ${key}`), typeId: Number(seed.typeId) || 0, price, stock: STOCK, sold: 0, rap: price, sales: [] };
    data.items[key] = item;
    save();
  } else if (seed.name && item.name !== seed.name) {
    item.name = String(seed.name);
  }
  return item;
}

function tracked(assetId) {
  return Boolean(load().items[id(assetId)]);
}

function copyOf(uaid) {
  return load().copies.find((c) => c.uaid === Number(uaid)) || null;
}

function listingOf(uaid) {
  return load().listings.find((l) => l.uaid === Number(uaid)) || null;
}

function copiesOf(userId, assetId) {
  return load().copies.filter((c) => c.owner === Number(userId) && (assetId === undefined || c.assetId === id(assetId)));
}

function count(userId, assetId) {
  return copiesOf(userId, assetId).length;
}

// The cheapest copy for sale (not your own).
function cheapest(assetId, except) {
  const data = load();
  let best = null;
  for (const listing of data.listings) {
    const copy = copyOf(listing.uaid);
    if (!copy || copy.assetId !== id(assetId) || copy.owner === Number(except)) continue;
    if (!best || listing.price < best.listing.price) best = { listing, copy };
  }
  return best;
}

// What buying one costs now -> { from: 'stock'|'resale', price, remaining } or null.
function next(assetId, buyer) {
  const item = load().items[id(assetId)];
  if (!item) return null;
  if (item.sold < item.stock) return { from: 'stock', price: item.price, remaining: item.stock - item.sold };
  const best = cheapest(assetId, buyer);
  return best ? { from: 'resale', price: best.listing.price, remaining: 0, uaid: best.copy.uaid } : null;
}

// What the item pages show.
function summary(assetId, viewer) {
  const item = load().items[id(assetId)];
  if (!item) return null;
  const listings = load().listings.map((l) => ({ l, c: copyOf(l.uaid) })).filter((x) => x.c && x.c.assetId === id(assetId))
    .sort((a, b) => a.l.price - b.l.price);
  return {
    assetId: id(assetId), name: item.name, stock: item.stock, sold: item.sold, remaining: Math.max(0, item.stock - item.sold),
    originalPrice: item.price, rap: item.rap, next: next(assetId, viewer),
    listings: listings.slice(0, 20).map((x) => ({ uaid: x.c.uaid, serial: x.c.serial, price: x.l.price, seller: x.c.owner })),
    owned: viewer ? copiesOf(viewer, assetId).map((c) => ({ uaid: c.uaid, serial: c.serial, listed: listingOf(c.uaid) ? listingOf(c.uaid).price : null })) : [],
  };
}

function recordSale(item, price) {
  item.rap = Math.max(1, Math.round(item.rap * 0.9 + price * 0.1));
  item.sales.push({ price, at: core.isoDate() });
  if (item.sales.length > MAX_SALES_KEPT) item.sales.splice(0, item.sales.length - MAX_SALES_KEPT);
}

// After a copy leaves someone: if it was their last, it comes off their avatar.
function dropIfGone(userId, assetId) {
  if (count(userId, assetId) > 0) return;
  try {
    if (require('./ownership').owns(userId, assetId)) return; // owned before limiteds were sold here
  } catch (error) { /* no ownership file */ }
  try {
    const store = require('./avatarstore');
    const worn = store.get(userId);
    if (worn && worn.assets.some((a) => String(a.id) === id(assetId))) {
      store.set(userId, Object.assign({}, worn, { assets: worn.assets.filter((a) => String(a.id) !== id(assetId)) }));
    }
  } catch (error) { /* the avatar stays; the next save checks it */ }
}

// Buy one -> { ok, balance, copy } or { error, status, price }.
function buy(userId, assetId, expected) {
  const buyer = Number(userId);
  if (!(buyer > 0)) return { error: 'Sign in to buy items.', status: 401 };
  const item = load().items[id(assetId)];
  if (!item) return { error: 'This limited isn\'t sold here yet.', status: 400 };
  const offer = next(assetId, buyer);
  if (!offer) return { error: 'Sold out, and nobody is selling one.', status: 400 };
  if (expected !== undefined && expected !== null && Number(expected) !== offer.price) {
    return { error: `The price is now R$ ${offer.price}.`, status: 409, price: offer.price };
  }
  const paid = robux().charge(buyer, offer.price, `${item.name} (limited)`);
  if (!paid.ok) return { error: `You need R$ ${offer.price - paid.balance} more.`, status: 402, price: offer.price };
  const data = load();
  let copy;
  if (offer.from === 'stock') {
    item.sold += 1;
    copy = { uaid: data.nextUaid++, assetId: id(assetId), owner: buyer, serial: item.sold, at: core.isoDate() };
    data.copies.push(copy);
  } else {
    copy = copyOf(offer.uaid);
    const seller = copy.owner;
    data.listings = data.listings.filter((l) => l.uaid !== copy.uaid);
    copy.owner = buyer;
    copy.at = core.isoDate();
    robux().credit(seller, Math.floor(offer.price * SELLER_SHARE), `Sold ${item.name} #${copy.serial}`);
    dropIfGone(seller, assetId);
  }
  recordSale(item, offer.price);
  save();
  return { ok: true, balance: paid.balance, copy };
}

// Put a copy up for sale (price null takes it down) -> { ok } or { error }.
function setListing(userId, uaid, price) {
  const copy = copyOf(uaid);
  if (!copy || copy.owner !== Number(userId)) return { error: 'That isn\'t yours.' };
  const item = load().items[copy.assetId];
  const data = load();
  data.listings = data.listings.filter((l) => l.uaid !== copy.uaid);
  if (price !== null && price !== undefined && price !== '') {
    const amount = Math.round(Number(price));
    if (!(amount >= 1 && amount <= MAX_PRICE)) return { error: 'Pick a price from R$ 1.' };
    if (item && item.sold < item.stock) return { error: 'Copies can be resold once the stock here is sold out.' };
    data.listings.push({ uaid: copy.uaid, price: amount, at: core.isoDate() });
  }
  save();
  return { ok: true };
}

// A trade moves copies (lib/trades.js checks who owns what first).
function transfer(uaid, from, to) {
  const copy = copyOf(uaid);
  if (!copy || copy.owner !== Number(from)) return false;
  const data = load();
  data.listings = data.listings.filter((l) => l.uaid !== copy.uaid);
  copy.owner = Number(to);
  copy.at = core.isoDate();
  save();
  dropIfGone(from, copy.assetId);
  return true;
}

// A player's copies with each item's name and RAP (trade screens, inventories).
function inventory(userId) {
  const data = load();
  return copiesOf(userId).map((c) => {
    const item = data.items[c.assetId] || {};
    const listing = listingOf(c.uaid);
    return { uaid: c.uaid, assetId: c.assetId, serial: c.serial, stock: item.stock || STOCK, name: item.name || `Item ${c.assetId}`, typeId: item.typeId || 0, rap: item.rap || 0, listed: listing ? listing.price : null };
  }).sort((a, b) => b.rap - a.rap);
}

function rapOf(uaid) {
  const copy = copyOf(uaid);
  const item = copy ? load().items[copy.assetId] : null;
  return item ? item.rap : 0;
}

// A deleted account's copies go back to nobody (they can't be sold again).
function forget(userId) {
  const data = load();
  const mine = new Set(copiesOf(userId).map((c) => c.uaid));
  if (!mine.size) return;
  data.listings = data.listings.filter((l) => !mine.has(l.uaid));
  for (const copy of data.copies) if (mine.has(copy.uaid)) copy.owner = 0;
  save();
}

module.exports = {
  STOCK, SELLER_SHARE, ensure, tracked, next, summary, buy, setListing, transfer, inventory, count, copyOf, rapOf, forget,
};
