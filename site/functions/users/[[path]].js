// /users/<id>/inventory and /users/<id>/profile: a player's inventory
// (inventory.html) or profile (profile.html), which read the ID from the
// address; /users/friends: your friends and requests (friends.html).
// Anything else goes on to the static files.
import { PAGE_HEADERS } from '../../lib/edge.js';

async function serve(context, asset) {
  const page = await context.env.ASSETS.fetch(new URL(asset, context.request.url));
  const headers = new Headers(page.headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(page.body, { status: page.ok ? 200 : page.status, headers });
}

export async function onRequest(context) {
  const parts = [].concat(context.params.path || []).filter(Boolean);
  if (parts.length === 1 && parts[0] === 'friends') return serve(context, '/friends');
  if (parts.length !== 2 || !/^\d{1,15}$/.test(parts[0])) return context.next();
  if (parts[1] === 'inventory') return serve(context, '/inventory');
  if (parts[1] === 'profile') return serve(context, '/profile');
  return context.next();
}
