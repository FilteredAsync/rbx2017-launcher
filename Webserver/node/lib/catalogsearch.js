'use strict';

// The website's catalog search, laid out like 2017's catalog: a category tree,
// filters (creator, price, made before 2018, off-sale items), sorts and
// numbered pages.
//
//   GET /api/catalog/search ?category=&sub=&keyword=&creator=&min=&max=&free=
//                           &sort=&era=&unavailable=&page=
//       -> { items, total, page, pages, perPage }
//
// Roblox's own catalog search is slow to ask (it answers "429 Too Many
// Requests" after a few quick searches), has no page numbers and is mostly
// new items. So answers come from an index on this server of the catalog
// items it has seen:
//   - a slow crawl of Roblox's public catalog, most favorited first: all of
//     Roblox's own hats, accessories, gear and packages, collectibles, and
//     the best-liked clothing (one request every few seconds, again weekly);
//   - every keyword or creator search, asked of Roblox once per half hour and
//     added to the index before the answer;
//   - items looked up elsewhere (lib/catalog.js itemInfo).
// Prices follow lib/catalog.js (Roblox's price; off-sale items made before
// 2018 at a fixed price by type; classic limiteds from the stock here).
// "Bestselling" counts the copies players here own.
//
// config/server.json "catalogCrawl": false turns the crawl off.

const path = require('path');
const core = require('./core');
const assets = require('./assets');
const catalog = require('./catalog');
const accounts = require('./accounts');
const ownership = require('./ownership');
const limiteds = require('./limiteds');

const PER_PAGE = 30;
const MAX_PAGE = 400;
const CLASSIC_BEFORE = catalog.CLASSIC_BEFORE;
// Roblox remade the classic packages as bundles in August 2018.
const CLASSIC_BUNDLES_BEFORE = '2018-09-01';
const PACKAGE = 32;
const ACCESSORIES = [8, 41, 42, 43, 44, 45, 46, 47];
const CLOTHING = [11, 2, 12];
const LIMITED_TYPES = [...ACCESSORIES, 18, 19];
const KNOWN_TYPES = new Set([2, 8, 11, 12, 17, 18, 19, ...ACCESSORIES]);

// 2017's category tree (its search-options): category -> subcategories.
// A sub is { types } (asset types, PACKAGE for bundles), optionally limited
// to collectibles (limited), Roblox's own (roblox) or a gear kind (gear).
const CATEGORIES = {
  featured: { roblox: true, subs: {
    all: { types: [...ACCESSORIES, 18, 19, PACKAGE] },
    accessories: { types: ACCESSORIES }, faces: { types: [18] }, gear: { types: [19] }, packages: { types: [PACKAGE] },
  } },
  all: { subs: { all: { types: [...KNOWN_TYPES, PACKAGE] } } },
  collectibles: { limited: true, subs: {
    all: { types: LIMITED_TYPES }, accessories: { types: ACCESSORIES }, faces: { types: [18] }, gear: { types: [19] },
  } },
  clothing: { subs: {
    all: { types: [...CLOTHING, PACKAGE] }, shirts: { types: [11] }, tshirts: { types: [2] }, pants: { types: [12] }, packages: { types: [PACKAGE] },
  } },
  bodyparts: { subs: {
    all: { types: [17, 18, PACKAGE] }, heads: { types: [17] }, faces: { types: [18] }, packages: { types: [PACKAGE] },
  } },
  gear: { subs: {
    all: { types: [19] }, building: { types: [19], gear: 'building' }, explosive: { types: [19], gear: 'explosive' },
    melee: { types: [19], gear: 'melee' }, musical: { types: [19], gear: 'musical' }, navigation: { types: [19], gear: 'navigation' },
    powerup: { types: [19], gear: 'powerup' }, ranged: { types: [19], gear: 'ranged' }, social: { types: [19], gear: 'social' },
    transport: { types: [19], gear: 'transport' },
  } },
  accessories: { subs: {
    all: { types: ACCESSORIES }, hats: { types: [8] }, hair: { types: [41] }, face: { types: [42] }, neck: { types: [43] },
    shoulder: { types: [44] }, front: { types: [45] }, back: { types: [46] }, waist: { types: [47] },
  } },
};
const SORTS = new Set(['relevance', 'favorited', 'bestselling', 'updated', 'price-asc', 'price-desc']);

