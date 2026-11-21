'use strict';

// The catalog's shop side: what an item costs and whether Roblox sells it,
// buying items and packages with Robux, and the starting inventory.
//
// Since 2026-11-19 an item must be owned to be worn (lib/launcherapi.js
// cleanAvatar), as in 2017. Prices are Roblox's own. Items Roblox made before
// 2018 that it no longer sells (off sale) cost a fixed price by type here
// (OFF_SALE_PRICES); newer off-sale items can't be bought. Limited items made
// before 2018 sell a small stock here, then between players (lib/limiteds.js).
// Packages (bundles) give their parts too, so a bought package can be worn
// part by part.
//
// What a player wore, or kept in an outfit, before buying started counts as
// theirs: the first time their ownership matters it is all granted at once
// (ownership "_starter" mark), so nobody loses their look.

const path = require('path');
const core = require('./core');
const assets = require('./assets');
const ownership = require('./ownership');
const robux = require('./robux');
const avatarStore = require('./avatarstore');
const outfits = require('./outfits');

const FRESH_MS = 24 * 3600 * 1000;
// "Made before 2018": Roblox's creation date of the item.
const CLASSIC_BEFORE = '2018-01-01';
// What off-sale classic items cost here, by asset type.
const OFF_SALE_PRICES = {
  2: 10, 8: 150, 11: 50, 12: 50, 17: 75, 18: 100, 19: 200,
  27: 50, 28: 50, 29: 50, 30: 50, 31: 50,
  41: 150, 42: 150, 43: 150, 44: 150, 45: 150, 46: 150, 47: 150,
};
const limitedsOf = () => require('./limiteds');

const isClassic = (created) => typeof created === 'string' && created !== '' && created < CLASSIC_BEFORE;
const offSalePrice = (typeId) => (Number.isInteger(OFF_SALE_PRICES[typeId]) ? OFF_SALE_PRICES[typeId] : null);
const RETRY_MS = 5 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 10000;

// The asset types the catalog and inventories show, with 2017's names.
const TYPE_NAMES = {
  2: 'T-Shirt', 8: 'Hat', 11: 'Shirt', 12: 'Pants', 17: 'Head', 18: 'Face', 19: 'Gear',
  27: 'Torso', 28: 'Right Arm', 29: 'Left Arm', 30: 'Left Leg', 31: 'Right Leg', 32: 'Package',
  41: 'Hair Accessory', 42: 'Face Accessory', 43: 'Neck Accessory', 44: 'Shoulder Accessory',
  45: 'Front Accessory', 46: 'Back Accessory', 47: 'Waist Accessory',
};

let cache = null; // id -> { at, info }
let saveTimer = null;
const failedAt = new Map();
const inFlight = new Map();

const cacheFile = () => path.join(core.cacheDir('catalog'), 'items.json');

function loadCache() {
  if (cache === null) {
    const data = core.readJsonFile(cacheFile());
    cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }
  return cache;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    core.writeFileAtomic(cacheFile(), JSON.stringify(loadCache()));
  }, 2000);
}

const decimalId = (value) => (/^\d{1,15}$/.test(String(value)) && Number(value) > 0 ? String(Number(value)) : null);

function trim(id, data) {
  const creator = data.Creator && typeof data.Creator === 'object' ? data.Creator : {};
  const limited = Boolean(data.IsLimited || data.IsLimitedUnique);
  const listed = Number.isInteger(data.PriceInRobux) ? data.PriceInRobux : null;
  // price: R$, 0 when free, null when Roblox does not sell it.
  const price = data.IsForSale && !limited ? (data.IsPublicDomain ? 0 : listed) : null;
  return {
    id, name: String(data.Name || ''), description: String(data.Description || '').slice(0, 1000),
    typeId: Number(data.AssetTypeId) || 0, price, robloxPrice: price, limited,
    originalPrice: listed,
    creator: String(creator.Name || 'Roblox'), created: data.Created || null, updated: data.Updated || null,
  };
}

// Roblox's resale price of a limited (its RAP), for the stock here.
const resaleTried = new Map();
async function robloxResalePrice(id) {
  if (Date.now() - (resaleTried.get(id) || 0) < RETRY_MS) return null;
  resaleTried.set(id, Date.now());
  const data = await assets.httpGetJson(`https://economy.roblox.com/v1/assets/${id}/resale-data`, LOOKUP_TIMEOUT_MS).catch(() => null);
  return data && Number(data.recentAveragePrice) > 0 ? Number(data.recentAveragePrice) : null;
}

// What an item costs here now: { price, classic, limitedInfo: { remaining, stock, from, rap } | null }.
function priced(info, viewer) {
  const robloxPrice = info.robloxPrice !== undefined ? info.robloxPrice : info.price;
  const classic = isClassic(info.created);
  if (info.limited) {
    const next = classic ? limitedsOf().next(info.id, viewer) : null;
    const record = classic ? limitedsOf().summary(info.id) : null;
    return {
      price: next ? next.price : null, classic,
      limitedInfo: record ? { remaining: record.remaining, stock: record.stock, from: next ? next.from : null, rap: record.rap } : null,
    };
  }
  if (robloxPrice !== null && robloxPrice !== undefined) return { price: robloxPrice, classic, limitedInfo: null };
  return { price: classic ? offSalePrice(info.typeId) : null, classic, limitedInfo: null };
}

