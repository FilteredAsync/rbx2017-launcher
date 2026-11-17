'use strict';

// MarketplaceService for the 2017 engine: what games, and the client's
// purchase prompt, ask the site about products, ownership and purchases
// (www/marketplace/..., api.<domain>/...).
//
// Purchases cost the player's Robux (lib/robux.js), at the Roblox price:
// - Product info is the real Roblox info (games show names, prices and icons
//   in their shops, and some use more: Lumber Tycoon 2 grants a money pack's
//   Description), looked up once and kept in data/product-info.json, and
//   always for sale. The prompt shows its price and the player's balance
//   (currency/balance); an item with no Roblox price is offered "for FREE".
//   Newer game passes have IDs of their own, which are also other assets'
//   IDs: an ID that is one of the asking game's passes (its universe's, when
//   the place has a universe ID) is answered as that pass.
// - Assets and game passes are owned once bought (lib/ownership.js): the
//   client's prompt posts marketplace/purchase with the item's ProductId,
//   and PlayerOwnsAsset, GamePassService:PlayerHasPass and
//   UserOwnsGamePassAsync (lib/luacompat.js) answer from what was bought.
// - Developer products (bought again and again) go through the 2017 receipt
//   flow: the client's purchase gets a receipt here (submitpurchase), the game
//   server checks it (validatepurchase) and calls the game's ProcessReceipt,
//   which grants the product. A receipt the game never grants is refunded
//   after an hour.
// The price charged is this server's own, never the one the client sends.
// The buyer is the player who joined from the request's address (the client
// reaches this server through its player's proxy), as for in-game friend
// requests; guests cannot buy (the 2017 prompt refuses them itself).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const assets = require('./assets');
const ownership = require('./ownership');
const robux = require('./robux');

const FILE = core.rootPath('Webserver', 'node', 'data', 'product-info.json');
const RECEIPTS_FILE = core.rootPath('Webserver', 'node', 'data', 'receipts.json');
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const WAIT_MS = 4000; // longest a game waits for a lookup; it still fills the cache
const LOOKUP_TIMEOUT_MS = 10000;
const PARALLEL = 4;
const RECEIPT_MS = 60 * 60 * 1000;

const LOOKUP_URLS = {
  asset: (id) => `https://economy.roblox.com/v2/assets/${id}/details`,
  product: (id) => `https://apis.roblox.com/developer-products/v1/developer-products/${id}/details`,
  // A universe's game passes (the first 100).
  passes: (id) => `https://apis.roblox.com/game-passes/v1/universes/${id}/game-passes?passView=Full&pageSize=100`,
  // A universe's badges (the first 100; the launcher's game page).
  badges: (id) => `https://badges.roblox.com/v1/universes/${id}/badges?limit=100&sortOrder=Asc`,
};
const GAME_PASS_TYPE = 34; // the prompt says "Game Pass"

// Lumber Tycoon 2 (place 1818, which comes with this server) grants a money
// pack's Description, and Roblox's text filter has since hidden two of them
// as "####". Its packs as they were, so they work offline too.
const KNOWN_PRODUCTS = {
  25386984: ['$500', '500', 9, 371864515],
  25386995: ['$1,250', '1250', 25, 371864822],
  25387014: ['$2,500', '2500', 49, 371864914],
  25387029: ['$5,000', '5000', 99, 371861626],
  25387042: ['$50,000', '50000', 999, 371861801],
  25387075: ['$100,000', '100000', 1799, 371864666],
};

const ROBLOX_CREATOR = { Id: 1, Name: 'ROBLOX', CreatorType: 'User', CreatorTargetId: 1 };
const KEPT_FIELDS = ['TargetId', 'ProductType', 'AssetId', 'ProductId', 'Name', 'Description', 'AssetTypeId',
  'IconImageAssetId', 'Created', 'Updated', 'PriceInRobux'];

// --- Product info --------------------------------------------------------------

let cache = null; // "asset:<id>" | "product:<id>" | "passes:<universeId>" -> { at, info }
const failedAt = new Map();
const inFlight = new Map();
const queue = [];
let running = 0;
let saveTimer = null;

