'use strict';

// The Android app's catalog, inventory and account pages: the More tab opens
// these as web pages on m.<domain> (lib/mobile.js). Plain HTML and forms (no
// script), with the app's own session cookie. Buying works as in the launcher
// and on the website (lib/catalog.js through launcher.shop).
//
//   GET  catalog/?category=&Keyword=&cursor=   items of a category, or a search
//   GET  catalog/<id>[/<name>]                 an item's page
//   POST catalog/buy                           kind, id, price, back -> back to that page
//   GET  users/<id>/inventory?category=        what a player owns
//   GET  my/account                            settings: change the password
//   POST my/account/password                   current, password, again

const accounts = require('./accounts');
const robux = require('./robux');

const FORM_LIMIT = 8 * 1024;

const SHOP_STYLE = `<style>
.chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:6px}
.chip{flex:none;background:#fff;color:#191919;text-decoration:none;border-radius:14px;padding:5px 12px;font-size:14px;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.chip.on{background:#00a2ff;color:#fff}
.search{display:flex;gap:6px;margin-bottom:10px}.search input{flex:1;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:8px}
.card{background:#fff;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.12);color:#191919;text-decoration:none;display:flex;flex-direction:column;padding-bottom:6px}
.card img{width:100%;aspect-ratio:1;object-fit:contain;background:#fff;border-radius:4px 4px 0 0}
.cname{font-size:13px;font-weight:600;padding:4px 6px 0;line-height:1.2;max-height:2.4em;overflow:hidden}
.price{font-size:13px;font-weight:600;color:#02b757;padding:2px 6px 0}.price.off{color:#757575;font-weight:400}.owned{font-size:13px;font-weight:600;color:#00a2ff;padding:2px 6px 0}
.card form{padding:4px 6px 0}.buy{background:#02b757;color:#fff;border:0;border-radius:4px;font-weight:600;font-size:14px;padding:7px 14px}
.more{display:block;text-align:center;margin:12px 0;color:#00a2ff}
.item{background:#fff;border-radius:4px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.12)}.item img{width:100%;max-width:320px;display:block;margin:0 auto 8px}
.item h1{margin:0 0 2px}.by{color:#757575;margin:0 0 10px}.desc{white-space:pre-wrap;overflow-wrap:anywhere}
.msg{border-radius:4px;padding:10px;margin-bottom:10px;background:#e8f8ee;color:#027a3a}.msg.bad{background:#fdeaea;color:#a12b2b}
.form label{display:block;margin-bottom:10px;font-size:14px;color:#555}.form input{display:block;width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px;margin-top:3px}
.form button{background:#00a2ff;color:#fff;border:0;border-radius:4px;font-weight:600;font-size:15px;padding:9px 16px}
</style>`;