// The catalog info of an asset -> { id, name, description, typeId, typeName,
// price, limited, creator, created, updated } or null when Roblox can't be
// asked right now.
async function itemInfo(assetId) {
  const id = decimalId(assetId);
  if (!id) return null;
  const cached = loadCache()[id] || null;
  const withName = (info) => (info ? Object.assign({ typeName: TYPE_NAMES[info.typeId] || null }, info, priced(info)) : null);
  if (cached && Date.now() - cached.at < FRESH_MS) return withName(cached.info);
  if (Date.now() - (failedAt.get(id) || 0) < RETRY_MS) return withName(cached && cached.info);
  let pending = inFlight.get(id);
  if (!pending) {
    pending = assets.httpGetJson(`https://economy.roblox.com/v2/assets/${id}/details`, LOOKUP_TIMEOUT_MS).catch(() => null).then((data) => {
      inFlight.delete(id);
      if (!data || typeof data.Name !== 'string') {
        failedAt.set(id, Date.now());
        return cached ? cached.info : null;
      }
      const info = trim(id, data);
      loadCache()[id] = { at: Date.now(), info };
      saveSoon();
      return info;
    });
    inFlight.set(id, pending);
  }
  const info = await pending;
  // A classic limited seen for the first time: its stock here gets Roblox's resale price.
  if (info && info.limited && isClassic(info.created) && !limitedsOf().tracked(id)) {
    const price = (await robloxResalePrice(id)) || info.originalPrice;
    if (price) limitedsOf().ensure(id, { price, name: info.name, typeId: info.typeId });
  }
  return withName(info);
}

// Everything the player wore or kept in an outfit counts as owned, once.
function grantStarter(userId) {
  if (!decimalId(userId) || ownership.marked(userId, 'starter')) return;
  const ids = new Set();
  const worn = avatarStore.get(userId);
  if (worn) for (const asset of worn.assets) ids.add(String(asset.id));
  for (const outfit of outfits.list(userId)) {
    for (const asset of Array.isArray(outfit.assets) ? outfit.assets : []) ids.add(String(asset.id));
  }
  ownership.grantAll(userId, [...ids], 'starter');
}

function owns(userId, assetId) {
  grantStarter(userId);
  if (limitedsOf().count(userId, assetId) > 0) return true;
  return ownership.owns(userId, assetId);
}

// Buy an asset -> { ok, balance, already } or { error, status, price }.
// expected: the price the player saw (a changed price is refused).
// offSalePrice: what an item Roblox no longer sells costs here instead (the
// launcher's classic faces and heads are free), else it can't be bought.
async function buyAsset(who, assetId, expected, offSalePrice) {
  const id = decimalId(assetId);
  if (!who || !(who.userId > 0)) return { error: 'Sign in to buy items.', status: 401 };
  if (!id) return { error: 'No such item.', status: 400 };
  const info = await itemInfo(id);
  if (!info) return { error: 'Could not look this item up on Roblox. Try again in a minute.', status: 502 };
  if (!TYPE_NAMES[info.typeId] || info.typeId === 32) return { error: 'This item is not sold here.', status: 400 };
  // Limiteds: another copy can always be bought (from the stock, then the cheapest seller).
  if (info.limited) {
    if (!info.classic) return { error: 'Only limiteds made before 2018 are sold here.', status: 400 };
    return limitedsOf().buy(who.userId, id, expected);
  }
  if (owns(who.userId, id)) return { ok: true, already: true, balance: robux.balance(who.userId) };
  const price = Number.isInteger(offSalePrice) && info.robloxPrice === null ? offSalePrice : info.price;
  if (price === null) return { error: 'This item is off sale.', status: 400 };
  if (expected !== undefined && expected !== null && Number(expected) !== price) {
    return { error: `The price is now R$ ${price}.`, status: 409, price };
  }
  const paid = robux.charge(who.userId, price, info.name);
  if (!paid.ok) return { error: `You need R$ ${price - paid.balance} more.`, status: 402, price };
  try {
    ownership.grant(who.userId, id);
  } catch (error) {
    if (price > 0) robux.credit(who.userId, price, `Refund: ${info.name}`);
    return { error: 'Could not save the purchase. You were not charged.', status: 500 };
  }
  return { ok: true, balance: paid.balance };
}

// Buy a package (bundle: { id, name, price, items: [{ id }] }, from
// lib/launcherapi.js bundleItems) -> as buyAsset. Its parts are granted too.
function buyBundle(who, bundle, expected) {
  if (!who || !(who.userId > 0)) return { error: 'Sign in to buy items.', status: 401 };
  if (!bundle || bundle.error) return { error: (bundle && bundle.error) || 'No such package.', status: 502 };
  const parts = bundle.items.map((item) => item.id);
  if (ownership.ownsBundle(who.userId, bundle.id)) {
    ownership.grantAll(who.userId, parts); // packages bought before parts were granted
    return { ok: true, already: true, balance: robux.balance(who.userId) };
  }
  if (bundle.price === null) return { error: 'This package is off sale.', status: 400 };
  if (expected !== undefined && expected !== null && Number(expected) !== bundle.price) {
    return { error: `The price is now R$ ${bundle.price}.`, status: 409, price: bundle.price };
  }
  const paid = robux.charge(who.userId, bundle.price, bundle.name);
  if (!paid.ok) return { error: `You need R$ ${bundle.price - paid.balance} more.`, status: 402, price: bundle.price };
  try {
    ownership.grantBundle(who.userId, bundle.id);
    ownership.grantAll(who.userId, parts);
  } catch (error) {
    if (bundle.price > 0) robux.credit(who.userId, bundle.price, `Refund: ${bundle.name}`);
    return { error: 'Could not save the purchase. You were not charged.', status: 500 };
  }
  return { ok: true, balance: paid.balance };
}

module.exports = { itemInfo, owns, grantStarter, buyAsset, buyBundle, TYPE_NAMES, OFF_SALE_PRICES, CLASSIC_BEFORE, isClassic, offSalePrice, priced };