function loadCache() {
  if (cache === null) {
    const data = core.readJsonFile(FILE);
    cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }
  return cache;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    core.writeFileAtomic(FILE, JSON.stringify(cache));
  }, 2000);
}

function trimInfo(data) {
  const info = {};
  for (const key of KEPT_FIELDS) if (data[key] !== undefined) info[key] = data[key];
  const creator = data.Creator && typeof data.Creator === 'object' ? data.Creator : null;
  info.Creator = creator
    ? { Id: Number(creator.Id) || 0, Name: String(creator.Name || ''), CreatorType: creator.CreatorType === 'Group' ? 'Group' : 'User', CreatorTargetId: Number(creator.CreatorTargetId) || 0 }
    : ROBLOX_CREATOR;
  return info;
}

function trimPasses(data) {
  return data.gamePasses.filter((pass) => pass && Number(pass.id) > 0).map((pass) => {
    const creator = pass.creator && typeof pass.creator === 'object' ? pass.creator : {};
    return {
      id: Number(pass.id), productId: Number(pass.productId) || 0, name: String(pass.displayName || pass.name || ''),
      description: String(pass.displayDescription || ''), price: Number(pass.price) || 0, icon: Number(pass.displayIconImageAssetId) || 0,
      creator: { Id: Number(creator.creatorId) || 0, Name: String(creator.name || ''), CreatorType: creator.creatorType === 'Group' ? 'Group' : 'User', CreatorTargetId: Number(creator.creatorId) || 0 },
      created: pass.created || null, updated: pass.updated || null,
    };
  });
}

function trimBadges(data) {
  return data.data.filter((badge) => badge && Number(badge.id) > 0).map((badge) => ({
    id: Number(badge.id), name: String(badge.displayName || badge.name || ''), description: String(badge.displayDescription || badge.description || ''),
    icon: Number(badge.displayIconImageId || badge.iconImageId) || 0, enabled: badge.enabled !== false,
    awarded: Number(badge.statistics && badge.statistics.awardedCount) || 0,
  }));
}

// A few lookups at a time, so a game asking about hundreds of items at once
// does not run into Roblox's rate limits.
function queuedLookup(kind, id) {
  return new Promise((resolve) => {
    queue.push({ url: LOOKUP_URLS[kind](id), resolve });
    pump();
  });
}

function pump() {
  while (running < PARALLEL && queue.length > 0) {
    const job = queue.shift();
    running++;
    assets.httpGetJson(job.url, LOOKUP_TIMEOUT_MS).catch(() => null).then((data) => {
      running--;
      job.resolve(data);
      pump();
    });
  }
}

// The Roblox info of an asset or developer product (or a universe's game
// passes), or null when it is not known (yet). A game waits at most
// WAIT_MS; a slower lookup is kept for the next time.
function lookUp(kind, id) {
  const key = `${kind}:${id}`;
  const cached = loadCache()[key] || null;
  const fallback = cached ? cached.info : null;
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(fallback);
  if (Date.now() - (failedAt.get(key) || 0) < RETRY_MS) return Promise.resolve(fallback);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = queuedLookup(kind, id).then((data) => {
      inFlight.delete(key);
      const valid = kind === 'passes' ? Array.isArray(data && data.gamePasses)
        : kind === 'badges' ? Array.isArray(data && data.data) : Boolean(data) && typeof data.Name === 'string';
      if (!valid) {
        failedAt.set(key, Date.now());
        return fallback;
      }
      const info = kind === 'passes' ? trimPasses(data) : kind === 'badges' ? trimBadges(data) : trimInfo(data);
      loadCache()[key] = { at: Date.now(), info };
      failedAt.delete(key);
      saveSoon();
      return info;
    });
    inFlight.set(key, pending);
  }
  return Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(fallback), WAIT_MS))]);
}

// The R$ price of product info (0: free).
function priceOf(info) {
  const price = Math.floor(Number(info && info.PriceInRobux));
  return Number.isFinite(price) && price > 0 ? price : 0;
}

