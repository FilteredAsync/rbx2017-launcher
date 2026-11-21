// Signing in on the website, and what the signed-in pages show. Accounts
// live on the game server (the launcher's accounts), so these pass each
// request on with the visitor's session and send back only what the pages
// use. Nothing here is cached at the edge except avatar pictures: each
// visitor's answers are their own.
//
//   POST /api/login   {name, password}             -> {account}  (sets the session cookie)
//   POST /api/signup  {name, password, turnstile?} -> {account}
//   POST /api/logout
//   GET  /api/me        -> {account|null, robux|null, turnstile: site key|null}
//   GET  /api/friends   -> {friends: [{userId, name, presence, placeId, gameName, gameId}], requests}
//   GET  /api/avatar/<userId>   an account's avatar picture (cached 5 minutes)
//   GET  /api/friends/all       friends, requests to you and from you
//   POST /api/friends/<request|accept|decline|cancel|remove>  {userId} or {name}
//   GET  /api/people?search=    players; GET /api/profile/<userId> a profile
//   GET|POST /api/groups...     groups (pages public; POST groups/<id>/emblem takes PNG/JPG bytes)
//   GET  /api/group-emblem/<id>?v=  a group's picture (cached at the edge)
//   GET|POST /api/membership..., /api/limiteds..., /api/trades...   Builders Club, limiteds, trades
//   GET|POST /api/forum...      the forums (reading needs no sign-in)
//   GET|POST /api/talk/<counts|chat...|messages...>  chat and private messages
//                               (the game server's lib/talkapi.js, passed on as is)
//
// The session is the game server's own token, in an HttpOnly cookie page
// scripts can't read. The game server limits wrong passwords per address;
// these requests all come from Cloudflare, so each carries the visitor's
// address, signed with the website key (env SITE_KEY, from /manage's Server
// page; the game server's lib/sitekey.js). Sign-ups pass Cloudflare
// Turnstile first when TURNSTILE_SITE_KEY and TURNSTILE_SECRET are set.
import { cached, gameServer, image, json, SECURITY_HEADERS } from './edge.js';

const COOKIE = '__Host-rbx2017';
const MAX_AGE = 30 * 24 * 3600;
// Forum posts are up to 4000 characters.
const MAX_BODY = 16 * 1024;

function sessionOf(request) {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(request.headers.get('Cookie') || '');
  return match ? match[1] : null;
}

const sessionCookie = (token) => `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
const clearedCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// A private answer (never cached), optionally setting or clearing the cookie.
function reply(data, status = 200, cookie = null) {
  const headers = new Headers(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' }, SECURITY_HEADERS));
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

// Changes only from this site's own pages (SameSite=Lax already keeps other
// sites' forms from carrying the cookie).
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

async function readBody(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch (error) {
    return null;
  }
}

// -> { status, data }; status 502 when the game server can't be reached.
async function ask(context, method, route, { token = null, body = null } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'rbx2017-site' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const visitor = context.request.headers.get('CF-Connecting-IP');
  if (context.env.SITE_KEY && visitor) {
    headers['X-Rbx-Site-Key'] = context.env.SITE_KEY;
    headers['X-Rbx-Client-Ip'] = visitor;
  }
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(`${gameServer(context.env)}/api/launcher/${route}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    return { status: response.status, data: data || {} };
  } catch (error) {
    return { status: 502, data: { error: 'The game server did not answer. Try again in a minute.' } };
  }
}

const accountOf = (data) => (data && data.account ? { name: String(data.account.name), userId: Number(data.account.userId), admin: Boolean(data.account.admin) } : null);

async function turnstileOk(context, token) {
  const { TURNSTILE_SECRET } = context.env;
  if (!TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', TURNSTILE_SECRET);
  form.append('response', token);
  const visitor = context.request.headers.get('CF-Connecting-IP');
  if (visitor) form.append('remoteip', visitor);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    const result = await response.json();
    return Boolean(result && result.success);
  } catch (error) {
    return false;
  }
}

