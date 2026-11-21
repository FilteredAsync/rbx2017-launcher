'use strict';

// The Android app's Builders Club and Trade pages (More > Builders Club opens
// mobile-app-upgrades/, More > Trade opens My/Money.aspx): plain HTML and
// forms on m.<domain> with the app's session cookie (lib/mobile.js). Rules:
// lib/membership.js, lib/limiteds.js, lib/trades.js.
//
//   GET  mobile-app-upgrades/           the tiers and your membership
//   POST mobile-app-upgrades/join       tier
//   GET  My/Money.aspx                  ?kind=inbound|outbound|completed|inactive
//   GET  my/trades/<id>                 one trade; POST my/trades/<id>/accept | decline
//   GET  my/trades/new?with=<userId>    POST my/trades/send  with, give, get (uaids), giveRobux, getRobux

const accounts = require('./accounts');
const membership = require('./membership');
const limiteds = require('./limiteds');
const trades = require('./trades');
const robux = require('./robux');

const FORM_LIMIT = 8 * 1024;

const STYLE = `<style>
.msg{border-radius:4px;padding:10px;margin-bottom:10px;background:#e8f8ee;color:#027a3a}.msg.bad{background:#fdeaea;color:#a12b2b}
h2{font-size:16px;font-weight:600;margin:16px 2px 8px}
.card{background:#fff;border-radius:4px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.12);margin-bottom:10px}
.tier{border:2px solid #e3e3e3}.tier.on{border-color:#f6b900}.tier b{display:block;font-size:17px}.sub{font-size:13px;color:#757575}
.b{border:0;border-radius:4px;font-weight:600;font-size:14px;padding:8px 14px;background:#00a2ff;color:#fff;text-decoration:none;display:inline-block;margin-top:6px}
.b.green{background:#02b757}.b.grey{background:#fff;color:#191919;box-shadow:inset 0 0 0 1px #bbb}
.tabs{display:flex;gap:4px;margin-bottom:10px;overflow-x:auto}.tabs a{flex:1;text-align:center;background:#fff;color:#191919;text-decoration:none;border-radius:4px;padding:8px;font-size:14px}
.tabs a.on{background:#00a2ff;color:#fff}
.row{display:flex;align-items:center;gap:10px;background:#fff;border-radius:4px;padding:10px;margin-bottom:6px;color:#191919;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.row .t{flex:1;min-width:0}
.items{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px}
.item{background:#fff;border-radius:4px;padding:6px;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.item img{width:100%;aspect-ratio:1;object-fit:contain}.item b{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
label.item{display:block}label.item input{margin-right:4px}
.form input[type=number]{width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:4px;margin-top:6px}
.btns{display:flex;gap:6px;flex-wrap:wrap}.btns form{margin:0}
</style>`;