// Gear kinds, from the words in a gear's name and description (Roblox's
// catalog no longer says which kind a gear is). First match wins.
const GEAR_KINDS = [
  ['musical', /\b(guitar|drum|drums|flute|piano|keytar|boombox|radio|trumpet|harp|violin|saxophone|sax|ukulele|banjo|accordion|tuba|trombone|bell|bells|music|musical|instrument|song|tune|microphone|tambourine|xylophone|bagpipes?)\b/i],
  ['explosive', /\b(bomb|bombs|rocket|rockets|grenade|grenades|dynamite|tnt|explosive|explodes?|explosion|missile|mine|landmine|nuke|c4|firework|fireworks|kaboom|blast)\b/i],
  ['ranged', /\b(gun|guns|blaster|bow|crossbow|launcher|slingshot|rifle|pistol|cannon|shotgun|revolver|ray|laser|shoots?|shooting|dart|darts|arrow|arrows|sniper|zapper|wand|staff|projectiles?|throwing|throw|ninja star|shuriken|boomerang|spear|javelin)\b/i],
  ['melee', /\b(sword|swords|blade|katana|knife|dagger|axe|hammer|mace|scythe|sickle|saber|sabre|cutlass|rapier|club|bat|lance|halberd|trident|claymore|slash|slashes|lunge|sword-?fight|swordfight|fists?|punch|nunchucks?|whip|flail|cleaver|machete|glaive)\b/i],
  ['transport', /\b(car|cars|bike|bicycle|motorcycle|horse|carpet|skateboard|hoverboard|surfboard|snowboard|board|jetpack|vehicle|ride|riding|kart|scooter|unicycle|segway|boat|ship|plane|helicopter|ufo|sled|mount|pogo|broom|broomstick|cloud)\b/i],
  ['navigation', /\b(teleport|teleporter|grapple|grappling|hook|glider|wings|parachute|jump|jumps|jumping|coil|speed|map|compass|flashlight|lantern|torch|climb|fly|flying|flight|portal|warp|dash|boots)\b/i],
  ['building', /\b(build|builder|building|brick|bricks|block|blocks|wall|walls|paint|paintbrush|tool|tools|wrench|clone|delete|resize|construct|construction|fort|bridge|place|placer|creator|lego|stamper)\b/i],
  ['powerup', /\b(potion|elixir|drink|cola|soda|juice|tea|coffee|latte|milk|food|burger|pizza|cake|cupcake|candy|cookie|sandwich|taco|hotdog|apple|heal|heals|healing|health|regen|shield|armor|armour|power|powers|powerup|boost|invisibility|invisible|mushroom|magic|spell|giant|shrink|grow|forcefield)\b/i],
  ['social', /\b(phone|camera|sign|balloon|balloons|trophy|flag|pet|dance|wave|emote|hug|kiss|gift|present|card|confetti|party|toy|book|umbrella|selfie|wand|bubble|bubbles|snowball|hi|hello|friend|friends|plush|chat|message)\b/i],
];

// Classic faces and heads: Roblox's search no longer lists them, so they come
// from the same fixed list as the launcher's (lib/launcherapi.js CLASSIC).
// Free here, as there.
const CLASSIC_FACES = [
  [144075659, 'Smile'], [7074661, 'Classic Goof'], [7074786, 'Check It'], [7074729, 'Glee'], [7074764, 'Chill'],
  [7074893, 'Drool'], [7074836, 'Classic Vampire'], [7075142, 'Fang'], [7076076, 'Hmmm...'], [8329679, 'Stitchface'],
  [9250660, 'Concerned'], [12145366, 'Freckles'], [15432080, ':3'], [16132514, ':D'], [20418658, 'Err...'],
  [20722130, 'Shiny Teeth'], [23219981, 'Nervous'], [25166274, 'Squiggle Mouth'], [27725434, 'Friendly Puppy'],
  [31117267, 'Skeptic'], [86487700, 'Man Face'], [141728790, 'Tired Face'], [162068415, 'YAAAWWN.'],
  [209994875, 'Smiling Girl'], [255827175, 'Serious Scar Face'], [334656210, 'Miss Scarlet'], [616380929, 'The Winning Smile'],
];
const CLASSIC_HEADS = [
  [6340101, 'Blockhead'], [6340133, 'Octoblox'], [6340141, 'Hex'], [6340154, 'ROX BOX'], [6340161, 'Eraser Head'],
  [6340192, 'Cylinder Madness'], [6340208, 'Flat Top'], [6340213, 'Roundy'], [6340227, 'Trim'], [6340258, 'Cool Thing'],
  [6340269, 'Perfection'],
];