async function signIn(context, mode) {
  const { request } = context;
  if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Sign in from this site.' }, 403);
  const body = await readBody(request);
  if (!body) return reply({ error: 'Type a username and password.' }, 400);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (mode === 'signup' && !(await turnstileOk(context, body.turnstile))) {
    return reply({ error: "We couldn't check you're human. Try the check again." }, 400);
  }
  const result = await ask(context, 'POST', 'login', { body: { name, password, mode: mode === 'signup' ? 'signup' : 'signin' } });
  if (result.status !== 200 || !result.data.token || !/^[0-9a-f]{64}$/.test(result.data.token)) {
    return reply({ error: result.data.error || 'That did not work. Try again.' }, result.status === 200 ? 502 : result.status);
  }
  return reply({ account: accountOf(result.data), created: Boolean(result.data.created) }, 200, sessionCookie(result.data.token));
}

async function signOut(context) {
  const { request } = context;
  if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Sign out from this site.' }, 403);
  const token = sessionOf(request);
  if (token) await ask(context, 'POST', 'logout', { token });
  return reply({ ok: true }, 200, clearedCookie());
}

function robuxOf(data) {
  if (!data || !Number.isFinite(data.balance)) return null;
  const earn = data.earn || {};
  const num = (value) => (Number.isFinite(value) ? value : 0);
  return {
    balance: data.balance,
    earn: {
      daily: num(earn.daily), dailyDone: Boolean(earn.dailyDone), playAmount: num(earn.playAmount), playEvery: num(earn.playEvery),
      playToday: num(earn.playToday), playMax: num(earn.playMax), badge: num(earn.badge),
    },
    history: (Array.isArray(data.history) ? data.history : []).slice(0, 10).map((entry) => ({
      at: String(entry.at || ''), amount: num(entry.amount), reason: String(entry.reason || '').slice(0, 80),
    })),
  };
}

async function me(context) {
  const turnstile = context.env.TURNSTILE_SITE_KEY && context.env.TURNSTILE_SECRET ? String(context.env.TURNSTILE_SITE_KEY) : null;
  const token = sessionOf(context.request);
  if (!token) return reply({ account: null, robux: null, turnstile });
  // The Robux look also gives the day's bonus (the game server's lib/robux.js).
  const [who, robux] = await Promise.all([ask(context, 'GET', 'me', { token }), ask(context, 'GET', 'robux', { token })]);
  if (who.status === 401) return reply({ account: null, robux: null, turnstile }, 200, clearedCookie());
  if (who.status !== 200) return reply({ error: who.data.error || 'The game server did not answer.', turnstile }, who.status === 502 ? 502 : 503);
  return reply({ account: accountOf(who.data), robux: robux.status === 200 ? robuxOf(robux.data) : null, turnstile });
}

async function friends(context) {
  const token = sessionOf(context.request);
  if (!token) return reply({ error: 'Sign in first.' }, 401);
  const result = await ask(context, 'GET', 'friends', { token });
  if (result.status === 401) return reply({ error: 'Sign in first.' }, 401, clearedCookie());
  if (result.status !== 200) return reply({ error: result.data.error || 'The game server did not answer.' }, 502);
  const list = Array.isArray(result.data.friends) ? result.data.friends : [];
  return reply({
    friends: list.slice(0, 200).map((friend) => {
      const online = friend.online && typeof friend.online === 'object' ? friend.online : null;
      return {
        userId: Number(friend.userId), name: String(friend.name || ''),
        presence: ['game', 'studio', 'online'].includes(friend.presence) ? friend.presence : 'offline',
        placeId: online && /^\d{1,15}$/.test(String(online.placeId)) ? String(online.placeId) : null,
        gameName: online ? String(online.gameName || '').slice(0, 120) : (friend.gameName ? String(friend.gameName).slice(0, 120) : null),
        // Friends in a private server can't be joined from a link.
        gameId: online && !online.privateServer && /^[0-9a-f]{8,64}$/i.test(String(online.gameId)) ? String(online.gameId) : null,
      };
    }),
    requests: Array.isArray(result.data.incoming) ? result.data.incoming.length : 0,
  });
}

