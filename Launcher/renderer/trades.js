'use strict';

// Trades, the Chat tab's third mode (chat.js shows its side list and pane):
// inbound, outbound, completed and inactive trades; a trade's two sides with
// Accept / Decline / Cancel; a new trade with a player (both need Builders
// Club); and your limited items, which you can put up for sale. Server:
// /api/launcher/trades and limiteds (lib/economyapi.js, servers from
// 2026-11-21 on).
//
//   const trades = TradesView.create({ api, el, message, openProfile, getMe, onRobux })
//   trades.activate()   trades.compose(person)   trades.reset()

(function () {
  const $ = (id) => document.getElementById(id);
  const NET = 'launcher-net://server/';
  const KINDS = [['inbound', 'Inbound'], ['outbound', 'Outbound'], ['completed', 'Completed'], ['inactive', 'Inactive']];
  const MAX_ITEMS = 4;

  function create({ api, el, message, openProfile, getMe, onRobux }) {
    let kind = 'inbound';
    let list = [];
    let open = null;

    const status = (text, kind2) => {
      const node = $('chat-status');
      node.textContent = text || '';
      node.className = `status chat-status${kind2 ? ` ${kind2}` : ''}`;
    };
    const call = (method, route, body) => api.economy(method, route, body);
    const pane = () => $('trade-pane');
    const rs = (n) => `R$ ${Number(n || 0).toLocaleString()}`;

    function itemCard(item, { selected, onClick, extra } = {}) {
      const card = el(onClick ? 'button' : 'div', `trade-item${selected ? ' chosen' : ''}`);
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = `${NET}asset-thumbnail/image?assetId=${encodeURIComponent(item.assetId)}&width=150&height=150`;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      card.append(img, el('div', 'trade-item-name', item.name), el('div', 'trade-item-meta', `#${item.serial}${item.stock ? ` / ${item.stock}` : ''} · RAP ${rs(item.rap)}`));
      if (extra) card.append(extra);
      if (onClick) card.addEventListener('click', onClick);
      return card;
    }

    // --- the side list ------------------------------------------------------------------------

    function renderKinds() {
      const box = $('trade-kinds');
      box.textContent = '';
      for (const [key, label] of KINDS) {
        const button = el('button', key === kind ? 'active' : '', label);
        button.addEventListener('click', () => {
          kind = key;
          load();
        });
        box.append(button);
      }
    }

    function renderList() {
      const box = $('trade-list');
      box.textContent = '';
      if (!list.length) {
        box.append(el('div', 'chat-none', kind === 'inbound' ? 'No trades waiting for you.' : 'Nothing here.'));
        return;
      }
      for (const trade of list) {
        const other = trade.mine === 'sent' ? trade.to : trade.from;
        const item = el('button', `chat-item nav-target${open && open.id === trade.id ? ' active' : ''}`);
        const text = el('div', 'chat-item-text');
        const top = el('div', 'chat-item-top');
        top.append(el('b', 'chat-item-title', other.name), el('span', 'chat-item-time', new Date(trade.updated).toLocaleDateString()));
        text.append(top, el('div', 'chat-item-last', `${trade.offer.items.length} for ${trade.request.items.length} · ${trade.status}`));
        item.append(text);
        item.addEventListener('click', () => show(trade));
        box.append(item);
      }
    }

    async function load() {
      renderKinds();
      if (!getMe()) return;
      try {
        const data = await call('GET', `trades?kind=${kind}`);
        list = data.trades || [];
        $('trade-badge').textContent = String(data.inbound || 0);
        $('trade-badge').classList.toggle('hidden', !data.inbound);
        $('trade-bc-note').classList.toggle('hidden', Boolean(data.membership));
      } catch (error) {
        list = [];
        status(message(error), 'error');
      }
      renderList();
    }

    // --- one trade ---------------------------------------------------------------------------

    function sideBox(title, side) {
      const box = el('div', 'trade-side');
      box.append(el('div', 'section-title', title));
      const grid = el('div', 'trade-items');
      for (const item of side.items) grid.append(itemCard(item));
      if (side.robux) grid.append(el('div', 'trade-robux', `+ ${rs(side.robux)}`));
      if (!side.items.length && !side.robux) grid.append(el('div', 'chat-none', 'Nothing'));
      const value = side.items.reduce((sum, item) => sum + (item.rap || 0), 0);
      box.append(grid, el('div', 'trade-value', `Value ${rs(value)}${side.robux ? ` + ${rs(side.robux)}` : ''}`));
      return box;
    }

    function show(trade) {
      open = trade;
      renderList();
      const box = pane();
      box.textContent = '';
      const other = trade.mine === 'sent' ? trade.to : trade.from;
      const head = el('header', 'chat-head');
      const title = el('div', 'chat-head-text');
      const who = el('button', 'link', other.name);
      who.addEventListener('click', () => openProfile({ userId: other.userId, name: other.name }));
      title.append(el('b', '', `Trade with ${other.name}`));
      const sub = el('div', 'chat-sub');
      sub.append(who, document.createTextNode(` · ${trade.status} · ${new Date(trade.created).toLocaleString()}`));
      title.append(sub);
      head.append(title);
      box.append(head);
      const give = trade.mine === 'sent' ? trade.offer : trade.request;
      const get = trade.mine === 'sent' ? trade.request : trade.offer;
      const sides = el('div', 'trade-sides');
      sides.append(sideBox('YOU GIVE', give), sideBox('YOU GET', get));
      box.append(sides);
      box.append(el('div', 'trade-note', 'R$ in a trade arrive minus 30%.'));
      if (trade.status === 'open') {
        const actions = el('div', 'picker-actions');
        if (trade.mine === 'received') {
          const accept = el('button', 'primary', 'Accept');
          accept.addEventListener('click', () => answer(trade, 'accept'));
          const decline = el('button', 'ghost', 'Decline');
          decline.addEventListener('click', () => answer(trade, 'decline'));
          actions.append(accept, decline);
        } else {
          const cancel = el('button', 'ghost', 'Cancel trade');
          cancel.addEventListener('click', () => answer(trade, 'decline'));
          actions.append(cancel);
        }
        box.append(actions);
      }
    }

    async function answer(trade, verb) {
      if (verb === 'accept' && !window.confirm('Accept this trade? Items and R$ move at once.')) return;
      try {
        const data = await call('POST', `trades/${trade.id}/${verb}`, {});
        if (onRobux && Number.isFinite(data.balance)) onRobux(data.balance);
        status(verb === 'accept' ? 'Trade done!' : 'Trade closed.', 'good');
        await load();
        show(data.trade);
      } catch (error) {
        status(message(error), 'error');
        load();
      }
    }

    // --- a new trade -------------------------------------------------------------------------

    async function compose(person) {
      const me = getMe();
      if (!me) return;
      open = null;
      renderList();
      const box = pane();
      box.textContent = '';
      box.append(el('div', 'chat-empty', 'Loading items…'));
      let mine;
      let theirs;
      try {
        [mine, theirs] = await Promise.all([call('GET', `limiteds/of/${me.account.userId}`), call('GET', `limiteds/of/${person.userId}`)]);
      } catch (error) {
        status(message(error), 'error');
        return;
      }
      const give = new Set();
      const get = new Set();
      box.textContent = '';
      const head = el('header', 'chat-head');
      const title = el('div', 'chat-head-text');
      title.append(el('b', '', `New trade with ${person.name}`), el('div', 'chat-sub', `Up to ${MAX_ITEMS} items a side. R$ can be up to half the value of the items with them.`));
      head.append(title);
      box.append(head);
      const sides = el('div', 'trade-sides');
      const giveRobux = el('input');
      const getRobux = el('input');
      for (const [label, items, chosen, robuxInput] of [['YOUR ITEMS', mine.items || [], give, giveRobux], [`${person.name.toUpperCase()}'S ITEMS`, theirs.items || [], get, getRobux]]) {
        const side = el('div', 'trade-side');
        side.append(el('div', 'section-title', label));
        const grid = el('div', 'trade-items');
        if (!items.length) grid.append(el('div', 'chat-none', 'No limited items.'));
        const draw = () => {
          grid.textContent = '';
          if (!items.length) grid.append(el('div', 'chat-none', 'No limited items.'));
          for (const item of items) {
            grid.append(itemCard(item, {
              selected: chosen.has(item.uaid),
              onClick: () => {
                if (chosen.has(item.uaid)) chosen.delete(item.uaid);
                else if (chosen.size < MAX_ITEMS) chosen.add(item.uaid);
                draw();
              },
            }));
          }
        };
        draw();
        robuxInput.type = 'number';
        robuxInput.min = '0';
        robuxInput.placeholder = 'R$ (optional)';
        side.append(grid, robuxInput);
        sides.append(side);
      }
      box.append(sides);
      const actions = el('div', 'picker-actions');
      const send = el('button', 'primary', 'Send trade');
      send.addEventListener('click', async () => {
        send.disabled = true;
        try {
          await call('POST', 'trades', {
            userId: person.userId,
            offer: { uaids: [...give], robux: Number(giveRobux.value) || 0 },
            request: { uaids: [...get], robux: Number(getRobux.value) || 0 },
          });
          status(`Trade sent to ${person.name}.`, 'good');
          kind = 'outbound';
          await load();
          box.textContent = '';
          box.append(el('div', 'chat-empty', 'Sent. It shows under Outbound until they answer.'));
        } catch (error) {
          status(message(error), 'error');
        } finally {
          send.disabled = false;
        }
      });
      const cancel = el('button', 'ghost', 'Cancel');
      cancel.addEventListener('click', () => { box.textContent = ''; box.append(el('div', 'chat-empty', 'Pick a trade.')); });
      actions.append(send, cancel);
      box.append(actions);
    }

    // --- your limiteds -----------------------------------------------------------------------

    async function showMine() {
      const me = getMe();
      if (!me) return;
      open = null;
      renderList();
      const box = pane();
      box.textContent = '';
      const head = el('header', 'chat-head');
      head.append(el('div', 'chat-head-text'));
      head.firstChild.append(el('b', '', 'Your limiteds'), el('div', 'chat-sub', 'Once an item\'s stock here sells out, you can sell copies. You get 70%.'));
      box.append(head);
      const grid = el('div', 'trade-items wide');
      box.append(grid);
      try {
        const data = await call('GET', `limiteds/of/${me.account.userId}`);
        if (!data.items.length) grid.append(el('div', 'chat-none', 'No limited items yet. Find them in Avatar > Limiteds.'));
        for (const item of data.items) {
          const row = el('div', 'trade-sell');
          const price = el('input');
          price.type = 'number';
          price.min = '1';
          price.placeholder = 'Price';
          if (item.listed) price.value = String(item.listed);
          const sell = el('button', 'primary small', item.listed ? 'Change price' : 'Sell');
          sell.addEventListener('click', async () => {
            try {
              await call('POST', `limiteds/${item.uaid}/sell`, { price: Number(price.value) });
              status(`On sale for ${rs(price.value)}.`, 'good');
              showMine();
            } catch (error) {
              status(message(error), 'error');
            }
          });
          row.append(price, sell);
          if (item.listed) {
            const stop = el('button', 'ghost small', 'Take off sale');
            stop.addEventListener('click', async () => {
              try {
                await call('POST', `limiteds/${item.uaid}/sell`, { price: null });
                status('Taken off sale.', 'good');
                showMine();
              } catch (error) {
                status(message(error), 'error');
              }
            });
            row.append(stop);
          }
          grid.append(itemCard(item, { extra: row }));
        }
      } catch (error) {
        grid.append(el('div', 'chat-none', message(error)));
      }
    }

    $('trade-mine').addEventListener('click', showMine);

    return {
      activate() {
        load();
        if (!pane().childElementCount) pane().append(el('div', 'chat-empty', 'Pick a trade, or trade with someone from their profile.'));
      },
      compose,
      reset() {
        list = [];
        open = null;
        pane().textContent = '';
      },
      refreshBadge: load,
    };
  }

  window.TradesView = { create };
})();