// For sale at its price, so the 2017 prompt never refuses it as not for
// sale, limited or for Builders Club; with no price it is offered "for
// FREE" (IsPublicDomain).
function forSale(info) {
  const price = priceOf(info);
  return Object.assign(info, {
    PriceInRobux: price, PriceInTickets: null, Sales: 0, IsNew: false, IsForSale: true, IsPublicDomain: price === 0,
    IsLimited: false, IsLimitedUnique: false, Remaining: null, MinimumMembershipLevel: 0, ContentRatingTypeId: 0,
  });
}

// The ProductId each answer below gave -> the asset or pass ID it was for
// (the prompt buys by ProductId), and pass ID -> icon.
const productTargets = new Map();
const passIcons = new Map();

// One of these universes' game passes with that ID, as product info, or null.
async function gamePassInfo(id, universeIds) {
  for (const universeId of new Set(universeIds.map(Number).filter((n) => n > 0))) {
    const list = await lookUp('passes', universeId);
    const pass = Array.isArray(list) ? list.find((entry) => entry.id === id) : null;
    if (!pass) continue;
    if (pass.icon > 0) passIcons.set(id, String(pass.icon));
    return {
      TargetId: id, ProductType: 'Game Pass', AssetId: id, ProductId: pass.productId, Name: pass.name, Description: pass.description,
      AssetTypeId: GAME_PASS_TYPE, Creator: pass.creator, IconImageAssetId: pass.icon,
      Created: pass.created, Updated: pass.updated, PriceInRobux: pass.price,
    };
  }
  return null;
}

// MarketplaceService:GetProductInfo(assetId): www/marketplace/productinfo.
// universeIds: of the game(s) asking. One of their passes answers as that
// pass: a newer pass ID is also some other asset's ID (Clone Tycoon 2's
// 646230062 and 646477071 are places), and a game means its own pass.
async function assetInfo(assetId, universeIds = []) {
  const id = Number(assetId);
  const found = id > 0 ? (await gamePassInfo(id, universeIds)) || (await lookUp('asset', id)) : null;
  const info = found ? Object.assign({}, found) : {
    TargetId: id, ProductType: 'User Product', AssetId: id, ProductId: 0,
    Name: id === 1818 ? 'Lumber Tycoon 2' : `Local Asset ${id}`, Description: 'Served by the local game server.',
    AssetTypeId: 0, Creator: ROBLOX_CREATOR, IconImageAssetId: 0,
    Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z', PriceInRobux: 0,
  };
  // Roblox now gives passes (old ones too) type 0; 2017 called them type 34.
  if (info.ProductType === 'Game Pass') info.AssetTypeId = GAME_PASS_TYPE;
  if (!(Number(info.ProductId) > 0)) info.ProductId = id;
  if (id > 0) productTargets.set(Number(info.ProductId), id);
  return forSale(info);
}

// The icon of an ID answered as a game pass (the prompt shows the asset
// thumbnail of the ID it was given), or null.
function passIcon(assetId) {
  return passIcons.get(Number(assetId)) || null;
}

// MarketplaceService:GetProductInfo(productId, Enum.InfoType.Product):
// www/marketplace/productDetails.
async function productInfo(productId) {
  const id = Number(productId);
  const known = KNOWN_PRODUCTS[id];
  const found = known || !(id > 0) ? null : await lookUp('product', id);
  const info = found ? Object.assign({}, found) : {
    TargetId: id, ProductType: 'Developer Product', AssetId: 0, ProductId: id,
    Name: known ? known[0] : `Product ${id}`, Description: known ? known[1] : '',
    AssetTypeId: 0, Creator: ROBLOX_CREATOR, IconImageAssetId: known ? known[3] : 0,
    Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z', PriceInRobux: known ? known[2] : 0,
  };
  return forSale(info);
}

// --- Purchases -------------------------------------------------------------------

// receipt -> { userId, productId, placeId, price, name, requestId, at, done },
// kept in data/receipts.json so a restart loses neither a paid product nor
// its refund.
let receipts = null;