// --- the index ---------------------------------------------------------------------
// id ("a<assetId>" or "b<bundleId>") -> { id, kind, name, type, creator,
// creatorType, roblox, created, updated, price (Roblox's; null off sale),
// limited, collectible, resale, favorites, gear, free, seen }

const SAVE_DELAY_MS = 60 * 1000;
let index = null;
let crawlState = null;
let dirty = false;
let saveTimer = null;

const indexFile = () => path.join(core.cacheDir('catalog'), 'index.json');

function load() {
  if (index) return index;
  const data = core.readJsonFile(indexFile());
  index = new Map();
  crawlState = data && data.crawl && typeof data.crawl === 'object' ? data.crawl : {};
  for (const entry of data && Array.isArray(data.items) ? data.items : []) {
    if (!entry || typeof entry.id !== 'string') continue;
    // Kinds from the name win (the words may have changed since).
    if (entry.type === 19) entry.gear = gearKind(entry.name, '') || entry.gear || null;
    index.set(entry.id, entry);
  }
  const now = Date.now();
  for (const [list, type] of [[CLASSIC_FACES, 18], [CLASSIC_HEADS, 17]]) {
    for (const [id, name] of list) {
      const key = `a${id}`;
      if (!index.has(key)) {
        index.set(key, { id: key, kind: 'asset', name, type, creator: 'Roblox', creatorType: 'User', roblox: true, created: '2008-01-01', price: null, favorites: 0, seen: now });
      }
      index.get(key).free = true;
    }
  }
  return index;
}

function save() {
  saveTimer = null;
  if (!dirty) return;
  dirty = false;
  core.writeFileAtomic(indexFile(), JSON.stringify({ version: 1, crawl: crawlState, items: [...load().values()] }));
}

function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
  if (saveTimer.unref) saveTimer.unref();
}

// The name decides first ("Magic Carpet" is transport, whatever it shoots).
function gearKind(name, description) {
  for (const text of [name, description || '']) {
    for (const [kind, words] of GEAR_KINDS) if (words.test(text)) return kind;
  }
  return null;
}

// One item of Roblox's v2 catalog search -> its index entry (merged with what
// was known), or null for item types the 2017 client can't use.
function remember(raw) {
  if (!raw || typeof raw !== 'object' || !/^\d{1,15}$/.test(String(raw.id))) return null;
  const bundle = raw.itemType === 'Bundle';
  const type = bundle ? PACKAGE : Number(raw.assetType) || 0;
  if (!bundle && !KNOWN_TYPES.has(type)) return null;
  if (bundle && Number(raw.bundleType) && Number(raw.bundleType) !== 1) return null;
  const key = `${bundle ? 'b' : 'a'}${raw.id}`;
  const old = load().get(key) || {};
  const restrictions = Array.isArray(raw.itemRestrictions) ? raw.itemRestrictions.map(String) : [];
  const offSale = raw.priceStatus === 'Off Sale' || raw.isOffSale === true || !Number.isInteger(raw.price);
  const entry = Object.assign({}, old, {
    id: key,
    kind: bundle ? 'bundle' : 'asset',
    name: String(raw.name || old.name || '').trim().slice(0, 100),
    type,
    creator: String(raw.creatorName || old.creator || 'Roblox').slice(0, 60),
    creatorType: raw.creatorType === 'Group' ? 'Group' : 'User',
    roblox: Number(raw.creatorTargetId) === 1 && raw.creatorType !== 'Group',
    created: typeof raw.itemCreatedUtc === 'string' ? raw.itemCreatedUtc.slice(0, 10) : old.created || null,
    price: offSale ? null : raw.price,
    limited: restrictions.some((r) => /^limited/i.test(r)),
    collectible: restrictions.some((r) => /collectible/i.test(r)),
    resale: Number(raw.lowestResalePrice) || Number(raw.lowestPrice) || old.resale || 0,
    favorites: Number.isFinite(Number(raw.favoriteCount)) ? Number(raw.favoriteCount) : old.favorites || 0,
    seen: Date.now(),
  });
  if (type === 19) entry.gear = gearKind(entry.name, raw.description);
  if (!entry.name) return null;
  load().set(key, entry);
  saveSoon();
  return entry;
}