// ---- the catalog, inventories and account settings (game server lib/catalog.js) ----

const CATEGORY_KEYS = new Set(['hats', 'hair', 'faces', 'heads', 'shirts', 'pants', 'tshirts', 'packages', 'face', 'neck', 'shoulder',
  'front', 'back', 'waist', 'torsos', 'rightarms', 'leftarms', 'leftlegs', 'rightlegs', 'gear', 'limiteds']);

const price = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function shopItem(item) {
  return {
    id: String(item.id), kind: item.kind === 'bundle' ? 'bundle' : 'asset', name: String(item.name || '').slice(0, 100),
    typeId: Number(item.typeId) || null, price: price(item.price), owned: typeof item.owned === 'boolean' ? item.owned : null,
    packageId: /^\d{1,12}$/.test(String(item.packageId || '')) ? String(item.packageId) : null,
    packageName: item.packageName ? String(item.packageName).slice(0, 100) : null, packagePrice: price(item.packagePrice),
    limited: Boolean(item.limited), limitedInfo: limitedInfo(item.limitedInfo),
  };
}

// A limited's stock here: { remaining, stock, rap, from } (lib/limiteds.js on the game server).
function limitedInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const n = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
  return { remaining: n(info.remaining), stock: n(info.stock), rap: n(info.rap), from: info.from === 'stock' || info.from === 'resale' ? info.from : null };
}

// GET /api/catalog?category=&keyword=&cursor=: with the session the items
// say whether you own them (never cached then); without it, shared for 5 minutes.
async function catalogList(context) {
  const query = new URL(context.request.url).searchParams;
  const category = query.get('category') || 'hats';
  if (!CATEGORY_KEYS.has(category)) return reply({ error: 'Unknown category.' }, 400);
  const keyword = (query.get('keyword') || '').trim().slice(0, 50);
  const cursor = (query.get('cursor') || '').slice(0, 500);
  const asked = new URLSearchParams({ category });
  if (keyword) asked.set('keyword', keyword);
  if (cursor) asked.set('cursor', cursor);
  const token = sessionOf(context.request);
  const produce = async () => {
    const result = await ask(context, 'GET', `catalog?${asked}`, { token });
    if (result.status !== 200) return { status: result.status, data: { error: result.data.error || 'The catalog did not answer. Try again in a minute.' } };
    const items = Array.isArray(result.data.items) ? result.data.items.slice(0, 60).map(shopItem) : [];
    return { status: 200, data: { items, nextCursor: typeof result.data.nextCursor === 'string' ? result.data.nextCursor : null } };
  };
  if (token) {
    const out = await produce();
    return reply(out.data, out.status);
  }
  return cached(context, `/catalog?${asked}`, async () => {
    const out = await produce();
    return { status: out.status, type: 'application/json; charset=utf-8', body: JSON.stringify(out.data), maxAge: 300 };
  });
}

// GET /api/item/<id>: an item's page.
async function itemPage(context, id) {
  const token = sessionOf(context.request);
  const result = await ask(context, 'GET', `item-info/${id}`, { token });
  if (result.status !== 200) return reply({ error: result.data.error || 'Could not look this item up.' }, result.status === 404 ? 404 : 502);
  const data = result.data;
  return reply({
    id: String(data.id), name: String(data.name || '').slice(0, 100), description: String(data.description || '').slice(0, 1000),
    typeId: Number(data.typeId) || null, typeName: data.typeName ? String(data.typeName) : null, price: price(data.price),
    limited: Boolean(data.limited), limitedInfo: limitedInfo(data.limitedInfo), classic: Boolean(data.classic),
    creator: String(data.creator || 'Roblox').slice(0, 60),
    created: data.created ? String(data.created).slice(0, 40) : null, updated: data.updated ? String(data.updated).slice(0, 40) : null,
    owned: typeof data.owned === 'boolean' ? data.owned : null, balance: Number.isFinite(data.balance) ? data.balance : null,
  });
}

