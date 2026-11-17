// /games/<placeId> and /games/<placeId>/<name>: the game page (game.html),
// which reads the ID from the address. Anything else under /games goes on to
// the static files (and their 404 page).
import { PAGE_HEADERS } from '../../lib/edge.js';

export async function onRequest(context) {
  const parts = [].concat(context.params.path || []).filter(Boolean);
  if (!/^\d{1,15}$/.test(parts[0] || '') || parts.length > 2) return context.next();
  const page = await context.env.ASSETS.fetch(new URL('/game', context.request.url));
  const headers = new Headers(page.headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(page.body, { status: page.ok ? 200 : page.status, headers });
}