// An item looked up on Roblox elsewhere (lib/catalog.js itemInfo): fills in
// its last update and adds it if it wasn't known.
function rememberInfo(info) {
  if (!info || !/^\d{1,15}$/.test(String(info.id)) || !KNOWN_TYPES.has(Number(info.typeId))) return;
  const key = `a${info.id}`;
  const old = load().get(key);
  if (old && old.updated === info.updated) return;
  const entry = Object.assign({ favorites: 0 }, old || {}, {
    id: key, kind: 'asset', name: String(info.name || '').slice(0, 100), type: Number(info.typeId),
    creator: String(info.creator || 'Roblox').slice(0, 60),
    created: info.created ? String(info.created).slice(0, 10) : (old && old.created) || null,
    updated: info.updated ? String(info.updated).slice(0, 10) : null,
    price: info.robloxPrice !== undefined ? info.robloxPrice : info.price,
    limited: Boolean(info.limited), seen: Date.now(),
  });
  if (!old) entry.roblox = entry.creator === 'Roblox';
  if (entry.type === 19 && !entry.gear) entry.gear = gearKind(entry.name, info.description);
  if (!entry.name) return;
  load().set(key, entry);
  saveSoon();
}

// --- asking Roblox -----------------------------------------------------------------

const SEARCH_URL = 'https://catalog.roblox.com/v2/search/items/details';
const GAP_MS = 1500;
let queue = Promise.resolve();
let lastAt = 0;
let busyUntil = 0;