module.exports = function mobileShop({ page, escapeHtml, send, launcher, hostOf }) {
  const q = (ctx, name) => String(ctx.queryLower[name.toLowerCase()] ?? '');
  const redirect = (ctx, location) => send(ctx, 303, { Location: location, 'Cache-Control': 'no-store' }, '');
  const priceHtml = (price) => (price === null || price === undefined
    ? '<div class="price off">Off Sale</div>'
    : `<div class="price">${price === 0 ? 'Free' : `R$ ${Number(price).toLocaleString('en-US')}`}</div>`);
  const picture = (item) => (item.kind === 'bundle'
    ? `/bundle-thumbnail/image?bundleId=${encodeURIComponent(item.id)}&width=150&height=150`
    : `/asset-thumbnail/image?assetId=${encodeURIComponent(item.id)}&width=150&height=150`);
  const message = (ctx) => {
    const text = q(ctx, 'msg').slice(0, 200);
    return text ? `<div class="msg${q(ctx, 'ok') === '1' ? '' : ' bad'}">${escapeHtml(text)}</div>` : '';
  };

  // A form posted from this host's own pages (the cookie is the app's session).
  function sameSite(ctx) {
    const from = String(ctx.req.headers.origin || ctx.req.headers.referer || '');
    try {
      return new URL(from).hostname.toLowerCase() === hostOf(ctx);
    } catch (error) {
      return false;
    }
  }

  async function form(ctx) {
    const text = (await ctx.body(FORM_LIMIT)).toString('utf8');
    return new URLSearchParams(text);
  }

  // What a card's button buys: the item, or the package a body part comes in.
  function purchaseOf(item) {
    if (item.kind === 'bundle') return { kind: 'bundle', id: item.id, price: item.price, name: item.name };
    if (item.packageId) return { kind: 'bundle', id: item.packageId, price: item.packagePrice, name: item.packageName || 'its package' };
    return { kind: 'asset', id: item.id, price: item.price, name: item.name };
  }

  function buyForm(buying, back) {
    if (buying.price === null || buying.price === undefined) return '';
    return `<form method="post" action="/catalog/buy"><input type="hidden" name="kind" value="${buying.kind}">`
      + `<input type="hidden" name="id" value="${escapeHtml(buying.id)}"><input type="hidden" name="price" value="${buying.price}">`
      + `<input type="hidden" name="back" value="${escapeHtml(back)}"><button class="buy">${buying.price === 0 ? 'Get' : 'Buy'}</button></form>`;
  }

  function card(item, who, back) {
    const buying = purchaseOf(item);
    const link = item.kind === 'asset' && !item.packageId ? `/catalog/${encodeURIComponent(item.id)}` : null;
    const inner = `<img src="${picture(item)}" alt="" loading="lazy"><div class="cname">${escapeHtml(item.name || `Item ${item.id}`)}</div>`
      + (item.owned === true ? '<div class="owned">Owned</div>' : (item.price !== undefined || item.packageId ? priceHtml(buying.price) : ''));
    if (link) return `<a class="card" href="${link}">${inner}</a>`;
    return `<div class="card">${inner}${who && item.owned === false ? buyForm(buying, back) : ''}</div>`;
  }

  function chips(list, current, hrefFor) {
    return `<nav class="chips">${list.map((entry) => `<a class="chip${entry.key === current ? ' on' : ''}" href="${hrefFor(entry.key)}">${escapeHtml(entry.label)}</a>`).join('')}</nav>`;
  }

  async function catalogPage(ctx) {
    const who = accounts.fromRequest(ctx.req);
    const categories = launcher.shop.categories();
    const keyword = (q(ctx, 'Keyword') || q(ctx, 'keyword')).trim().slice(0, 50);
    const category = categories.some((entry) => entry.key === q(ctx, 'category')) ? q(ctx, 'category') : 'hats';
    const cursor = q(ctx, 'cursor').slice(0, 500);
    const result = await launcher.shop.search(category, keyword, cursor, who);
    const back = `/catalog/?category=${category}${keyword ? `&Keyword=${encodeURIComponent(keyword)}` : ''}`;
    let body = `${SHOP_STYLE}<h1>Catalog</h1>${message(ctx)}`
      + `<form class="search" method="get" action="/catalog/"><input type="hidden" name="category" value="${category}">`
      + `<input name="Keyword" value="${escapeHtml(keyword)}" placeholder="Search" maxlength="50"></form>`
      + chips(categories, category, (key) => `/catalog/?category=${key}`);
    if (result.error) body += `<p class="note">${escapeHtml(result.error)}</p>`;
    else if (!result.items.length) body += `<p class="note">${keyword ? 'Nothing found.' : 'Nothing here right now.'}</p>`;
    else {
      body += `<div class="grid">${result.items.map((item) => card(item, who, back)).join('')}</div>`;
      if (result.nextCursor) body += `<a class="more" href="${back}&cursor=${encodeURIComponent(result.nextCursor)}">More</a>`;
    }
    if (!who) body += '<p class="note">Sign in to the app to buy items.</p>';
    page(ctx, 'Catalog', body);
  }

  async function itemPage(ctx, match) {
    const who = accounts.fromRequest(ctx.req);
    const info = await launcher.shop.itemInfo(match[1]);
    if (!info || !info.typeName) return page(ctx, 'Catalog', `${SHOP_STYLE}<p class="note">${info ? 'This is not a catalog item.' : 'Could not look this item up. Try again in a minute.'}<br><br><a href="/catalog/">Catalog</a></p>`);
    const owned = who ? launcher.shop.owns(who.userId, info.id) : false;
    let buy = '';
    if (owned) buy = '<div class="owned">You own this item</div>';
    else if (!who) buy = '<p class="note">Sign in to the app to buy items.</p>';
    else if (info.limited) buy = '<p class="by">Limited items can\'t be bought yet.</p>';
    else buy = buyForm({ kind: 'asset', id: info.id, price: info.price }, `/catalog/${info.id}`) + (info.price !== null ? `<p class="by">You have R$ ${robux.balance(who.userId).toLocaleString('en-US')}.</p>` : '');
    page(ctx, info.name, `${SHOP_STYLE}${message(ctx)}<div class="item"><img src="/asset-thumbnail/image?assetId=${encodeURIComponent(info.id)}&width=420&height=420" alt="">`
      + `<h1>${escapeHtml(info.name)}</h1><p class="by">By ${escapeHtml(info.creator)} · ${escapeHtml(info.typeName)}</p>`
      + `${owned ? '' : priceHtml(info.limited ? null : info.price)}${buy}`
      + `${info.description ? `<p class="desc">${escapeHtml(info.description)}</p>` : ''}</div><p><a href="/catalog/">Back to the catalog</a></p>`);
  }

  async function buy(ctx) {
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Buy from the app.');
    const fields = await form(ctx);
    const backField = fields.get('back') || '/catalog/';
    const back = /^\/catalog\/[A-Za-z0-9/?=&%._-]*$/.test(backField) ? backField : '/catalog/';
    const join = back.includes('?') ? '&' : '?';
    const who = accounts.fromRequest(ctx.req);
    if (!who) return redirect(ctx, `${back}${join}msg=${encodeURIComponent('Sign in to the app to buy items.')}`);
    const priceText = fields.get('price');
    const result = await launcher.shop.buy(who, {
      kind: fields.get('kind') === 'bundle' ? 'bundle' : 'asset',
      id: String(fields.get('id') || ''),
      price: priceText === null || priceText === '' ? null : Number(priceText),
    });
    if (result.error) return redirect(ctx, `${back}${join}msg=${encodeURIComponent(result.error)}`);
    return redirect(ctx, `${back}${join}ok=1&msg=${encodeURIComponent(result.already ? 'You already own it.' : 'Bought! Wear it from the Avatar tab.')}`);
  }

  async function inventoryPage(ctx, match) {
    const owner = accounts.byUserId(match[1]);
    if (!owner) return page(ctx, 'Inventory', `${SHOP_STYLE}<p class="note">No such player.</p>`);
    const categories = launcher.shop.categories().concat([{ key: 'gear', label: 'Gear' }]);
    const category = categories.some((entry) => entry.key === q(ctx, 'category')) ? q(ctx, 'category') : 'hats';
    const items = await launcher.shop.inventory(owner.userId, category);
    page(ctx, 'Inventory', `${SHOP_STYLE}<h1>${escapeHtml(owner.name)}'s Inventory</h1>`
      + chips(categories, category, (key) => `/users/${owner.userId}/inventory?category=${key}`)
      + (items.length ? `<div class="grid">${items.map((item) => card(Object.assign({ owned: true }, item), null, '')).join('')}</div>` : '<p class="note">Nothing here yet.</p>'));
  }

  function accountPage(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) return page(ctx, 'Settings', '<p class="note">Sign in to the app first.</p>');
    page(ctx, 'Settings', `${SHOP_STYLE}<h1>Settings</h1>${message(ctx)}<div class="item"><p>Username: <b>${escapeHtml(who.name)}</b></p>`
      + `<p><a href="/users/${who.userId}/inventory">Your inventory</a></p></div><h2>Change password</h2>`
      + '<form class="form item" method="post" action="/my/account/password">'
      + '<label>Current password<input type="password" name="current" autocomplete="current-password" maxlength="200"></label>'
      + `<label>New password (at least ${accounts.MIN_PASSWORD} characters)<input type="password" name="password" autocomplete="new-password" maxlength="200"></label>`
      + '<label>New password again<input type="password" name="again" autocomplete="new-password" maxlength="200"></label>'
      + '<button>Change password</button></form>');
  }

  async function changePassword(ctx) {
    if (!sameSite(ctx)) return send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Change it from the app.');
    const fields = await form(ctx);
    const back = (text, ok) => redirect(ctx, `/my/account?${ok ? 'ok=1&' : ''}msg=${encodeURIComponent(text)}`);
    if ((fields.get('password') || '') !== (fields.get('again') || '')) return back('The new passwords don\'t match.');
    const result = accounts.changePassword(accounts.cookieToken(ctx.req.headers.cookie), fields.get('current'), fields.get('password'), ctx.remote);
    if (result.error) return back(result.error);
    return back('Password changed. You were signed out everywhere else.', true);
  }

  const methodIs = (method, handler) => (ctx, match) => (ctx.method === method ? handler(ctx, match) : send(ctx, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed'));

  return {
    pageRoutes: [
      [/^catalog\/?$/i, methodIs('GET', catalogPage)],
      [/^catalog\/buy\/?$/i, methodIs('POST', buy)],
      [/^catalog\/(\d{1,15})(?:\/[^/]*)?\/?$/i, methodIs('GET', itemPage)],
      [/^users\/(\d{1,15})\/inventory\/?$/i, methodIs('GET', inventoryPage)],
      [/^my\/account\/?$/i, methodIs('GET', accountPage)],
      [/^my\/account\/password\/?$/i, methodIs('POST', changePassword)],
    ],
  };
};
