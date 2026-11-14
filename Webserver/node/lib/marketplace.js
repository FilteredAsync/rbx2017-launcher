'use strict';

// MarketplaceService for the 2017 engine: what games, and the client's
// purchase prompt, ask the site about products, ownership and purchases
// (www/marketplace/..., api.<domain>/...).
//
// There is no Robux here, so everything is free:
// - Product info is the real Roblox info (games show names, prices and icons
//   in their shops, and some use more: Lumber Tycoon 2 grants a money pack's
//   Description), looked up once and kept in data/product-info.json, marked
//   free and for sale, so the purchase prompt offers it "for FREE".
// - Assets and game passes count as owned, like UserOwnsGamePassAsync
//   (lib/luacompat.js): PlayerOwnsAsset and GamePassService:PlayerHasPass
//   answer yes.
// - Developer products (bought again and again) go through the 2017 receipt
//   flow: the client's purchase gets a receipt here (submitpurchase), the game
//   server checks it (validatepurchase) and calls the game's ProcessReceipt,
//   which grants the product.
// The buyer is the player who joined from the request's address (the client
// reaches this server through its player's proxy), as for in-game friend
// requests; guests cannot buy (the 2017 prompt refuses them itself).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const assets = require('./assets');

const FILE = core.rootPath('Webserver', 'node', 'data', 'product-info.json');
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const WAIT_MS = 4000; // longest a game waits for a lookup; it still fills the cache
const LOOKUP_TIMEOUT_MS = 10000;
const PARALLEL = 4;
const RECEIPT_MS = 60 * 60 * 1000;

const LOOKUP_URLS = {
  asset: (id) => `https://economy.roblox.com/v2/assets/${id}/details`,
  product: (id) => `https://apis.roblox.com/developer-products/v1/developer-products/${id}/details`,
};

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

let cache = null; // "asset:<id>" | "product:<id>" -> { at, info }
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

// The Roblox info of an asset or developer product, or null when it is not
// known (yet). A game waits at most WAIT_MS; a slower lookup is kept for the
// next time.
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
      if (!data || typeof data.Name !== 'string') {
        failedAt.set(key, Date.now());
        return fallback;
      }
      const info = trimInfo(data);
      loadCache()[key] = { at: Date.now(), info };
      failedAt.delete(key);
      saveSoon();
      return info;
    });
    inFlight.set(key, pending);
  }
  return Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(fallback), WAIT_MS))]);
}

// Free and for sale, so the 2017 prompt offers it "for FREE" (IsPublicDomain)
// and never refuses it as not for sale, limited or for Builders Club.
function free(info) {
  return Object.assign(info, {
    PriceInTickets: null, Sales: 0, IsNew: false, IsForSale: true, IsPublicDomain: true,
    IsLimited: false, IsLimitedUnique: false, Remaining: null, MinimumMembershipLevel: 0, ContentRatingTypeId: 0,
  });
}

// MarketplaceService:GetProductInfo(assetId): www/marketplace/productinfo.
async function assetInfo(assetId) {
  const id = Number(assetId);
  const found = id > 0 ? await lookUp('asset', id) : null;
  const info = found ? Object.assign({}, found) : {
    TargetId: id, ProductType: 'User Product', AssetId: id, ProductId: 0,
    Name: id === 1818 ? 'Lumber Tycoon 2' : `Local Asset ${id}`, Description: 'Served by the local game server.',
    AssetTypeId: 0, Creator: ROBLOX_CREATOR, IconImageAssetId: 0,
    Created: '2015-01-01T00:00:00Z', Updated: '2017-01-01T00:00:00Z', PriceInRobux: 0,
  };
  return free(info);
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
  return free(info);
}

// --- Purchases -------------------------------------------------------------------

const receipts = new Map(); // receipt -> { userId, productId, placeId, price, requestId, at, done }

function pruneReceipts() {
  const oldest = Date.now() - RECEIPT_MS;
  for (const [receipt, entry] of receipts) if (entry.at < oldest) receipts.delete(receipt);
}

function formFields(body) {
  const fields = {};
  for (const [key, value] of new URLSearchParams(String(body || ''))) fields[key.toLowerCase()] = value;
  return fields;
}

// POST marketplace/submitpurchase (a developer product, from the client's
// purchase prompt): a receipt for the game server to check.
// buyer: { userId } of the player at the request's address, or null.
function submitPurchase(buyer, body) {
  pruneReceipts();
  const fields = formFields(body);
  const productId = Number(fields.productid);
  const placeId = Number(fields.placeid) || 0;
  if (!buyer || !(buyer.userId > 0)) return { success: false, status: 'NotAuthorized' };
  if (!(productId > 0)) return { success: false, status: 'InvalidArguments' };
  // The prompt sends a request ID; asking again with it gives the same receipt.
  const requestId = String(fields.requestid || '');
  if (requestId) {
    for (const [receipt, entry] of receipts) {
      if (entry.requestId === requestId && entry.userId === buyer.userId) return { success: true, status: 'Bought', receipt };
    }
  }
  const receipt = crypto.randomBytes(16).toString('hex');
  receipts.set(receipt, { userId: buyer.userId, productId, placeId, price: Number(fields.expectedunitprice) || 0, requestId, at: Date.now(), done: false });
  return { success: true, status: 'Bought', receipt };
}

// GET marketplace/validatepurchase?receipt= (the game server, before it calls
// ProcessReceipt).
function validatePurchase(receipt) {
  const entry = receipts.get(String(receipt || ''));
  if (!entry) return { playerId: 0, placeId: 0, isValid: false, productId: 0, errorReason: 'Unknown receipt' };
  return { playerId: entry.userId, placeId: entry.placeId, isValid: true, productId: entry.productId };
}

// GET gametransactions/getpendingtransactions/?PlaceId=&PlayerId= (the game
// server, when a purchase is signalled and when a player joins): the
// player's purchases in that place the game has not granted yet. Each goes
// to the game's ProcessReceipt.
function pendingPurchases(placeId, playerId) {
  pruneReceipts();
  const list = [];
  for (const [receipt, entry] of receipts) {
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
  const entry = receipts.get(String(formFields(body).receipt || ''));
  if (entry) entry.done = true;
  return { success: Boolean(entry) };
}

module.exports = { assetInfo, productInfo, submitPurchase, validatePurchase, pendingPurchases, completePurchase };