function ask(params) {
  const run = queue.then(async () => {
    if (Date.now() < busyUntil) return { busy: true };
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const response = await assets.httpRequest(`${SEARCH_URL}?${new URLSearchParams(params)}`, { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, 15000);
      if (response.status === 429) {
        busyUntil = Date.now() + 60 * 1000;
        return { busy: true };
      }
      if (response.status !== 200) return { error: response.status || response.error };
      return { data: JSON.parse(response.body.toString('utf8')) };
    } catch (error) {
      return { error: String(error && error.message || error) };
    } finally {
      lastAt = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

// Keyword and creator searches: asked of Roblox once per half hour, so a new
// search finds items the crawl hasn't reached.
const LIVE_TTL_MS = 30 * 60 * 1000;
const LIVE_WAIT_MS = 6000;
const liveAsked = new Map();

function liveSearch(keyword, creator, sub, era) {
  // Classic accessories and gear are nearly all Roblox's own; its newer
  // look-alikes would fill the plain answer.
  const own = era === 'classic' && !creator && !sub.limited && !sub.types.some((type) => CLOTHING.includes(type));
  if (own) {
    return Promise.all([liveSearch(keyword, 'Roblox', sub, 'any'), liveSearch(keyword, '', sub, 'any')]).then((done) => done.some(Boolean));
  }
  const types = sub.types.filter((type) => type !== PACKAGE);
  const params = { Limit: '120', SortType: '0', IncludeNotForSale: 'true' };
  if (keyword) params.Keyword = keyword.slice(0, 50);
  if (creator) params.CreatorName = creator.slice(0, 20);
  if (sub.types.includes(PACKAGE) && !types.length) params.bundleTypeIds = '1';
  else params.assetTypeIds = types.join(',');
  if (sub.limited) params.SalesTypeFilter = '2';
  const key = JSON.stringify(params);
  const known = liveAsked.get(key);
  if (known && known.at > Date.now() - LIVE_TTL_MS) return known.pending;
  const pending = ask(params).then((answer) => {
    if (!answer.data) {
      liveAsked.delete(key);
      return false;
    }
    for (const raw of Array.isArray(answer.data.data) ? answer.data.data : []) remember(raw);
    return true;
  });
  liveAsked.set(key, { at: Date.now(), pending });
  if (liveAsked.size > 2000) liveAsked.delete(liveAsked.keys().next().value);
  return pending;
}

// --- the crawl ---------------------------------------------------------------------

const CRAWL_GAP_MS = 8000;
const CRAWL_AGAIN_MS = 7 * 24 * 3600 * 1000;
const CRAWL_START_MS = 90 * 1000;
// Roblox ends every listing after about 1,000 items (9 pages of 120), so
// each kind of item is walked several ways: by favorites, sales and update,
// cheapest and dearest first, and in price bands.
const PAGES = 9;
const SORTS_BY = { favorites: '1', sales: '2', updated: '3', cheap: '4', dear: '5' };
const BANDS = [[0, 0], [1, 75], [76, 100], [101, 150], [151, 300], [301, 1000], [1001, 100000000]];
const JOBS = [];
function job(key, params, sort = 'favorites') {
  const p = Object.assign({ Limit: '120', SortType: SORTS_BY[sort] }, params);
  if (sort === 'favorites' || sort === 'sales') p.SortAggregation = '5';
  JOBS.push({ key: `${key}-${sort}`, pages: PAGES, params: p });
}
const ROBLOX = { CreatorName: 'Roblox' };
const ALL_SALES = Object.assign({ IncludeNotForSale: 'true' }, ROBLOX);
for (const sort of ['favorites', 'sales', 'updated']) job('roblox-hats-any', Object.assign({ assetTypeIds: '8' }, ALL_SALES), sort);
for (const [min, max] of BANDS) job(`roblox-hats-${min}`, Object.assign({ assetTypeIds: '8', MinPrice: String(min), MaxPrice: String(max) }, ROBLOX));
for (const sort of ['favorites', 'sales', 'updated', 'cheap', 'dear']) job('roblox-accessories', Object.assign({ assetTypeIds: '41,42,43,44,45,46,47' }, ALL_SALES), sort);
for (const sort of ['favorites', 'sales', 'updated', 'cheap', 'dear']) job('roblox-gear', Object.assign({ assetTypeIds: '19' }, ALL_SALES), sort);
for (const sort of ['favorites', 'sales']) job('roblox-packages', Object.assign({ bundleTypeIds: '1' }, ALL_SALES), sort);
for (const sort of ['favorites', 'sales', 'cheap', 'dear']) job('collectibles', { assetTypeIds: LIMITED_TYPES.join(','), SalesTypeFilter: '2', IncludeNotForSale: 'true' }, sort);
for (const [key, type] of [['shirts', '11'], ['t-shirts', '2'], ['pants', '12']]) {
  for (const sort of ['favorites', 'sales']) job(key, { assetTypeIds: type }, sort);
}
let crawling = false;

function crawlEnabled() {
  if (process.env.RBX_CATALOG_CRAWL === '0') return false;
  const config = core.readJsonFile(core.rootPath('config', 'server.json')) || {};
  return config.catalogCrawl !== false;
}

async function crawlOnce() {
  load();
  const job = JOBS.find((entry) => {
    const state = crawlState[entry.key];
    return !state || !state.doneAt || Date.now() - state.doneAt > CRAWL_AGAIN_MS;
  });
  if (!job) return false;
  const state = crawlState[job.key] && !crawlState[job.key].doneAt ? crawlState[job.key] : { pages: 0, cursor: '' };
  const params = Object.assign({}, job.params);
  if (state.cursor) params.Cursor = state.cursor;
  const answer = await ask(params);
  if (answer.busy) return true;
  if (!answer.data) {
    // A cursor Roblox no longer takes: start that list again next time.
    state.errors = (state.errors || 0) + 1;
    if (state.errors >= 3) Object.assign(state, { cursor: '', doneAt: Date.now() });
    crawlState[job.key] = state;
    saveSoon();
    return true;
  }
  for (const raw of Array.isArray(answer.data.data) ? answer.data.data : []) remember(raw);
  state.pages += 1;
  state.cursor = answer.data.nextPageCursor || '';
  state.errors = 0;
  if (!state.cursor || state.pages >= job.pages) {
    state.doneAt = Date.now();
    state.cursor = '';
    state.count = state.pages;
  }
  crawlState[job.key] = state;
  saveSoon();
  return true;
}

function crawlLater(delay) {
  const timer = setTimeout(async () => {
    if (!crawlEnabled()) return crawlLater(30 * 60 * 1000);
    crawling = true;
    let more = false;
    try {
      more = await crawlOnce();
    } catch (error) {
      more = true;
    }
    crawling = false;
    crawlLater(more ? CRAWL_GAP_MS : 6 * 3600 * 1000);
  }, delay);
  if (timer.unref) timer.unref();
}

let started = false;
function start() {
  if (started) return;
  started = true;
  crawlLater(CRAWL_START_MS);
}

// --- searching ---------------------------------------------------------------------

// Copies owned here, per item (data/ownership.json and the limiteds' stock),
// for "Bestselling"; counted at most every 10 minutes.
let soldCache = { at: 0, counts: new Map() };
function soldCounts() {
  if (Date.now() - soldCache.at < 10 * 60 * 1000) return soldCache.counts;
  const counts = new Map();
  const owned = core.readJsonFile(core.rootPath('Webserver', 'node', 'data', 'ownership.json')) || {};
  for (const user of Object.values(owned)) {
    if (!user || typeof user !== 'object') continue;
    for (const key of Object.keys(user)) {
      const id = /^\d+$/.test(key) ? `a${key}` : /^bundle:\d+$/.test(key) ? `b${key.slice(7)}` : null;
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  soldCache = { at: Date.now(), counts };
  return counts;
}

const words = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];

// How well an item matches the search words (0: not at all).
function relevance(entry, needle, tokens) {
  const name = entry.name.toLowerCase();
  const nameWords = words(entry.name);
  const creator = entry.creator.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (nameWords.includes(token)) score += 4;
    else if (nameWords.some((word) => word.startsWith(token))) score += 3;
    else if (name.includes(token)) score += 1;
    else if (creator.includes(token)) score += 1;
    else return 0;
  }
  if (name === needle) score += 12;
  else if (name.startsWith(needle)) score += 5;
  return score + Math.log10((entry.favorites || 0) + 1) * 0.6;
}

// What an item costs here now: { price, limitedInfo }.
function priceOf(entry, viewer) {
  if (entry.kind === 'bundle') return { price: entry.price, limitedInfo: null };
  if (entry.free) return { price: 0, limitedInfo: null };
  if (entry.collectible && !entry.limited) return { price: null, limitedInfo: null };
  const info = { id: entry.id.slice(1), typeId: entry.type, robloxPrice: entry.price, created: entry.created, limited: entry.limited };
  const priced = catalog.priced(info, viewer);
  return { price: priced.price, limitedInfo: priced.limitedInfo };
}

const classic = (entry) => Boolean(entry.created) && entry.created < (entry.kind === 'bundle' ? CLASSIC_BUNDLES_BEFORE : CLASSIC_BEFORE);
const int = (value, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// The search's own words, checked -> the options search() takes.
function options(query) {
  const q = query || {};
  const category = Object.prototype.hasOwnProperty.call(CATEGORIES, q.category) ? q.category : 'featured';
  const subs = CATEGORIES[category].subs;
  const sub = Object.prototype.hasOwnProperty.call(subs, q.sub) ? q.sub : 'all';
  const keyword = String(q.keyword || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  let creator = String(q.creator || '').trim().slice(0, 20);
  if (!/^[A-Za-z0-9_ ]*$/.test(creator)) creator = '';
  const min = int(q.min, 0, 10000000);
  const max = int(q.max, 0, 10000000);
  const sort = SORTS.has(q.sort) ? q.sort : (keyword ? 'relevance' : 'favorited');
  return {
    category, sub, keyword, creator, min, max, sort,
    free: q.free === '1' || q.free === 'true',
    era: q.era === 'any' ? 'any' : 'classic',
    unavailable: q.unavailable === 'show',
    page: int(q.page, 1, MAX_PAGE) || 1,
  };
}

// -> { items, total, page, pages, perPage }. viewer: the signed-in player's
// user ID (prices of limiteds they sell, and whether they own each item).
async function search(asked, viewer) {
  start();
  const o = options(asked);
  const category = CATEGORIES[o.category];
  const sub = Object.assign({}, category.subs[o.sub], { limited: category.limited });
  if (o.keyword || (o.creator && o.creator.toLowerCase() !== 'roblox')) {
    await Promise.race([liveSearch(o.keyword, o.creator, sub, o.era), new Promise((resolve) => setTimeout(resolve, LIVE_WAIT_MS))]);
  }
  const types = new Set(sub.types);
  const needle = o.keyword.toLowerCase();
  const tokens = words(o.keyword);
  const creator = o.creator.toLowerCase();
  const sold = o.sort === 'bestselling' ? soldCounts() : null;
  const found = [];
  for (const entry of load().values()) {
    if (!types.has(entry.type)) continue;
    if (category.roblox && !entry.roblox) continue;
    if (category.limited && !entry.limited) continue;
    if (sub.gear && entry.gear !== sub.gear) continue;
    if (o.era === 'classic' && !classic(entry) && !entry.free) continue;
    if (creator && entry.creator.toLowerCase() !== creator) continue;
    let score = 0;
    if (tokens.length) {
      score = relevance(entry, needle, tokens);
      if (!score) continue;
    }
    const { price, limitedInfo } = priceOf(entry, viewer);
    if (price === null || price === undefined) {
      if (!o.unavailable || o.free || o.min !== null || o.max !== null) continue;
    } else {
      if (o.free && price !== 0) continue;
      if (o.min !== null && price < o.min) continue;
      if (o.max !== null && price > o.max) continue;
    }
    found.push({ entry, price, limitedInfo, score });
  }
  const byFavorites = (a, b) => (b.entry.favorites || 0) - (a.entry.favorites || 0) || a.entry.name.localeCompare(b.entry.name);
  const priceKey = (x, dir) => (x.price === null || x.price === undefined ? Infinity : dir * x.price);
  const compare = {
    relevance: (a, b) => b.score - a.score || byFavorites(a, b),
    favorited: byFavorites,
    bestselling: (a, b) => (sold.get(b.entry.id) || 0) - (sold.get(a.entry.id) || 0) || byFavorites(a, b),
    updated: (a, b) => String(b.entry.updated || b.entry.created || '').localeCompare(String(a.entry.updated || a.entry.created || '')) || byFavorites(a, b),
    'price-asc': (a, b) => priceKey(a, 1) - priceKey(b, 1) || byFavorites(a, b),
    'price-desc': (a, b) => priceKey(a, -1) - priceKey(b, -1) || byFavorites(a, b),
  }[o.sort === 'relevance' && !tokens.length ? 'favorited' : o.sort];
  found.sort(compare);
  const pages = Math.max(1, Math.min(MAX_PAGE, Math.ceil(found.length / PER_PAGE)));
  const page = Math.min(o.page, pages);
  const shown = found.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const items = shown.map(({ entry, price, limitedInfo }) => {
    const id = entry.id.slice(1);
    let info = limitedInfo;
    // A classic limited seen for the first time gets its stock here (as in
    // the launcher's catalog), priced at Roblox's resale price.
    if (entry.limited && classic(entry) && entry.kind === 'asset' && !limiteds.tracked(id) && entry.resale > 0) {
      limiteds.ensure(id, { price: entry.resale, name: entry.name, typeId: entry.type });
      const again = priceOf(entry, viewer);
      price = again.price;
      info = again.limitedInfo;
    }
    const item = {
      id, kind: entry.kind, name: entry.name, typeId: entry.type,
      typeName: entry.kind === 'bundle' ? 'Package' : catalog.TYPE_NAMES[entry.type] || null,
      creator: entry.creator, creatorType: entry.creatorType || 'User',
      price: price === undefined ? null : price, limited: Boolean(entry.limited), limitedInfo: info || null,
      favorites: entry.favorites || 0, created: entry.created || null,
    };
    if (viewer) item.owned = entry.kind === 'bundle' ? ownership.ownsBundle(viewer, id) : catalog.owns(viewer, id);
    return item;
  });
  return { items, total: found.length, page, pages, perPage: PER_PAGE, sort: o.sort };
}

// How much of the catalog is indexed: { items, crawl: { job: pages } }.
function status() {
  const crawl = {};
  for (const job of JOBS) crawl[job.key] = crawlState && crawlState[job.key] ? crawlState[job.key] : null;
  return { items: load().size, crawling, crawl };
}

// The game server's route: [/^api\/catalog\/(search|status)\/?$/i, catalogsearch.route(sendJson)].
function route(sendJson) {
  return async (ctx, match) => {
    if (ctx.method !== 'GET') return sendJson(ctx, 405, { error: 'Use GET.' });
    if (match[1].toLowerCase() === 'status') return sendJson(ctx, 200, status());
    const who = accounts.fromRequest(ctx.req);
    return sendJson(ctx, 200, await search(ctx.queryLower, who ? who.userId : null));
  };
}

module.exports = { search, options, remember, rememberInfo, status, route, start, CATEGORIES };
