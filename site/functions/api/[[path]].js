// /api/* for the site's pages: read-only, trimmed and edge-cached copies of
// the game server's public endpoints (lib/edge.js).
//   /api/games              the game list
//   /api/votes              every game's votes (game card bars)
//   /api/game/<placeId>     votes, badges and passes
//   /api/thumb/<placeId>?v= the game's thumbnail (v = its version)
//   /api/icon/<placeId>/<iconId>  a badge or pass icon of that game
//   /api/release            the newest launcher release
// Game, thumbnail and icon IDs are checked against the cached game list and
// game page first, so made-up IDs never reach the game server.
// Signing in and the signed-in pages' data: lib/account.js.
import { cached, gameServer, json, gameList, allVotes, gamePage, image, release } from '../../lib/edge.js';
import { accountRoute } from '../../lib/account.js';

const WEEK = 7 * 24 * 3600;

async function cachedJson(response) {
  if (!response.ok) return null;
  try { return await response.json(); } catch (error) { return null; }
}

// The game's entry in the list; `known` is false only when the list came
// back and doesn't have it.
async function listed(context, server, placeId) {
  const data = await cachedJson(await cached(context, '/games', () => gameList(server)));
  if (!data || !Array.isArray(data.games)) return { known: true, game: null };
  const game = data.games.find((entry) => entry.placeId === placeId) || null;
  return { known: Boolean(game), game };
}

function gamePageCached(context, server, placeId) {
  return cached(context, `/game/${placeId}`, () => gamePage(server, placeId));
}

export async function onRequest(context) {
  const { request, env } = context;
  const route = [].concat(context.params.path || []).join('/');
  const account = await accountRoute(context, route);
  if (account) return account;
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Use GET.' }, 405);
  const server = gameServer(env);
  let match;
  if (route === 'games') return cached(context, '/games', () => gameList(server));
  if (route === 'votes') return cached(context, '/votes', () => allVotes(server));
  if (route === 'release') return cached(context, '/release', () => release(), 'GitHub did not answer.');

  if ((match = /^game\/(\d{1,15})$/.exec(route))) {
    const placeId = match[1];
    if (!(await listed(context, server, placeId)).known) return json({ error: 'No such game.' }, 404, 60);
    return gamePageCached(context, server, placeId);
  }

  if ((match = /^thumb\/(\d{1,15})$/.exec(route))) {
    const placeId = match[1];
    const { known, game } = await listed(context, server, placeId);
    if (!known) return json({ error: 'No such game.' }, 404, 60);
    // Only the current version gets the long cache; any other v shares the
    // short-lived unversioned copy.
    const asked = new URL(request.url).searchParams.get('v') || '';
    const version = game && game.thumbnail !== null && String(game.thumbnail) === asked ? asked : '';
    return cached(context, `/thumb/${placeId}${version ? `?v=${version}` : ''}`,
      () => image(`${server}/api/thumbnails/${placeId}`, version ? WEEK : 300));
  }

  if ((match = /^icon\/(\d{1,15})\/(\d{1,20})$/.exec(route))) {
    const [, placeId, iconId] = match;
    if (!(await listed(context, server, placeId)).known) return json({ error: 'No such game.' }, 404, 60);
    const page = await cachedJson(await gamePageCached(context, server, placeId));
    const items = page ? [].concat(page.badges || [], page.passes || []) : [];
    if (!items.some((item) => item && item.icon === iconId)) return json({ error: 'No such icon.' }, 404, 300);
    return cached(context, `/icon/${placeId}/${iconId}`, () => image(`${server}/asset/?id=${iconId}`, WEEK));
  }

  return json({ error: 'Not found.' }, 404);
}
