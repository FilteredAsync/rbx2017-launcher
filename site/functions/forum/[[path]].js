// /forum/<forumId> and /forum/thread/<id>: the forum page (forum.html), which
// reads the address. Anything else goes on to the static files (/forum itself is forum.html).
import { PAGE_HEADERS } from '../../lib/edge.js';

export async function onRequest(context) {
  const parts = [].concat(context.params.path || []).filter(Boolean);
  const ok = (parts.length === 1 && /^\d{1,3}$/.test(parts[0])) || (parts.length === 2 && parts[0] === 'thread' && /^\d{1,12}$/.test(parts[1]));
  if (!ok) return context.next();
  const page = await context.env.ASSETS.fetch(new URL('/forum', context.request.url));
  const headers = new Headers(page.headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(page.body, { status: page.ok ? 200 : page.status, headers });
}
