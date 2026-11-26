// The catalog's search (GET /api/catalog/search): the game server's 2017-style
// catalog search (Webserver/node/lib/catalogsearch.js), passed on with only
// the options it knows. Signed out, answers are shared and kept at the edge
// for 5 minutes; signed in, each item also says whether you own it, so those
// answers are your own and never kept.
import { cached } from './edge.js';
import { ask, reply, sessionOf } from './account.js';

const PICK = {
  category: /^[a-z]{1,20}$/, sub: /^[a-z]{1,20}$/, creator: /^[A-Za-z0-9_ ]{1,20}$/, min: /^\d{1,8}$/, max: /^\d{1,8}$/,
  free: /^1$/, sort: /^[a-z-]{1,12}$/, era: /^any$/, unavailable: /^show$/, page: /^\d{1,3}$/,
};

const price = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

function item(raw) {
  const info = raw.limitedInfo && typeof raw.limitedInfo === 'object' ? raw.limitedInfo : null;
  return {
    id: String(raw.id), kind: raw.kind === 'bundle' ? 'bundle' : 'asset', name: String(raw.name || '').slice(0, 100),
    typeId: Number(raw.typeId) || null, typeName: raw.typeName ? String(raw.typeName).slice(0, 40) : null,
    creator: String(raw.creator || '').slice(0, 60), price: price(raw.price), limited: Boolean(raw.limited),
    limitedInfo: info ? { remaining: count(info.remaining), stock: count(info.stock), rap: count(info.rap), from: info.from === 'stock' || info.from === 'resale' ? info.from : null } : null,
    owned: typeof raw.owned === 'boolean' ? raw.owned : null,
  };
}

export async function catalogRoute(context, route) {
  if (route !== 'catalog/search') return null;
  if (context.request.method !== 'GET') return reply({ error: 'Use GET.' }, 405);
  const asked = new URL(context.request.url).searchParams;
  const query = new URLSearchParams();
  const keyword = (asked.get('keyword') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  for (const [key, rule] of Object.entries(PICK)) {
    const value = (asked.get(key) || '').trim();
    if (rule.test(value)) query.set(key, value);
  }
  if (keyword) query.set('keyword', keyword);
  query.sort();
  const token = sessionOf(context.request);
  const produce = async () => {
    const result = await ask(context, 'GET', `/api/catalog/search?${query}`, { token });
    if (result.status !== 200) return { status: result.status >= 500 ? 502 : result.status, data: { error: result.data.error || 'The catalog did not answer. Try again in a minute.' } };
    const data = result.data;
    return {
      status: 200,
      data: {
        items: (Array.isArray(data.items) ? data.items : []).slice(0, 60).map(item),
        total: count(data.total) || 0, page: count(data.page) || 1, pages: count(data.pages) || 1, perPage: count(data.perPage) || 30,
      },
    };
  };
  if (token) {
    const out = await produce();
    return reply(out.data, out.status);
  }
  return cached(context, `/catalog/search?${query}`, async () => {
    const out = await produce();
    return { status: out.status, type: 'application/json; charset=utf-8', body: JSON.stringify(out.data), maxAge: 300 };
  }, 'The catalog did not answer. Try again in a minute.');
}
