// /groups/<id>[/<name>]: a group's page (group.html), which reads the ID from
// the address. Anything else goes on to the static files (/groups is groups.html).
import { PAGE_HEADERS } from '../../lib/edge.js';

export async function onRequest(context) {
  const parts = [].concat(context.params.path || []).filter(Boolean);
  if (!/^\d{1,15}$/.test(parts[0] || '') || parts.length > 2) return context.next();
  const page = await context.env.ASSETS.fetch(new URL('/group', context.request.url));
  const headers = new Headers(page.headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=300');
  return new Response(page.body, { status: page.ok ? 200 : page.status, headers });
}