// POST /api/buy {kind, id, price}
async function buy(context) {
  const { request } = context;
  if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Buy from this site.' }, 403);
  const token = sessionOf(request);
  if (!token) return reply({ error: 'Log in to buy items.' }, 401);
  const body = await readBody(request);
  if (!body || !/^\d{1,15}$/.test(String(body.id || ''))) return reply({ error: 'No such item.' }, 400);
  const result = await ask(context, 'POST', 'buy', {
    token, body: { kind: body.kind === 'bundle' ? 'bundle' : 'asset', id: String(body.id), price: price(body.price) },
  });
  if (result.status === 401) return reply({ error: 'Log in to buy items.' }, 401, clearedCookie());
  if (result.status !== 200) return reply({ error: result.data.error || 'That did not work. Try again.', price: price(result.data.price) }, result.status >= 500 ? 502 : result.status);
  return reply({ ok: true, balance: Number.isFinite(result.data.balance) ? result.data.balance : null });
}

// GET /api/inventory/<userId>?category=: public, like 2017 profiles.
async function inventoryPage(context, userId) {
  const category = new URL(context.request.url).searchParams.get('category') || 'hats';
  if (!CATEGORY_KEYS.has(category)) return json({ error: 'Unknown category.' }, 400);
  return cached(context, `/inventory/${userId}?category=${category}`, async () => {
    const result = await ask(context, 'GET', `inventory?userId=${userId}&category=${encodeURIComponent(category)}`);
    if (result.status !== 200) return { status: result.status === 404 ? 404 : 502, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: result.data.error || 'Could not load this inventory.' }), maxAge: 60 };
    const data = result.data;
    const body = {
      userId: Number(data.userId), name: String(data.name || ''), category,
      items: (Array.isArray(data.items) ? data.items : []).slice(0, 300).map((item) => ({
        id: String(item.id), kind: item.kind === 'bundle' ? 'bundle' : 'asset', name: String(item.name || '').slice(0, 100), typeName: item.typeName ? String(item.typeName) : null,
      })),
    };
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(body), maxAge: 60 };
  });
}

// POST /api/password {current, password}
async function password(context) {
  const { request } = context;
  if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'Change it from this site.' }, 403);
  const token = sessionOf(request);
  if (!token) return reply({ error: 'Log in first.' }, 401);
  const body = await readBody(request);
  if (!body) return reply({ error: 'Type both passwords.' }, 400);
  const result = await ask(context, 'POST', 'account/password', {
    token, body: { current: typeof body.current === 'string' ? body.current : '', password: typeof body.password === 'string' ? body.password : '' },
  });
  if (result.status !== 200) return reply({ error: result.data.error || 'That did not work. Try again.' }, result.status >= 500 ? 502 : result.status);
  return reply({ ok: true });
}

// ---- friends, people, chat and messages (the visitor's own data, passed on) ----

const TALK_ROUTE = /^(?:counts|chat|chat\/(?:start|group)|chat\/\d{1,12}(?:\/(?:send|read|typing|add|remove|leave|rename))?|messages|messages\/\d{1,12}(?:\/(?:read|archive))?)$/;
const QUERY_KEYS = new Set(['after', 'before', 'folder', 'page', 'search', 'role', 'kind']);