function loadReceipts() {
  if (receipts === null) {
    const data = core.readJsonFile(RECEIPTS_FILE);
    receipts = new Map(data && typeof data === 'object' && !Array.isArray(data) ? Object.entries(data) : []);
  }
  return receipts;
}

function saveReceipts() {
  fs.mkdirSync(path.dirname(RECEIPTS_FILE), { recursive: true });
  return core.writeFileAtomic(RECEIPTS_FILE, JSON.stringify(Object.fromEntries(loadReceipts())));
}

// Receipts older than an hour go; the Robux of one the game never granted
// goes back to the player. Also run every minute (lib/launcherapi.js).
function expireReceipts() {
  const oldest = Date.now() - RECEIPT_MS;
  let changed = false;
  for (const [receipt, entry] of loadReceipts()) {
    if (entry.at >= oldest) continue;
    if (!entry.done && entry.price > 0) {
      try {
        robux.credit(entry.userId, entry.price, `Refund: ${entry.name || `product ${entry.productId}`}`);
      } catch (error) {
        continue; // tried again next time
      }
    }
    receipts.delete(receipt);
    changed = true;
  }
  if (changed) saveReceipts();
}

function formFields(body) {
  const fields = {};
  for (const [key, value] of new URLSearchParams(String(body || ''))) fields[key.toLowerCase()] = value;
  return fields;
}

// The price the prompt showed (sent as a form field) is below this server's:
// the player would pay more than they agreed to.
function shownBelow(fields, name, price) {
  if (fields[name] === undefined || fields[name] === '') return false;
  const shown = Number(fields[name]);
  return Number.isFinite(shown) && shown < price;
}

// POST marketplace/submitpurchase (a developer product, from the client's
// purchase prompt): takes its price and gives a receipt for the game server
// to check.
// buyer: { userId } of the player at the request's address, or null.
async function submitPurchase(buyer, body) {
  expireReceipts();
  const fields = formFields(body);
  const productId = Number(fields.productid);
  const placeId = Number(fields.placeid) || 0;
  if (!buyer || !(buyer.userId > 0)) return { success: false, status: 'NotAuthorized' };
  if (!(productId > 0)) return { success: false, status: 'InvalidArguments' };
  // The prompt sends a request ID; asking again with it gives the same
  // receipt, paid once.
  const requestId = String(fields.requestid || '').slice(0, 64);
  const earlier = () => {
    if (!requestId) return null;
    for (const [receipt, entry] of loadReceipts()) if (entry.requestId === requestId && entry.userId === buyer.userId) return receipt;
    return null;
  };
  if (earlier()) return { success: true, status: 'Bought', receipt: earlier() };
  const info = await productInfo(productId);
  const price = info.IsPublicDomain ? 0 : priceOf(info);
  if (shownBelow(fields, 'expectedunitprice', price)) return { success: false, status: 'PriceChanged' };
  if (earlier()) return { success: true, status: 'Bought', receipt: earlier() }; // a retry that came in meanwhile
  const paid = robux.charge(buyer.userId, price, info.Name);
  if (!paid.ok) return { success: false, status: 'InsufficientFunds' };
  const receipt = crypto.randomBytes(16).toString('hex');
  loadReceipts().set(receipt, { userId: buyer.userId, productId, placeId, price, name: String(info.Name || '').slice(0, 60), requestId, at: Date.now(), done: false });
  if (!saveReceipts()) {
    receipts.delete(receipt);
    if (price > 0) robux.credit(buyer.userId, price, `Refund: ${info.Name}`);
    return { success: false, status: 'InternalError' };
  }
  return { success: true, status: 'Bought', receipt };
}

// The asset or game pass a purchase's ProductId is for: the one whose info
// gave it (asked for just before the purchase, or kept in the cache), else
// the ID itself (info made here, or with no ProductId, uses the asset ID).
function purchasedItem(productId) {
  if (productTargets.has(productId)) return productTargets.get(productId);
  for (const [key, entry] of Object.entries(loadCache())) {
    const info = entry && entry.info;
    if (key.startsWith('asset:') && info && Number(info.ProductId) === productId) return Number(key.slice(6));
    const pass = key.startsWith('passes:') && Array.isArray(info) ? info.find((p) => p.productId === productId) : null;
    if (pass) return pass.id;
  }
  return productId;
}

