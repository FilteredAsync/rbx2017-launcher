// Shared by the site's Cloudflare Pages Functions (functions/).
//
// The site never sends visitors to the game server directly: the functions
// fetch the few read-only endpoints the pages need, keep only what the
// pages show, and cache the result at Cloudflare's edge. However many people
// open the site, each edge location asks the game server about once per
// cache period. Cache keys ignore query strings (except a thumbnail's
// version), so made-up URLs can't get around the cache.

export const DEFAULT_GAME_SERVER = 'https://rbx2017.com';
export const RELEASES = 'https://github.com/FilteredAsync/rbx2017-launcher/releases';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const STALE_SECONDS = 7 * 24 * 3600;

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// What public/_headers gives static pages, for pages a function serves.
export const PAGE_HEADERS = Object.assign({
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
}, SECURITY_HEADERS);

export function gameServer(env) {
  const value = env && typeof env.GAME_SERVER === 'string' ? env.GAME_SERVER.trim() : '';
  return (/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/.test(value) ? value : DEFAULT_GAME_SERVER).replace(/\/+$/, '');
}

export function json(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    }, SECURITY_HEADERS),
  });
}

// An answer to cache: { status, type, body, maxAge }.
function toResponse(item, extra) {
  return new Response(item.body, {
    status: item.status,
    headers: Object.assign({
      'Content-Type': item.type,
      'Cache-Control': `public, max-age=${item.maxAge}`,
    }, SECURITY_HEADERS, extra || {}),
  });
}

// Serves `key` from the edge cache, or runs `produce` and caches what it
// returns. While the game server is down, the last good answer (kept a week)
// is served instead, marked X-Stale.
export async function cached(context, key, produce, failure = 'The game server did not answer.') {
  const cache = globalThis.caches ? globalThis.caches.default : null;
  const base = new URL(context.request.url).origin;
  const freshKey = new Request(`${base}/__edge${key}`);
  const staleKey = new Request(`${base}/__edge-stale${key}`);
  if (cache) {
    const hit = await cache.match(freshKey);
    if (hit) return hit;
  }
  let item = null;
  let problem = '';
  try {
    item = await produce();
  } catch (error) {
    item = null;
    problem = String((error && error.message) || error).slice(0, 200);
  }
  if (item && item.status < 500) {
    const response = toResponse(item);
    if (cache) {
      const keep = [cache.put(freshKey, response.clone())];
      if (item.status === 200) {
        const body = item.body instanceof ArrayBuffer ? item.body.slice(0) : item.body;
        keep.push(cache.put(staleKey, toResponse(Object.assign({}, item, { body, maxAge: STALE_SECONDS }))));
      }
      context.waitUntil(Promise.all(keep).catch(() => {}));
    }
    return response;
  }
  if (cache) {
    const stale = await cache.match(staleKey);
    if (stale) {
      const copy = new Response(stale.body, stale);
      copy.headers.set('Cache-Control', 'no-store');
      copy.headers.set('X-Stale', '1');
      return copy;
    }
  }
  return json(problem ? { error: failure, detail: problem } : { error: failure }, 502);
}

async function upstream(url, timeoutMs = 8000, headers = {}) {
  return fetch(url, {
    headers: Object.assign({ 'User-Agent': 'rbx2017-site', Accept: '*/*' }, headers),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function upstreamJson(url) {
  const response = await upstream(url);
  if (response.status === 404) return { notFound: true };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { data: await response.json() };
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const id = (value) => (/^\d{1,20}$/.test(String(value)) ? String(value) : null);

// The game list without player names or anything the pages don't use.
export async function gameList(server) {
  const { data } = await upstreamJson(`${server}/api/launcher/games`);
  const games = (data && Array.isArray(data.games) ? data.games : []).filter((game) => game && id(game.placeId)).map((game) => ({
    placeId: String(game.placeId),
    name: text(game.name, 120) || `Place ${game.placeId}`,
    description: text(game.description, 4000),
    creator: text(game.creator, 80),
    thumbnail: Number.isFinite(game.thumbnail) ? game.thumbnail : null,
    maxPlayers: count(game.maxPlayers) || null,
    playing: count(game.playing),
    online: game.canStart !== false,
    servers: (Array.isArray(game.servers) ? game.servers : [])
      .filter((s) => s && /^[0-9a-f]{8,64}$/i.test(String(s.id)))
      .map((s) => ({ id: String(s.id), playing: count(s.playing), maxPlayers: count(s.maxPlayers) || count(game.maxPlayers) || null })),
  }));
  return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({ games }), maxAge: 30 };
}

function trimItems(items, withPrice) {
  if (!Array.isArray(items)) return null;
  return items.filter((item) => item && id(item.id)).slice(0, 100).map((item) => {
    const out = { id: String(item.id), name: text(item.name, 120), description: text(item.description, 1000), icon: id(item.icon) };
    if (withPrice) out.price = Number.isFinite(item.price) ? item.price : null;
    return out;
  });
}

// One game's votes, badges and passes. Badges and passes are null while the
// game server is still fetching them, so that answer is kept only briefly.
export async function gamePage(server, placeId) {
  const result = await upstreamJson(`${server}/api/launcher/game/${placeId}`);
  if (result.notFound) return { status: 404, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'No such game.' }), maxAge: 60 };
  const page = result.data || {};
  const votes = page.votes || {};
  const body = {
    placeId,
    votes: { up: count(votes.up), down: count(votes.down) },
    badges: trimItems(page.badges, false),
    passes: trimItems(page.passes, true),
  };
  const loading = body.badges === null || body.passes === null;
  return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(body), maxAge: loading ? 15 : 300 };
}