module.exports = function mobileEconomy({ page, escapeHtml, send, hostOf, NEXT }) {
  const q = (ctx, name) => String(ctx.queryLower[name.toLowerCase()] ?? '');
  const redirect = (ctx, location) => send(ctx, 303, { Location: location, 'Cache-Control': 'no-store' }, '');
  const rs = (n) => `R$ ${Number(n || 0).toLocaleString('en-US')}`;
  const nameOf = (userId) => {
    const found = accounts.byUserId(userId);
    return found ? found.name : 'Deleted account';
  };
  const note = (ctx) => {
    const text = q(ctx, 'msg').slice(0, 200);
    return text ? `<div class="msg${q(ctx, 'ok') === '1' ? '' : ' bad'}">${escapeHtml(text)}</div>` : '';
  };
  const back = (path, text, ok) => `${path}${path.includes('?') ? '&' : '?'}${ok ? 'ok=1&' : ''}msg=${encodeURIComponent(text)}`;

  function sameSite(ctx) {
    const from = String(ctx.req.headers.origin || ctx.req.headers.referer || '');
    try {
      return new URL(from).hostname.toLowerCase() === hostOf(ctx);
    } catch (error) {
      return false;
    }
  }

  async function form(ctx) {
    return new URLSearchParams((await ctx.body(FORM_LIMIT)).toString('utf8'));
  }

  const refuse = (ctx) => send(ctx, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Do this from the app.');

  // --- Builders Club ---------------------------------------------------------------------------

  function upgrades(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    if (!who) return page(ctx, 'Builders Club', `${STYLE}<p class="note">Sign in to the app first.</p>`);
    const status = membership.status(who.userId);
    let body = `${STYLE}<h1>Builders Club</h1>${note(ctx)}<p class="sub">${status.tier
      ? `${escapeHtml(status.name)} until ${escapeHtml(new Date(status.until).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}.`
      : 'Members get daily R$, can trade limiteds and join more groups.'} You have ${rs(robux.balance(who.userId))}.</p>`;
    for (const tier of status.tiers) {
      body += `<div class="card tier${status.tier === tier.key ? ' on' : ''}"><b>${escapeHtml(tier.name)}</b><div class="sub">${rs(tier.price)} for ${tier.days} days · +${rs(tier.daily)} every day</div>`
        + `<form method="post" action="/mobile-app-upgrades/join"><input type="hidden" name="tier" value="${tier.key}"><button class="b ${status.tier === tier.key ? 'grey' : 'green'}">${status.tier === tier.key ? 'Add 30 days' : 'Join'}</button></form></div>`;
    }
    page(ctx, 'Builders Club', body);
  }

  async function join(ctx) {
    if (ctx.method !== 'POST') return NEXT;
    if (!sameSite(ctx)) return refuse(ctx);
    const who = accounts.fromRequest(ctx.req);
    if (!who) return redirect(ctx, '/mobile-app-upgrades/');
    const fields = await form(ctx);
    const result = membership.buy(who.userId, String(fields.get('tier') || ''));
    return redirect(ctx, back('/mobile-app-upgrades/', result.error || `You're in ${result.status.name}!`, !result.error));
  }

  // --- trades ---------------------------------------------------------------------------------

  function itemBox(item, input = '') {
    return `<${input ? 'label' : 'div'} class="item"><img src="/asset-thumbnail/image?assetId=${encodeURIComponent(item.assetId)}&amp;width=150&amp;height=150" alt="" loading="lazy">`
      + `<b>${input}${escapeHtml(item.name)}</b>#${item.serial}${item.stock ? `/${item.stock}` : ''} · RAP ${rs(item.rap)}</${input ? 'label' : 'div'}>`;
  }

  function sideItems(side) {
    const items = side.uaids.map((uaid) => {
      const copy = limiteds.copyOf(uaid);
      const record = copy ? limiteds.summary(copy.assetId) : null;
      return { assetId: copy ? copy.assetId : 0, name: record ? record.name : 'Gone', serial: copy ? copy.serial : '?', stock: record ? record.stock : null, rap: limiteds.rapOf(uaid) };
    });
    return `<div class="items">${items.map((item) => itemBox(item)).join('')}</div>${side.robux ? `<p>+ ${rs(side.robux)}</p>` : ''}`;
  }

  function money(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    if (!who) return page(ctx, 'Trades', `${STYLE}<p class="note">Sign in to the app first.</p>`);
    const kind = ['inbound', 'outbound', 'completed', 'inactive'].includes(q(ctx, 'kind')) ? q(ctx, 'kind') : 'inbound';
    const tab = (key, label) => `<a class="${key === kind ? 'on' : ''}" href="/My/Money.aspx?kind=${key}">${label}</a>`;
    let body = `${STYLE}<h1>Trades</h1>${note(ctx)}<nav class="tabs">${tab('inbound', 'Inbound')}${tab('outbound', 'Outbound')}${tab('completed', 'Completed')}${tab('inactive', 'Inactive')}</nav>`;
    if (!membership.tierOf(who.userId)) body += '<p class="note">Trading needs Builders Club. <a href="/mobile-app-upgrades/">Join</a></p>';
    const list = trades.list(who.userId, kind);
    if (!list.length) body += `<p class="note">${kind === 'inbound' ? 'No trades waiting for you.' : 'Nothing here.'}</p>`;
    for (const trade of list) {
      const other = trade.from === who.userId ? trade.to : trade.from;
      body += `<a class="row" href="/my/trades/${trade.id}"><span class="t"><b>${escapeHtml(nameOf(other))}</b><div class="sub">${trade.offer.uaids.length} for ${trade.request.uaids.length} · ${escapeHtml(trade.status)}</div></span></a>`;
    }
    body += '<p class="sub">Start a trade from a player\'s profile.</p>';
    page(ctx, 'Trades', body);
  }

  function tradePage(ctx, match) {
    if (ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    const trade = who ? trades.get(match[1], who.userId) : null;
    if (!trade) return page(ctx, 'Trades', `${STYLE}<p class="note">No such trade.<br><br><a href="/My/Money.aspx">Trades</a></p>`);
    const mine = trade.from === who.userId;
    const other = mine ? trade.to : trade.from;
    let body = `${STYLE}${note(ctx)}<h1>Trade with ${escapeHtml(nameOf(other))}</h1><p class="sub">${escapeHtml(trade.status)}</p>`
      + `<h2>You give</h2>${sideItems(mine ? trade.offer : trade.request)}<h2>You get</h2>${sideItems(mine ? trade.request : trade.offer)}`
      + '<p class="sub">R$ in a trade arrive minus 30%.</p><div class="btns">';
    if (trade.status === 'open') {
      if (!mine) body += `<form method="post" action="/my/trades/${trade.id}/accept"><button class="b green">Accept</button></form>`;
      body += `<form method="post" action="/my/trades/${trade.id}/decline"><button class="b grey">${mine ? 'Cancel trade' : 'Decline'}</button></form>`;
    }
    body += '<a class="b grey" href="/My/Money.aspx">Back</a></div>';
    page(ctx, 'Trade', body);
  }

  async function answer(ctx, match) {
    if (ctx.method !== 'POST') return NEXT;
    if (!sameSite(ctx)) return refuse(ctx);
    const who = accounts.fromRequest(ctx.req);
    if (!who) return redirect(ctx, '/My/Money.aspx');
    const result = match[2] === 'accept' ? trades.accept(match[1], who.userId) : trades.decline(match[1], who.userId);
    return redirect(ctx, back(`/my/trades/${match[1]}`, result.error || (match[2] === 'accept' ? 'Trade done!' : 'Trade closed.'), !result.error));
  }

  function newTrade(ctx) {
    if (ctx.method !== 'GET') return NEXT;
    const who = accounts.fromRequest(ctx.req);
    const other = accounts.byUserId(q(ctx, 'with'));
    if (!who || !other) return page(ctx, 'Trade', `${STYLE}<p class="note">${who ? 'No such player.' : 'Sign in to the app first.'}</p>`);
    const box = (name, items, field) => (items.length
      ? `<div class="items">${items.map((item) => itemBox(item, `<input type="checkbox" name="${field}" value="${item.uaid}">`)).join('')}</div>`
      : `<p class="sub">${escapeHtml(name)} ${name === 'You' ? 'have' : 'has'} no limited items.</p>`);
    page(ctx, 'Trade', `${STYLE}<h1>Trade with ${escapeHtml(other.name)}</h1>${note(ctx)}<p class="sub">Up to 4 items a side. R$ can be up to half the value of the items with them.</p>`
      + `<form class="form" method="post" action="/my/trades/send"><input type="hidden" name="with" value="${other.userId}">`
      + `<h2>You give</h2>${box('You', limiteds.inventory(who.userId), 'give')}<input type="number" name="giveRobux" min="0" placeholder="R$ (optional)">`
      + `<h2>You get</h2>${box(other.name, limiteds.inventory(other.userId), 'get')}<input type="number" name="getRobux" min="0" placeholder="R$ (optional)">`
      + '<div class="btns"><button class="b green">Send trade</button></div></form>');
  }

  async function sendTrade(ctx) {
    if (ctx.method !== 'POST') return NEXT;
    if (!sameSite(ctx)) return refuse(ctx);
    const who = accounts.fromRequest(ctx.req);
    if (!who) return redirect(ctx, '/My/Money.aspx');
    const fields = await form(ctx);
    const otherId = Number(fields.get('with'));
    const result = trades.send(who.userId, otherId,
      { uaids: fields.getAll('give'), robux: Number(fields.get('giveRobux')) || 0 },
      { uaids: fields.getAll('get'), robux: Number(fields.get('getRobux')) || 0 });
    if (result.error) return redirect(ctx, back(`/my/trades/new?with=${otherId}`, result.error));
    return redirect(ctx, back('/My/Money.aspx?kind=outbound', 'Trade sent.', true));
  }

  return {
    pageRoutes: [
      [/^mobile-app-upgrades\/?$/i, upgrades],
      [/^mobile-app-upgrades\/join\/?$/i, join],
      [/^my\/money\.aspx$/i, money],
      [/^my\/trades\/new\/?$/i, newTrade],
      [/^my\/trades\/send\/?$/i, sendTrade],
      [/^my\/trades\/(\d{1,12})\/?$/i, tradePage],
      [/^my\/trades\/(\d{1,12})\/(accept|decline)\/?$/i, answer],
    ],
  };
};