// POST marketplace/purchase (an asset or game pass, from the client's
// purchase prompt: productId=<its ProductId>&currencyTypeId=&purchasePrice=
// &locationType=Game&locationId=<place>): takes its price, and the buyer owns
// it from now on. The prompt then fires PromptPurchaseFinished in the game.
// universeIds: of the game the buyer is in (its passes are priced as passes).
async function purchaseAsset(buyer, body, universeIds = []) {
  const fields = formFields(body);
  const productId = Number(fields.productid);
  if (!buyer || !(buyer.userId > 0)) return { success: false, status: 'NotAuthorized' };
  if (!(productId > 0)) return { success: false, status: 'InvalidArguments' };
  const assetId = purchasedItem(productId);
  // The prompt counts AlreadyOwned as bought.
  const owned = () => ownership.owns(buyer.userId, assetId);
  if (owned()) return { success: true, status: 'AlreadyOwned', productId, assetId };
  const info = await assetInfo(assetId, universeIds);
  const price = info.IsPublicDomain ? 0 : priceOf(info);
  if (shownBelow(fields, 'purchaseprice', price)) return { success: false, status: 'PriceChanged' };
  if (owned()) return { success: true, status: 'AlreadyOwned', productId, assetId }; // a second click meanwhile
  const paid = robux.charge(buyer.userId, price, info.Name);
  if (!paid.ok) return { success: false, status: 'InsufficientFunds' };
  try {
    ownership.grant(buyer.userId, assetId);
  } catch (error) {
    if (price > 0) robux.credit(buyer.userId, price, `Refund: ${info.Name}`);
    return { success: false, status: 'InternalError' };
  }
  return { success: true, status: 'Bought', productId, assetId };
}

// GET marketplace/validatepurchase?receipt= (the game server, before it calls
// ProcessReceipt).
function validatePurchase(receipt) {
  const entry = loadReceipts().get(String(receipt || ''));
  if (!entry) return { playerId: 0, placeId: 0, isValid: false, productId: 0, errorReason: 'Unknown receipt' };
  return { playerId: entry.userId, placeId: entry.placeId, isValid: true, productId: entry.productId };
}

// GET gametransactions/getpendingtransactions/?PlaceId=&PlayerId= (the game
// server, when a purchase is signalled and when a player joins): the
// player's purchases in that place the game has not granted yet. Each goes
// to the game's ProcessReceipt.
function pendingPurchases(placeId, playerId) {
  expireReceipts();
  const list = [];
  for (const [receipt, entry] of loadReceipts()) {
    if (entry.done || entry.userId !== Number(playerId) || (entry.placeId && entry.placeId !== Number(placeId))) continue;
    list.push({
      playerId: entry.userId,
      placeId: entry.placeId || Number(placeId),
      receipt,
      actionArgs: [
        { Key: 'productId', Value: String(entry.productId) },
        { Key: 'currencyTypeId', Value: '1' },
        { Key: 'unitPrice', Value: String(entry.price) },
      ],
    });
  }
  return list;
}

// POST gametransactions/settransactionstatuscomplete (receipt=...): the game
// granted it.
function completePurchase(body) {
  const entry = loadReceipts().get(String(formFields(body).receipt || ''));
  if (entry && !entry.done) {
    entry.done = true;
    saveReceipts();
  }
  return { success: Boolean(entry) };
}

// A universe's game passes and badges as Roblox lists them (cached): [] for
// no universe, null while the first lookup is still running.
async function universePasses(universeId) {
  return Number(universeId) > 0 ? lookUp('passes', Number(universeId)) : [];
}
async function universeBadges(universeId) {
  return Number(universeId) > 0 ? lookUp('badges', Number(universeId)) : [];
}

module.exports = {
  universePasses, universeBadges, assetInfo, passIcon, productInfo,
  submitPurchase, purchaseAsset, validatePurchase, pendingPurchases, completePurchase, expireReceipts,
};
