// /download/latest: straight to the newest launcher installer on GitHub, or
// to the releases page if GitHub's latest.yml can't be read.
import { cached, release, RELEASES } from '../../lib/edge.js';

export async function onRequest(context) {
  let target = `${RELEASES}/latest`;
  try {
    const response = await cached(context, '/release', () => release(), 'GitHub did not answer.');
    if (response.ok) {
      const info = await response.json();
      if (info && typeof info.url === 'string' && info.url.startsWith(`${RELEASES}/download/`)) target = info.url;
    }
  } catch (error) { /* the releases page */ }
  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
}
