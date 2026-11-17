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

// Handles the account routes -> a Response, or null for other routes.
export async function accountRoute(context, route) {
  if (route === 'login') return signIn(context, 'signin');
  if (route === 'signup') return signIn(context, 'signup');
  if (route === 'logout') return signOut(context);
  if (route === 'me' || route === 'friends') {
    if (context.request.method !== 'GET') return reply({ error: 'Use GET.' }, 405);
    return route === 'me' ? me(context) : friends(context);
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