function queryOf(request) {
  const params = new URL(request.url).searchParams;
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    const ok = key === 'search' ? /^[0-9A-Za-z_ '.&!-]{0,50}$/.test(value) : /^[0-9A-Za-z_]{0,20}$/.test(value);
    if (QUERY_KEYS.has(key) && ok) kept.set(key, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : '';
}

async function passOn(context, method, route, { needsSession = true } = {}) {
  const { request } = context;
  if (request.method !== method) return reply({ error: `Use ${method}.` }, 405);
  if (method === 'POST' && !sameOrigin(request)) return reply({ error: 'Do this from this site.' }, 403);
  const token = sessionOf(request);
  if (!token && needsSession) return reply({ error: 'Log in first.' }, 401);
  let body = null;
  if (method === 'POST') {
    body = await readBody(request);
    if (!body) return reply({ error: 'That was too long.' }, 400);
  }
  const result = await ask(context, method, `${route}${method === 'GET' ? queryOf(request) : ''}`, { token, body });
  if (result.status === 401) return reply({ error: 'Log in first.' }, 401, token ? clearedCookie() : null);
  if (result.status === 404 && /unknown launcher request/i.test(String(result.data.error || ''))) {
    return reply({ error: "The game server doesn't have this yet." }, 404);
  }
  return reply(result.data, result.status >= 500 ? 502 : result.status);
}

const ECONOMY_ROUTE = /^(?:membership(?:\/buy|\/renew)?|limiteds\/(?:of|item)\/\d{1,15}|limiteds\/\d{1,12}\/sell|trades|trades\/\d{1,12}(?:\/(?:accept|decline))?)$/;
const FORUM_ROUTE = /^forum(?:\/\d{1,3}(?:\/threads)?|\/thread\/\d{1,12}(?:\/(?:reply|moderate|delete))?|\/post\/\d{1,12}\/(?:edit|delete|report))?$/;
const GROUP_ROUTE = /^groups(?:\/mine|\/of\/\d{1,15}|\/\d{1,15}(?:\/(?:members|wall|requests|join|leave|settings|roles|transfer|emblem|emblem\/remove|shout|delete|requests\/\d{1,15}\/(?:accept|decline)|members\/\d{1,15}\/(?:rank|kick)|wall\/\d{1,12}\/delete))?)?$/;
const MAX_EMBLEM = 1024 * 1024;

// A group picture: PNG or JPG bytes, passed on as they are.
async function groupEmblemUpload(context, route) {
  const { request } = context;
  if (!sameOrigin(request)) return reply({ error: 'Do this from this site.' }, 403);
  const token = sessionOf(request);
  if (!token) return reply({ error: 'Log in first.' }, 401);
  const type = String(request.headers.get('Content-Type') || '');
  if (!/^image\/(?:png|jpeg)$/i.test(type)) return reply({ error: 'Use a PNG or JPG picture.' }, 415);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_EMBLEM) return reply({ error: 'Pictures can be up to 1 MB.' }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_EMBLEM) return reply({ error: 'Pictures can be up to 1 MB.' }, 413);
  const headers = { Accept: 'application/json', 'User-Agent': 'rbx2017-site', Authorization: `Bearer ${token}`, 'Content-Type': type };
  const visitor = request.headers.get('CF-Connecting-IP');
  if (context.env.SITE_KEY && visitor) {
    headers['X-Rbx-Site-Key'] = context.env.SITE_KEY;
    headers['X-Rbx-Client-Ip'] = visitor;
  }
  try {
    const response = await fetch(`${gameServer(context.env)}/api/launcher/${route}`, { method: 'POST', headers, body: bytes, signal: AbortSignal.timeout(20000) });
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    return reply(data, response.status >= 500 ? 502 : response.status);
  } catch (error) {
    return reply({ error: 'The game server did not answer. Try again in a minute.' }, 502);
  }
}

function socialRoute(context, route) {
  const method = context.request.method === 'POST' ? 'POST' : 'GET';
  if (route === 'friends/all') return passOn(context, 'GET', 'friends');
  let match;
  if ((match = /^friends\/(request|accept|decline|cancel|remove)$/.exec(route))) return passOn(context, 'POST', `friends/${match[1]}`);
  if (route === 'people') return passOn(context, 'GET', 'people', { needsSession: false });
  // The forums: reading is open, posting needs the session (lib/forumapi.js on the game server).
  if (FORUM_ROUTE.test(route)) return passOn(context, method, route, { needsSession: method === 'POST' });
  // Builders Club, limiteds and trades (lib/economyapi.js on the game server).
  if (ECONOMY_ROUTE.test(route)) {
    const open = method === 'GET' && /^limiteds\/(?:of|item)\//.test(route);
    return passOn(context, method, route, { needsSession: !open });
  }
  // Groups: pages are public, changes need the session (lib/groupapi.js on the game server).
  if (GROUP_ROUTE.test(route)) {
    if (method === 'POST' && /^groups\/\d{1,15}\/emblem$/.test(route)) return groupEmblemUpload(context, route);
    return passOn(context, method, route, { needsSession: method === 'POST' || route === 'groups/mine' });
  }
  if ((match = /^group-emblem\/(\d{1,15})$/.exec(route))) {
    if (method !== 'GET') return reply({ error: 'Use GET.' }, 405);
    const version = (new URL(context.request.url).searchParams.get('v') || '').replace(/[^0-9a-z]/g, '').slice(0, 16);
    return cached(context, `/group-emblem/${match[1]}?v=${version}`, () => image(`${gameServer(context.env)}/group-thumbnail/image?groupId=${match[1]}`, version ? 7 * 24 * 3600 : 300));
  }
  if ((match = /^profile\/(\d{1,15})$/.exec(route))) return passOn(context, 'GET', `profile/${match[1]}`, { needsSession: false });
  if ((match = /^talk\/(.+)$/.exec(route)) && TALK_ROUTE.test(match[1])) return passOn(context, method, match[1]);
  return null;
}

// Handles the account routes -> a Response, or null for other routes.
export async function accountRoute(context, route) {
  const social = socialRoute(context, route);
  if (social) return social;
  if (route === 'login') return signIn(context, 'signin');
  if (route === 'signup') return signIn(context, 'signup');
  if (route === 'logout') return signOut(context);
  if (route === 'me' || route === 'friends') {
    if (context.request.method !== 'GET') return reply({ error: 'Use GET.' }, 405);
    return route === 'me' ? me(context) : friends(context);
  }
  if (route === 'catalog') {
    if (context.request.method !== 'GET') return reply({ error: 'Use GET.' }, 405);
    return catalogList(context);
  }
  if (route === 'buy') return buy(context);
  if (route === 'password') return password(context);
  let shop;
  if ((shop = /^item\/(\d{1,15})$/.exec(route))) {
    if (context.request.method !== 'GET') return reply({ error: 'Use GET.' }, 405);
    return itemPage(context, shop[1]);
  }
  if ((shop = /^inventory\/(\d{1,15})$/.exec(route))) {
    if (context.request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    return inventoryPage(context, shop[1]);
  }
  // Item pictures (the site only shows its own images): cached for a week.
  if ((shop = /^(asset|bundle)-thumb\/(\d{1,15})$/.exec(route))) {
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') return json({ error: 'Use GET.' }, 405);
    const [, kind, id] = shop;
    const path = kind === 'asset' ? `asset-thumbnail/image?assetId=${id}&width=420&height=420` : `bundle-thumbnail/image?bundleId=${id}&width=420&height=420`;
    return cached(context, `/${kind}-thumb/${id}`, () => image(`${gameServer(context.env)}/${path}`, 7 * 24 * 3600));
  }
  const match = /^avatar\/(\d{1,15})$/.exec(route);
  if (match) {
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') return json({ error: 'Use GET.' }, 405);
    // Only for signed-in pages, so crawlers don't walk made-up IDs.
    if (!sessionOf(context.request)) return json({ error: 'Sign in first.' }, 401);
    return cached(context, `/avatar/${match[1]}`, () => image(`${gameServer(context.env)}/api/launcher/picture/${match[1]}`, 300));
  }
  return null;
}
