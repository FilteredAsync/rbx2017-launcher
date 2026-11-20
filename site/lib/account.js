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
const MAX_BODY = 4096;

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
  'front', 'back', 'waist', 'torsos', 'rightarms', 'leftarms', 'leftlegs', 'rightlegs', 'gear']);

const price = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function shopItem(item) {
  return {
    id: String(item.id), kind: item.kind === 'bundle' ? 'bundle' : 'asset', name: String(item.name || '').slice(0, 100),
    typeId: Number(item.typeId) || null, price: price(item.price), owned: typeof item.owned === 'boolean' ? item.owned : null,
    packageId: /^\d{1,12}$/.test(String(item.packageId || '')) ? String(item.packageId) : null,
    packageName: item.packageName ? String(item.packageName).slice(0, 100) : null, packagePrice: price(item.packagePrice),
  };
}

// GET /api/catalog?category=&keyword=&cursor=: with the session the items
// say whether you own them (never cached then); without it, shared for 5 minutes.
async function catalogList(context) {
  const query = new URL(context.request.url).searchParams;
  const category = query.get('category') || 'hats';
  if (!CATEGORY_KEYS.has(category) || category === 'gear') return reply({ error: 'Unknown category.' }, 400);
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
    limited: Boolean(data.limited), creator: String(data.creator || 'Roblox').slice(0, 60),
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

// Handles the account routes -> a Response, or null for other routes.
export async function accountRoute(context, route) {
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