// Every game's votes in one answer, for the vote bars on game cards. Free
// Pages Functions may make 50 requests per call, so this covers 40 games.
export async function allVotes(server) {
  const { data } = await upstreamJson(`${server}/api/launcher/games`);
  const ids = (data && Array.isArray(data.games) ? data.games : [])
    .filter((game) => game && id(game.placeId))
    .sort((a, b) => count(b.playing) - count(a.playing))
    .slice(0, 40)
    .map((game) => String(game.placeId));
  const votes = {};
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const placeId = ids[next++];
      try {
        const result = await upstreamJson(`${server}/api/launcher/game/${placeId}`);
        const v = result.data && result.data.votes;
        if (v) votes[placeId] = { up: count(v.up), down: count(v.down) };
      } catch (error) { /* that game's card shows no bar */ }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({ votes }), maxAge: 600 };
}

function imageType(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

// An image from the game server, only if it really is one (checked by its
// first bytes, since asset replies come as binary/octet-stream).
export async function image(url, maxAge) {
  const response = await upstream(url);
  if (response.status === 404) return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found', maxAge: 300 };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const type = imageType(bytes);
  if (!type || !IMAGE_TYPES.includes(type) || bytes.byteLength > MAX_IMAGE_BYTES) {
    return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not an image', maxAge: 300 };
  }
  return { status: 200, type, body: bytes, maxAge };
}

// The newest launcher release: { version, file, size, date, url } for
// channel 'latest' (Windows 10 and 11) or 'win7' (Windows 7, 8 and 8.1).
// From the .yml electron-builder publishes, or else GitHub's API.
const SETUP_NAMES = {
  latest: /^RobloxClient-Setup-(\d+\.\d+\.\d+)\.exe$/,
  win7: /^RobloxClient-Setup-Win7-(\d+\.\d+\.\d+)\.exe$/,
};

async function releaseFromYml(channel) {
  // A new address every 10 minutes: Cloudflare kept serving a failed answer
  // for the plain one (latest.yml failed for hours while win7.yml worked).
  const response = await upstream(`${RELEASES}/latest/download/${channel}.yml?t=${Math.floor(Date.now() / 600000)}`, 10000);
  if (!response.ok) throw new Error(`${channel}.yml: HTTP ${response.status}`);
  const yml = await response.text();
  const field = (name) => {
    const match = new RegExp(`^${name}:\\s*'?([^'\\r\\n]+)'?\\s*$`, 'm').exec(yml);
    return match ? match[1].trim() : '';
  };
  const version = field('version');
  const file = field('path');
  const size = Number((/^\s+size:\s*(\d+)\s*$/m.exec(yml) || [])[1]) || null;
  const date = field('releaseDate');
  if (!/^\d+\.\d+\.\d+$/.test(version) || !SETUP_NAMES[channel].test(file)) throw new Error(`${channel}.yml did not look right`);
  return { version, file, size, date };
}

async function releaseFromApi(channel) {
  const repo = RELEASES.replace(/^https:\/\/github\.com\/|\/releases$/g, '');
  const response = await upstream(`https://api.github.com/repos/${repo}/releases/latest`, 10000, { Accept: 'application/vnd.github+json' });
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
  const data = await response.json();
  const asset = (Array.isArray(data.assets) ? data.assets : []).find((item) => item && SETUP_NAMES[channel].test(String(item.name)));
  if (!asset) throw new Error(`GitHub API: no ${channel} installer in the newest release`);
  return { version: SETUP_NAMES[channel].exec(asset.name)[1], file: asset.name, size: Number(asset.size) || null, date: data.published_at || '' };
}

export async function release(channel = 'latest') {
  if (!SETUP_NAMES[channel]) throw new Error('no such channel');
  const problems = [];
  for (const source of [releaseFromYml, releaseFromApi]) {
    try {
      const { version, file, size, date } = await source(channel);
      const body = { version, file, size, date: /^\d{4}-\d\d-\d\d/.test(date) ? date : null, url: `${RELEASES}/download/v${version}/${file}` };
      return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(body), maxAge: 600 };
    } catch (error) {
      problems.push(error.message);
    }
  }
  throw new Error(problems.join('; '));
}
