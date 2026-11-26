// rbx2017 site: game lists, the game page and the play dialog. The data
// comes from /api (functions/api), the site's edge-cached copy of the game
// server's public endpoints. No innerHTML with server data: text goes in
// through textContent only.
(function () {
  'use strict';

  // The launcher's server: rbx2017:// links name it, and launchers take
  // links only for the server they use.
  var GAME_HOST = 'rbx2017.com';

  var ICONS = {
    search: 'M10 2a8 8 0 0 1 6.32 12.9l5.39 5.4-1.42 1.4-5.39-5.38A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
    up: 'M2 21h4V9H2v12zM23 10a2 2 0 0 0-2-2h-6.3l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10a2 2 0 0 0 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
    down: 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2a2 2 0 0 0 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5a2 2 0 0 0-2-2zm4 0v12h4V3h-4z',
    play: 'M8 5v14l11-7z',
    prev: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    next: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    caret: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z',
    first: 'M18.41 16.59 13.82 12l4.59-4.59L17 6l-6 6 6 6zM6 6h2v12H6z',
    last: 'M5.59 7.41 10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
    people: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    chat: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z',
    bag: 'M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z',
    trade: 'M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
    groups: 'M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91zM4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58A2.01 2.01 0 0 0 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29zM20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm4 3.43c0-.81-.48-1.53-1.22-1.85A6.95 6.95 0 0 0 20 14c-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24v-1.57zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z',
    forum: 'M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z',
    cog: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  };

  // ---- small helpers ----
  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function number(value) { return Number(value || 0).toLocaleString('en-US'); }

  function plural(n, one, many) { return number(n) + ' ' + (n === 1 ? one : many); }

  function slug(name) {
    return String(name || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'game';
  }

  function gameUrl(game) { return '/games/' + game.placeId + '/' + slug(game.name); }

  function thumbUrl(game) {
    return game.thumbnail ? '/api/thumb/' + game.placeId + '?v=' + game.thumbnail : null;
  }

  // Name without a leading "[UPDATE]"-style tag, for A-Z order and covers.
  function plainName(name) {
    return String(name || '').replace(/^\s*(?:[[(][^\])]*[\])]\s*)+/, '').replace(/^[^A-Za-z0-9]+/, '') || String(name || '');
  }

  function coverFor(game) {
    var hash = 0;
    var name = String(game.name || game.placeId);
    for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    var hue = Math.abs(hash) % 360;
    var cover = el('span', 'cover', plainName(game.name));
    cover.style.background = 'linear-gradient(135deg, hsl(' + hue + ',55%,48%), hsl(' + ((hue + 40) % 360) + ',60%,32%))';
    return cover;
  }

  var requests = {};
  function getJson(path) {
    if (!requests[path]) {
      requests[path] = fetch('/api/' + path, { headers: { Accept: 'application/json' } }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          return { ok: response.ok, status: response.status, stale: response.headers.get('X-Stale') === '1', data: data };
        });
      }, function () {
        return { ok: false, status: 0, stale: false, data: null };
      });
    }
    return requests[path];
  }

  function loadGames() {
    return getJson('games').then(function (result) {
      var games = result.ok && result.data && Array.isArray(result.data.games) ? result.data.games : null;
      return { games: games, stale: result.stale };
    });
  }

  // Votes for the card bars; the cards draw without them and fill in later.
  var votes = {};
  var votesLoading = null;
  function loadVotes() {
    if (!votesLoading) {
      votesLoading = getJson('votes').then(function (result) {
        if (result.ok && result.data && result.data.votes) {
          Object.keys(result.data.votes).forEach(function (id) { if (!votes[id]) votes[id] = result.data.votes[id]; });
        }
        applyVotes();
        return votes;
      });
    }
    return votesLoading;
  }

  function within(promise, ms) {
    return Promise.race([promise, new Promise(function (resolve) { setTimeout(resolve, ms); })]);
  }

  function rating(game) {
    var v = votes[game.placeId];
    if (!v) return 0.5;
    return (v.up + 1) / (v.up + v.down + 2);
  }

  function totalVotes(game) {
    var v = votes[game.placeId];
    return v ? v.up + v.down : 0;
  }

  var SORTS = {
    popular: { title: 'Popular', compare: function (a, b) { return b.playing - a.playing || rating(b) - rating(a) || byName(a, b); } },
    'top-rated': { title: 'Top Rated', compare: function (a, b) { return rating(b) - rating(a) || totalVotes(b) - totalVotes(a) || byName(a, b); } },
    recent: { title: 'Recently Added', compare: function (a, b) { return Number(b.placeId) - Number(a.placeId); } },
    az: { title: 'A to Z', compare: byName },
  };

  function byName(a, b) { return plainName(a.name).localeCompare(plainName(b.name), 'en', { sensitivity: 'base' }); }

  function sorted(games, sort) { return games.slice().sort(SORTS[sort].compare); }

  // ---- header ----
  function showOnline(result) {
    var node = $('online-count');
    if (!node) return;
    node.textContent = '';
    node.appendChild(el('span', 'online-dot'));
    if (!result.games || result.stale) {
      node.classList.add('offline');
      node.appendChild(document.createTextNode('Server offline'));
    } else {
      var playing = result.games.reduce(function (sum, game) { return sum + game.playing; }, 0);
      node.appendChild(document.createTextNode(playing > 0 ? plural(playing, 'player', 'players') + ' online' : 'Server online'));
    }
    node.classList.remove('hidden');
  }

  // The header's search: as you type, "Search "x" in Games / Catalog /
  // People / Groups" (2017's universal search). Enter takes the chosen one.
  var SEARCH_IN = [
    ['Games', function (q) { return '/games?q=' + encodeURIComponent(q); }],
    ['Catalog', function (q) { return '/catalog?keyword=' + encodeURIComponent(q); }],
    ['People', function (q) { return '/users/friends?q=' + encodeURIComponent(q.replace(/[^A-Za-z0-9_]/g, '')); }],
    ['Groups', function (q) { return '/groups?q=' + encodeURIComponent(q); }],
  ];

  function fillSearch() {
    var form = $('header-search');
    var menu = $('search-menu');
    if (!form || !menu) return;
    var input = form.querySelector('input');
    var page = document.body.dataset.page;
    var params = new URLSearchParams(location.search);
    var start = page === 'games' ? params.get('q') : page === 'catalog' ? params.get('keyword') : null;
    if (start) input.value = start;
    var order = page === 'catalog' || page === 'item' || page === 'inventory' ? [1, 0, 2, 3]
      : page === 'groups' || page === 'group' ? [3, 0, 1, 2]
      : page === 'friends' || page === 'profile' ? [2, 0, 1, 3] : [0, 1, 2, 3];
    var chosen = 0;
    function draw() {
      var q = input.value.trim();
      menu.textContent = '';
      var show = Boolean(q) && document.activeElement === input;
      menu.classList.toggle('hidden', !show);
      input.setAttribute('aria-expanded', show ? 'true' : 'false');
      if (!show) return;
      order.forEach(function (index, i) {
        var option = el('li', i === chosen ? 'selected' : null);
        option.id = 'search-in-' + i;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', i === chosen ? 'true' : 'false');
        option.appendChild(document.createTextNode('Search “'));
        option.appendChild(el('b', null, q));
        option.appendChild(document.createTextNode('” in ' + SEARCH_IN[index][0]));
        option.addEventListener('mousedown', function (event) { event.preventDefault(); go(i); });
        menu.appendChild(option);
      });
      input.setAttribute('aria-activedescendant', 'search-in-' + chosen);
    }
    function go(i) {
      var q = input.value.trim().slice(0, 60);
      if (q) location.href = SEARCH_IN[order[i]][1](q);
    }
    input.addEventListener('input', function () { chosen = 0; draw(); });
    input.addEventListener('focus', draw);
    input.addEventListener('blur', function () { menu.classList.add('hidden'); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        chosen = (chosen + (event.key === 'ArrowDown' ? 1 : order.length - 1)) % order.length;
        draw();
      } else if (event.key === 'Escape') {
        menu.classList.add('hidden');
      }
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      go(chosen);
    });
  }

  // ---- the left column (signed in): your pages, as on the 2017 site ----
  var LEFT_PAGES = [
    ['home', 'Home', function () { return '/home'; }],
    ['person', 'Profile', function (me) { return '/users/' + me.account.userId + '/profile'; }],
    ['mail', 'Messages', function () { return '/my/messages'; }, 'nav-messages'],
    ['people', 'Friends', function () { return '/users/friends'; }, 'nav-friends'],
    ['chat', 'Chat', function () { return '/chat'; }, 'nav-chat'],
    ['bag', 'Inventory', function (me) { return '/users/' + me.account.userId + '/inventory'; }],
    ['trade', 'Trade', function () { return '/my/trades'; }],
    ['groups', 'Groups', function () { return '/groups'; }],
    ['forum', 'Forum', function () { return '/forum'; }],
  ];

  function renderLeftCol(me) {
    var col = $('left-col');
    if (!col) return;
    var signedIn = Boolean(me && me.account);
    if (window.SiteThemes && me && !me.offline) window.SiteThemes.signedIn(signedIn);
    col.textContent = '';
    if (!signedIn) {
      col.classList.remove('open');
      return;
    }
    var user = el('a', 'left-col-user');
    user.href = '/users/' + me.account.userId + '/profile';
    user.appendChild(avatarPicture(me.account.userId, me.account.name, 'message-picture'));
    user.appendChild(el('span', null, me.account.name));
    col.appendChild(user);
    var list = el('ul');
    LEFT_PAGES.forEach(function (entry) {
      var item = el('li');
      var link = el('a');
      link.href = entry[2](me);
      link.appendChild(icon(entry[0]));
      link.appendChild(el('span', null, entry[1]));
      if (entry[3]) {
        var count = el('span', 'menu-count hidden');
        count.id = entry[3];
        link.appendChild(count);
      }
      if (location.pathname === link.pathname) link.setAttribute('aria-current', 'page');
      item.appendChild(link);
      list.appendChild(item);
    });
    col.appendChild(list);
    var club = el('a', 'btn btn-green btn-sm left-col-bc', 'Builders Club');
    club.href = '/my/account#bc';
    col.appendChild(club);
    if (counts) showCounts(counts);
  }

  function navToggle() {
    var toggle = $('nav-toggle');
    var col = $('left-col');
    if (!toggle || !col) return;
    function set(open) {
      col.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      set(!col.classList.contains('open'));
    });
    document.addEventListener('click', function (event) {
      if (col.classList.contains('open') && !col.contains(event.target)) set(false);
    });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') set(false); });
  }

  function offlineAlert(result, container) {
    if (result.games && !result.stale) return;
    var alert = el('div', 'alert', result.games
      ? 'The game server isn\'t answering right now. This list may be out of date.'
      : 'Can\'t reach the game server right now. Try again in a few minutes.');
    alert.setAttribute('role', 'status');
    container.insertBefore(alert, container.firstChild);
  }

  // ---- game cards and rows ----
  function voteBar(placeId) {
    var bar = el('span', 'vote-bar empty');
    bar.dataset.place = placeId;
    bar.appendChild(el('span', 'vote-fill'));
    return bar;
  }

  function paintBar(bar) {
    var v = votes[bar.dataset.place];
    var total = v ? v.up + v.down : 0;
    var fill = bar.firstChild;
    bar.classList.toggle('empty', total === 0);
    fill.style.width = total ? Math.round((v.up / total) * 100) + '%' : '0';
    var label = total ? Math.round((v.up / total) * 100) + '% liked, ' + plural(total, 'vote', 'votes') : 'No votes yet';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', label);
    bar.title = label;
  }

  function applyVotes() {
    var bars = document.querySelectorAll('.vote-bar[data-place]');
    for (var i = 0; i < bars.length; i++) paintBar(bars[i]);
  }

  function gameCard(game) {
    var card = el('a', 'game-card');
    card.href = gameUrl(game);
    var thumb = el('span', 'game-card-thumb');
    var src = thumbUrl(game);
    if (src) {
      var img = el('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () { thumb.textContent = ''; thumb.appendChild(coverFor(game)); });
      thumb.appendChild(img);
    } else {
      thumb.appendChild(coverFor(game));
    }
    card.appendChild(thumb);
    card.appendChild(el('span', 'game-card-name', game.name));
    card.lastChild.title = game.name;
    card.appendChild(el('span', 'game-card-players' + (game.playing > 0 ? ' live' : ''), number(game.playing) + ' Playing'));
    var vote = el('span', 'game-card-vote');
    var bar = voteBar(game.placeId);
    vote.appendChild(icon('up'));
    vote.appendChild(bar);
    vote.appendChild(icon('down'));
    card.appendChild(vote);
    paintBar(bar);
    return card;
  }

  function skeletonCards(container, n) {
    for (var i = 0; i < n; i++) {
      var card = el('span', 'game-card skeleton');
      card.appendChild(el('span', 'game-card-thumb'));
      card.appendChild(el('span', 'game-card-name'));
      container.appendChild(card);
    }
  }

  function gameRow(title, games, seeAll) {
    var section = el('section', 'section');
    var header = el('div', 'container-header');
    header.appendChild(el('h2', null, title));
    if (seeAll) {
      var more = el('a', 'btn btn-secondary btn-xs', 'See All');
      more.href = seeAll;
      header.appendChild(more);
    }
    section.appendChild(header);
    var row = el('div', 'game-row');
    var prev = el('button', 'scroller prev');
    var next = el('button', 'scroller next');
    prev.type = next.type = 'button';
    prev.setAttribute('aria-label', 'Scroll left');
    next.setAttribute('aria-label', 'Scroll right');
    prev.appendChild(icon('prev'));
    next.appendChild(icon('next'));
    var track = el('div', 'game-row-track');
    games.forEach(function (game) { track.appendChild(gameCard(game)); });
    function update() {
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    }
    prev.addEventListener('click', function () { track.scrollBy({ left: -(track.clientWidth - 150), behavior: 'smooth' }); });
    next.addEventListener('click', function () { track.scrollBy({ left: track.clientWidth - 150, behavior: 'smooth' }); });
    track.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    row.appendChild(prev);
    row.appendChild(track);
    row.appendChild(next);
    section.appendChild(row);
    requestAnimationFrame(update);
    return section;
  }

  function gameGrid(games) {
    var grid = el('div', 'game-grid');
    games.forEach(function (game) { grid.appendChild(gameCard(game)); });
    return grid;
  }

  function emptyState(text) { return el('div', 'empty-state', text); }

  // ---- play ----
  var dialog = null;
  function closeDialog() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    document.removeEventListener('keydown', onDialogKey);
  }
  function onDialogKey(event) { if (event.key === 'Escape') closeDialog(); }

  function play(game, serverId) {
    // Android phones: the rbx2017 app (tools/build-android-apk.py) takes the
    // 2017 app's own link and picks a server itself.
    var android = /Android/i.test(navigator.userAgent);
    var link = android ? 'rbx2017://placeID=' + game.placeId
      : 'rbx2017://play/' + game.placeId + '?host=' + encodeURIComponent(GAME_HOST) + (serverId ? '&server=' + serverId : '');
    closeDialog();
    dialog = el('div', 'modal-backdrop');
    var box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'play-title');
    box.appendChild(el('div', 'spinner'));
    var title = el('h2', null, android ? 'Opening the app' : 'Opening the launcher');
    title.id = 'play-title';
    box.appendChild(title);
    box.appendChild(el('p', null, serverId ? 'Joining a server in ' + game.name + '.' : game.name));
    var help = el('p', 'hidden', android ? 'Nothing happened? You need the rbx2017 app.' : 'Nothing happened? You need the launcher first.');
    box.appendChild(help);
    var buttons = el('div', 'buttons');
    var get = el('a', 'btn btn-green btn-lg hidden', 'Download the launcher');
    get.href = '/download';
    var close = el('button', 'btn btn-secondary', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeDialog);
    if (!android) buttons.appendChild(get);
    buttons.appendChild(close);
    box.appendChild(buttons);
    dialog.appendChild(box);
    dialog.addEventListener('click', function (event) { if (event.target === dialog) closeDialog(); });
    document.addEventListener('keydown', onDialogKey);
    document.body.appendChild(dialog);
    close.focus();
    setTimeout(function () {
      help.classList.remove('hidden');
      get.classList.remove('hidden');
    }, 2500);
    location.href = link;
  }

  // ---- pages ----
  function homePage() {
    // Signed in: your home page. Signed out: the sign-up box.
    loadMe().then(function (me) {
      if (me.account) { location.replace('/home'); return; }
      var box = $('hero-signup');
      if (!box || me.offline) return;
      authForm($('auth-form'), 'signup', me);
      box.classList.remove('hidden');
    });
    var rows = $('home-rows');
    skeletonCards(rows.appendChild(el('div', 'game-row-track')), 6);
    loadGames().then(function (result) {
      showOnline(result);
      return within(loadVotes(), 2500).then(function () { return result; });
    }).then(function (result) {
      rows.textContent = '';
      offlineAlert(result, rows);
      if (!result.games) return;
      if (!result.games.length) { rows.appendChild(emptyState('No games yet.')); return; }
      rows.appendChild(gameRow('Popular', sorted(result.games, 'popular').slice(0, 18), '/games?sort=popular'));
      rows.appendChild(gameRow('Recently Added', sorted(result.games, 'recent').slice(0, 18), '/games?sort=recent'));
      heroMosaic(result.games);
    });
  }

  function heroMosaic(games) {
    var mosaic = $('hero-mosaic');
    var pictures = games.filter(thumbUrl);
    if (!mosaic || !pictures.length) return;
    for (var i = 0; i < 48; i++) {
      var img = el('img');
      img.src = thumbUrl(pictures[i % pictures.length]);
      img.alt = '';
      img.decoding = 'async';
      mosaic.appendChild(img);
    }
  }

  function gamesPage() {
    var params = new URLSearchParams(location.search);
    var q = (params.get('q') || '').trim().slice(0, 60);
    var sort = SORTS[params.get('sort')] ? params.get('sort') : '';
    var content = $('games-content');
    var select = $('sort-select');
    var heading = $('games-heading');
    select.value = sort;
    select.addEventListener('change', function () {
      location.href = select.value ? '/games?sort=' + encodeURIComponent(select.value) : '/games';
    });
    if (q) {
      heading.textContent = 'Search';
      document.title = q + ' - Games - rbx2017';
    } else if (sort) {
      heading.textContent = SORTS[sort].title;
      document.title = SORTS[sort].title + ' Games - rbx2017';
    }
    var grid = content.appendChild(el('div', 'game-grid'));
    skeletonCards(grid, 12);

    loadGames().then(function (result) {
      showOnline(result);
      return within(loadVotes(), 2500).then(function () { return result; });
    }).then(function (result) {
      content.textContent = '';
      offlineAlert(result, content);
      if (!result.games) return;
      var games = result.games;
      if (q) {
        var needle = q.toLowerCase();
        var found = games.filter(function (game) {
          return (game.name + ' ' + game.creator + ' ' + game.description).toLowerCase().indexOf(needle) !== -1;
        }).sort(function (a, b) {
          var an = a.name.toLowerCase().indexOf(needle) !== -1 ? 0 : 1;
          var bn = b.name.toLowerCase().indexOf(needle) !== -1 ? 0 : 1;
          return an - bn || SORTS.popular.compare(a, b);
        });
        var summary = el('p', 'search-summary');
        summary.appendChild(document.createTextNode(plural(found.length, 'game', 'games') + ' for “' + q + '”. '));
        var clear = el('a', null, 'Show all games');
        clear.href = '/games';
        summary.appendChild(clear);
        content.appendChild(summary);
        content.appendChild(found.length ? gameGrid(found) : emptyState('No games match that search.'));
        return;
      }
      if (!games.length) { content.appendChild(emptyState('No games yet.')); return; }
      if (sort) { content.appendChild(gameGrid(sorted(games, sort))); return; }
      ['popular', 'top-rated', 'recent'].forEach(function (key) {
        content.appendChild(gameRow(SORTS[key].title, sorted(games, key), '/games?sort=' + key));
      });
    });
  }

  function gamePage() {
    var match = /^\/games\/(\d{1,15})(?:\/|$)/.exec(location.pathname);
    var root = $('game-root');
    if (!match) { notFound(root); return; }
    var placeId = match[1];
    Promise.all([loadGames(), getJson('game/' + placeId)]).then(function (results) {
      var list = results[0];
      var page = results[1];
      showOnline(list);
      var game = list.games ? list.games.filter(function (g) { return g.placeId === placeId; })[0] : null;
      root.textContent = '';
      if (!list.games && !page.ok) { offlineAlert(list, root); return; }
      if (!game) { notFound(root); return; }
      offlineAlert(list, root);
      renderGame(root, game, page.ok ? page.data : null, list.games);
    });
  }

  function notFound(root) {
    root.textContent = '';
    document.title = 'Game not found - rbx2017';
    var box = el('div', 'not-found');
    box.appendChild(el('div', 'big', '404'));
    box.appendChild(el('h1', null, 'This game isn’t here.'));
    var buttons = el('div', 'buttons');
    var all = el('a', 'btn btn-primary', 'Browse games');
    all.href = '/games';
    buttons.appendChild(all);
    box.appendChild(buttons);
    root.appendChild(box);
  }

  function renderGame(root, game, page, allGames) {
    document.title = game.name + ' - rbx2017';
    var canonical = gameUrl(game);
    if (location.pathname !== canonical) history.replaceState(null, '', canonical + location.search + location.hash);

    // Picture, name, Play and votes.
    var main = el('div', 'game-main');
    var media = el('div', 'game-media');
    var src = thumbUrl(game);
    if (src) {
      var backdrop = el('div', 'game-media-backdrop');
      backdrop.style.backgroundImage = 'url("' + src + '")';
      var img = el('img');
      img.src = src;
      img.alt = game.name;
      media.appendChild(backdrop);
      media.appendChild(img);
    } else {
      media.appendChild(coverFor(game));
    }
    main.appendChild(media);

    var calls = el('div', 'game-calls');
    calls.appendChild(el('h1', 'game-name', game.name));
    if (game.creator) {
      var by = el('div', 'game-creator', 'By ');
      by.appendChild(el('span', null, game.creator));
      calls.appendChild(by);
    }
    var playButton = el('button', 'btn btn-green game-play' + (game.online ? '' : ' offline'));
    playButton.type = 'button';
    playButton.setAttribute('aria-label', 'Play ' + game.name);
    playButton.appendChild(icon('play'));
    playButton.addEventListener('click', function () { play(game); });
    var playArea = el('div', 'game-play-area');
    playArea.appendChild(playButton);
    playArea.appendChild(el('p', 'game-play-note', game.online ? (game.playing > 0 ? plural(game.playing, 'person', 'people') + ' playing now' : '') : 'Game servers are offline right now.'));
    calls.appendChild(playArea);

    var v = page && page.votes ? page.votes : votes[game.placeId];
    if (v) votes[game.placeId] = v;
    var voteRow = el('div', 'game-votes');
    var up = el('span', 'vote-count');
    up.appendChild(icon('up'));
    up.appendChild(document.createTextNode(number(v ? v.up : 0)));
    var down = el('span', 'vote-count');
    down.appendChild(icon('down'));
    down.appendChild(document.createTextNode(number(v ? v.down : 0)));
    var bar = voteBar(game.placeId);
    voteRow.appendChild(up);
    voteRow.appendChild(bar);
    voteRow.appendChild(down);
    calls.appendChild(voteRow);
    paintBar(bar);
    main.appendChild(calls);
    root.appendChild(main);

    // Tabs.
    var badges = page && Array.isArray(page.badges) ? page.badges : [];
    var passes = page && Array.isArray(page.passes) ? page.passes : [];
    var tabs = el('div', 'rbx-tabs');
    tabs.setAttribute('role', 'tablist');
    var panels = {};
    var buttons = {};
    var names = [['about', 'About', null], ['store', 'Store', passes.length], ['servers', 'Servers', game.servers.length]];
    names.forEach(function (entry) {
      var tab = el('button', 'rbx-tab', entry[1]);
      tab.type = 'button';
      tab.id = 'tab-' + entry[0];
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'panel-' + entry[0]);
      if (entry[2]) {
        tab.appendChild(document.createTextNode(' '));
        tab.appendChild(el('span', 'count', '(' + entry[2] + ')'));
      }
      tab.addEventListener('click', function () { select(entry[0], true); });
      tabs.appendChild(tab);
      buttons[entry[0]] = tab;
      var panel = el('div');
      panel.id = 'panel-' + entry[0];
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panels[entry[0]] = panel;
    });
    tabs.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      var keys = Object.keys(buttons);
      var at = keys.indexOf(current);
      var to = keys[(at + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      select(to, true);
      buttons[to].focus();
    });
    root.appendChild(tabs);
    Object.keys(panels).forEach(function (key) { root.appendChild(panels[key]); });

    aboutPanel(panels.about, game, page, badges, allGames);
    storePanel(panels.store, game, passes, page);
    serversPanel(panels.servers, game);

    var current = null;
    function select(key, remember) {
      current = key;
      Object.keys(panels).forEach(function (name) {
        var on = name === key;
        panels[name].classList.toggle('hidden', !on);
        buttons[name].setAttribute('aria-selected', on ? 'true' : 'false');
        buttons[name].tabIndex = on ? 0 : -1;
      });
      if (remember) history.replaceState(null, '', key === 'about' ? location.pathname + location.search : '#' + key);
    }
    select(panels[location.hash.slice(1)] ? location.hash.slice(1) : 'about', false);
  }

  function aboutPanel(panel, game, page, badges, allGames) {
    var about = el('section', 'section section-content');
    about.appendChild(el('h2', null, 'Description'));
    var text = el('p', 'game-description', game.description || 'No description.');
    about.appendChild(text);
    if (game.description && (game.description.length > 600 || game.description.split('\n').length > 10)) {
      text.classList.add('collapsed');
      var more = el('button', 'btn btn-secondary btn-xs read-more', 'Read more');
      more.type = 'button';
      more.addEventListener('click', function () {
        var collapsed = text.classList.toggle('collapsed');
        more.textContent = collapsed ? 'Read more' : 'Show less';
      });
      about.appendChild(more);
    }
    var stats = el('div', 'game-stats');
    [
      ['Playing', number(game.playing)],
      ['Servers', number(game.servers.length)],
      ['Server Size', game.maxPlayers ? number(game.maxPlayers) : '–'],
      ['Badges', page && page.badges ? number(page.badges.length) : '–'],
      ['Passes', page && page.passes ? number(page.passes.length) : '–'],
    ].forEach(function (pair) {
      var stat = el('div', 'game-stat');
      stat.appendChild(el('div', 'label', pair[0]));
      stat.appendChild(el('div', 'value', pair[1]));
      stats.appendChild(stat);
    });
    about.appendChild(stats);
    panel.appendChild(about);

    if (badges.length) {
      var section = el('section', 'section');
      var header = el('div', 'container-header');
      header.appendChild(el('h2', null, 'Badges'));
      section.appendChild(header);
      var box = el('div', 'section-content');
      var list = el('ul', 'item-list');
      badges.forEach(function (badge) {
        var row = el('li', 'badge-row');
        row.appendChild(itemIcon(game, badge));
        var info = el('div');
        info.appendChild(el('h4', null, badge.name));
        if (badge.description) info.appendChild(el('p', null, badge.description));
        row.appendChild(info);
        list.appendChild(row);
      });
      box.appendChild(list);
      section.appendChild(box);
      panel.appendChild(section);
    }

    var others = sorted(allGames.filter(function (g) { return g.placeId !== game.placeId; }), 'popular').slice(0, 12);
    if (others.length) {
      panel.appendChild(gameRow('Recommended Games', others, null));
      loadVotes();
    }
  }

  function itemIcon(game, item) {
    if (!item.icon) return el('span', 'icon-blank');
    var img = el('img');
    img.src = '/api/icon/' + game.placeId + '/' + item.icon;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', function () { img.replaceWith(el('span', 'icon-blank')); });
    return img;
  }

  function storePanel(panel, game, passes, page) {
    if (!passes.length) {
      panel.appendChild(emptyState(page && page.passes === null ? 'Passes are still loading. Check back in a minute.' : 'This game has no passes.'));
      return;
    }
    var section = el('section', 'section');
    var header = el('div', 'container-header');
    header.appendChild(el('h2', null, 'Passes for this game'));
    section.appendChild(header);
    section.appendChild(el('p', 'text-secondary', 'Buy passes in game with R$ you earn by playing.'));
    var grid = el('div', 'pass-grid');
    passes.forEach(function (pass) {
      var card = el('div', 'pass-card');
      card.appendChild(itemIcon(game, pass));
      card.appendChild(el('h4', null, pass.name));
      if (pass.description) card.title = pass.description;
      card.appendChild(el('div', 'price', pass.price > 0 ? 'R$ ' + number(pass.price) : 'Free'));
      grid.appendChild(card);
    });
    section.appendChild(grid);
    panel.appendChild(section);
  }

  function serversPanel(panel, game) {
    if (!game.servers.length) {
      panel.appendChild(emptyState('No one is playing right now. Press Play to start a server.'));
      return;
    }
    var box = el('div', 'section-content');
    var list = el('ul', 'item-list');
    game.servers.forEach(function (server, index) {
      var row = el('li', 'server-row');
      var info = el('div', 'server-info');
      info.appendChild(el('div', null, 'Server ' + (index + 1)));
      var max = server.maxPlayers || game.maxPlayers;
      info.appendChild(el('div', 'text-secondary', max ? number(server.playing) + ' of ' + number(max) + ' people max' : plural(server.playing, 'person', 'people')));
      var bar = el('div', 'vote-bar');
      var fill = el('div', 'vote-fill');
      fill.style.width = max ? Math.min(100, Math.round((server.playing / max) * 100)) + '%' : '0';
      bar.appendChild(fill);
      info.appendChild(bar);
      row.appendChild(info);
      var join = el('button', 'btn btn-secondary btn-sm', 'Join');
      join.type = 'button';
      join.addEventListener('click', function () { play(game, server.id); });
      row.appendChild(join);
      list.appendChild(row);
    });
    box.appendChild(list);
    panel.appendChild(box);
  }

  function downloadPage() {
    loadGames().then(showOnline);
    getJson('release').then(function (result) {
      var info = result.ok && result.data;
      var node = $('release-info');
      if (!info || !node) return;
      var parts = ['Version ' + info.version];
      if (info.size) parts.push(Math.round(info.size / 1048576) + ' MB');
      if (info.date) {
        var date = new Date(info.date);
        if (!isNaN(date)) parts.push('Updated ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
      }
      node.textContent = parts.join(' · ') + ' · Windows 10 and 11';
    });
  }

  function simplePage() { loadGames().then(showOnline); }

  // ---- account (functions/api: lib/account.js) ----
  // /api/me says who is signed in (the session is an HttpOnly cookie). The
  // answer is kept in this tab for 30 seconds, so moving between pages
  // doesn't ask the game server every time.
  var ME_KEY = 'rbx2017.me';
  var NAME_RULE = /^[A-Za-z0-9_]{3,20}$/;
  var MIN_PASSWORD = 6;

  function storedMe() {
    try {
      var item = JSON.parse(sessionStorage.getItem(ME_KEY) || 'null');
      return item && Date.now() - item.at < 30000 ? item.data : null;
    } catch (error) { return null; }
  }
  function storeMe(data) {
    try {
      if (data) sessionStorage.setItem(ME_KEY, JSON.stringify({ at: Date.now(), data: data }));
      else sessionStorage.removeItem(ME_KEY);
    } catch (error) { /* private window: ask each time */ }
  }

  var meLoading = null;
  // -> { account|null, robux|null, turnstile|null, offline? }
  function loadMe(fresh) {
    if (meLoading && !fresh) return meLoading;
    var kept = fresh ? null : storedMe();
    meLoading = kept ? Promise.resolve(kept) : fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (!response.ok || !data) return { account: null, robux: null, turnstile: data && data.turnstile, offline: true };
        storeMe(data);
        return data;
      });
    }, function () { return { account: null, robux: null, offline: true }; });
    return meLoading;
  }

  // A same-site path from ?next=, or null.
  function safeNext() {
    var next = new URLSearchParams(location.search).get('next') || '';
    return /^\/(?![\/\\])[A-Za-z0-9\-_\/.?=&#%]*$/.test(next) ? next : null;
  }

  function rbxBadge(big) {
    var badge = el('span', 'rbx-badge' + (big ? ' big' : ''), 'R$');
    badge.setAttribute('aria-hidden', 'true');
    return badge;
  }

  function post(path, body) {
    return fetch('/api/' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) { return { ok: response.ok, data: data || {} }; });
    }, function () { return { ok: false, data: { error: "Couldn't reach the site. Check your connection." } }; });
  }

  function logOut() {
    post('logout').then(function () {
      storeMe(null);
      location.href = '/';
    });
  }

  var openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.list.classList.add('hidden');
    openMenu.button.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeMenu(); });

  function renderHeaderAccount(me) {
    var box = $('header-account');
    renderLeftCol(me);
    if (!box) return;
    box.textContent = '';
    if (!me || me.offline) return;
    if (!me.account) {
      var page = document.body.dataset.page;
      if (page !== 'login') {
        var login = el('a', 'header-link', 'Log In');
        login.href = page === 'home' || page === 'signup' ? '/login' : '/login?next=' + encodeURIComponent(location.pathname + location.search);
        box.appendChild(login);
      }
      if (page !== 'signup') {
        var signup = el('a', 'header-link header-signup', 'Sign Up');
        signup.href = '/signup';
        box.appendChild(signup);
      }
      return;
    }
    if (me.robux) {
      var robux = el('a', 'header-robux');
      robux.href = '/home#robux-card';
      robux.title = 'Your R$';
      robux.appendChild(rbxBadge());
      robux.appendChild(el('span', null, number(me.robux.balance)));
      box.appendChild(robux);
    }
    var gear = el('a', 'header-icon settings');
    gear.href = '/my/account';
    gear.title = 'Settings';
    gear.setAttribute('aria-label', 'Settings');
    gear.appendChild(icon('cog'));
    box.appendChild(gear);
    var wrap = el('div', 'user-menu');
    var button = el('button', 'user-menu-button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(el('span', 'user-menu-name', me.account.name));
    var personIcon = icon('person');
    personIcon.setAttribute('class', 'icon user-menu-icon');
    button.appendChild(personIcon);
    button.setAttribute('aria-label', me.account.name);
    button.appendChild(el('span', 'user-menu-count hidden'));
    button.appendChild(icon('caret'));
    var list = el('div', 'user-menu-list hidden');
    function link(label, href, countId) {
      var node = el('a', null, label);
      node.href = href;
      if (countId) {
        var count = el('span', 'menu-count hidden');
        count.id = countId;
        node.appendChild(count);
      }
      list.appendChild(node);
    }
    link('Home', '/home');
    link('Profile', '/users/' + me.account.userId + '/profile');
    link('Friends', '/users/friends', 'menu-friends');
    link('Messages', '/my/messages', 'menu-messages');
    link('Chat', '/chat', 'menu-chat');
    link('Groups', '/groups');
    link('Trades', '/my/trades');
    link('Inventory', '/users/' + me.account.userId + '/inventory');
    link('Settings', '/my/account');
    var out = el('button', null, 'Log Out');
    out.type = 'button';
    out.addEventListener('click', logOut);
    list.appendChild(out);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var opening = list.classList.contains('hidden');
      closeMenu();
      if (!opening) return;
      list.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
      openMenu = { list: list, button: button };
    });
    wrap.appendChild(button);
    wrap.appendChild(list);
    box.appendChild(wrap);
  }

  // Cloudflare Turnstile, only when the site has keys for it.
  var turnstileLoading = null;
  function loadTurnstile() {
    if (!turnstileLoading) {
      turnstileLoading = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = function () { if (window.turnstile) resolve(window.turnstile); else reject(new Error('no turnstile')); };
        script.onerror = function () { reject(new Error('no turnstile')); };
        document.head.appendChild(script);
      });
    }
    return turnstileLoading;
  }

  // The log in or sign up form, into container.
  function authForm(container, mode, me) {
    var signup = mode === 'signup';
    var form = el('form', 'auth-form');
    form.noValidate = true;
    function field(label, type, autocomplete, maxLength) {
      var wrap = el('label', 'field');
      wrap.appendChild(el('span', null, label));
      var input = el('input');
      input.type = type;
      input.autocomplete = autocomplete;
      input.maxLength = maxLength;
      input.required = true;
      if (type === 'text') { input.spellcheck = false; input.autocapitalize = 'off'; }
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    }
    var name = field('Username', 'text', 'username', 20);
    var password = field(signup ? 'Password (at least ' + MIN_PASSWORD + ' characters)' : 'Password', 'password', signup ? 'new-password' : 'current-password', 200);
    var again = signup ? field('Password again', 'password', 'new-password', 200) : null;
    if (signup) form.appendChild(el('p', 'field-note', "Don't use your real name. This account is separate from Roblox."));

    var check = null;
    var checkId = null;
    var checkToken = '';
    if (signup && me && me.turnstile) {
      check = el('div', 'turnstile');
      form.appendChild(check);
      loadTurnstile().then(function (turnstile) {
        checkId = turnstile.render(check, {
          sitekey: me.turnstile,
          theme: 'light',
          callback: function (token) { checkToken = token; },
          'expired-callback': function () { checkToken = ''; },
          'error-callback': function () { checkToken = ''; },
        });
      }, function () {
        check.textContent = "The human check didn't load. Turn off blockers for this site and reload.";
      });
    }

    var error = el('p', 'form-error hidden');
    error.setAttribute('role', 'alert');
    form.appendChild(error);
    var submit = el('button', 'btn btn-green btn-lg btn-block', signup ? 'Sign Up' : 'Log In');
    submit.type = 'submit';
    form.appendChild(submit);
    var other = el('p', 'auth-other');
    other.appendChild(document.createTextNode(signup ? 'Have an account? ' : 'New here? '));
    var link = el('a', null, signup ? 'Log in' : 'Sign up');
    link.href = signup ? '/login' : '/signup';
    other.appendChild(link);
    form.appendChild(other);

    function fail(text, input) {
      error.textContent = text;
      error.classList.remove('hidden');
      if (input) input.focus();
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      error.classList.add('hidden');
      var who = name.value.trim();
      if (!NAME_RULE.test(who)) return fail('Usernames are 3 to 20 letters, digits or underscores.', name);
      if (!password.value) return fail('Type your password.', password);
      if (signup && password.value.length < MIN_PASSWORD) return fail('Pick a password of at least ' + MIN_PASSWORD + ' characters.', password);
      if (signup && again.value !== password.value) return fail("The passwords don't match.", again);
      if (check && !checkToken) return fail('Finish the human check first.');
      submit.disabled = true;
      submit.textContent = signup ? 'Signing up...' : 'Logging in...';
      post(signup ? 'signup' : 'login', { name: who, password: password.value, turnstile: checkToken || undefined }).then(function (result) {
        if (result.ok) {
          storeMe(null);
          location.href = safeNext() || '/home';
          return;
        }
        submit.disabled = false;
        submit.textContent = signup ? 'Sign Up' : 'Log In';
        if (check && window.turnstile && checkId !== null) { window.turnstile.reset(checkId); checkToken = ''; }
        fail(result.data.error || 'That did not work. Try again.');
      });
    });

    container.textContent = '';
    container.appendChild(form);
    if (!('ontouchstart' in window) && container.closest('.auth-card')) name.focus();
  }

  function authPage(mode) {
    return function () {
      loadGames().then(showOnline);
      loadMe(true).then(function (me) {
        if (me.account) { location.replace(safeNext() || '/home'); return; }
        authForm($('auth-form'), mode, me);
      });
    };
  }

  // ---- the signed-in home page ----
  var PRESENCE_TEXT = { studio: 'In Studio', online: 'Online', offline: 'Offline' };

  function avatarPicture(userId, name, className) {
    var box = el('span', className);
    box.appendChild(el('span', 'avatar-letter', String(name || '?').charAt(0).toUpperCase()));
    var img = el('img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', function () { box.classList.add('has-picture'); });
    img.addEventListener('error', function () { img.remove(); });
    img.src = '/api/avatar/' + userId;
    box.appendChild(img);
    return box;
  }

  function robuxRow(what, side, sideClass) {
    var row = el('li');
    row.appendChild(el('span', 'what', what));
    row.appendChild(el('span', 'side' + (sideClass ? ' ' + sideClass : ''), side));
    return row;
  }

  function robuxCard(robux) {
    var card = $('robux-card');
    if (!robux) { card.classList.add('hidden'); return; }
    $('robux-balance').textContent = number(robux.balance);
    var earn = robux.earn || {};
    var list = $('robux-earn');
    list.textContent = '';
    if (earn.daily > 0) list.appendChild(robuxRow('Daily bonus: R$ ' + earn.daily, earn.dailyDone ? 'Got it today' : 'Not yet', earn.dailyDone ? 'done' : ''));
    if (earn.playAmount > 0) list.appendChild(robuxRow('R$ ' + earn.playAmount + ' per ' + earn.playEvery + ' min played', number(earn.playToday) + ' / ' + number(earn.playMax) + ' today', earn.playToday >= earn.playMax ? 'done' : ''));
    if (earn.badge > 0) list.appendChild(robuxRow('Each badge you earn', 'R$ ' + earn.badge));
    var history = (robux.history || []).slice(0, 6);
    $('robux-history-title').classList.toggle('hidden', !history.length);
    var past = $('robux-history');
    past.textContent = '';
    history.forEach(function (entry) {
      past.appendChild(robuxRow(entry.reason || (entry.amount > 0 ? 'Added' : 'Spent'), (entry.amount > 0 ? '+' : '−') + number(Math.abs(entry.amount)), entry.amount > 0 ? 'plus' : 'minus'));
    });
  }

  function friendCard(friend) {
    var playing = friend.presence === 'game' && friend.placeId;
    var card = el('a', 'friend p-' + friend.presence);
    if (playing) {
      card.href = gameUrl({ placeId: friend.placeId, name: friend.gameName || '' });
      card.title = 'Playing ' + (friend.gameName || 'a game');
    } else {
      card.href = profileUrl(friend.userId);
    }
    var picture = avatarPicture(friend.userId, friend.name, 'friend-picture');
    picture.appendChild(el('span', 'presence-dot'));
    card.appendChild(picture);
    card.appendChild(el('span', 'friend-name', friend.name));
    card.appendChild(el('span', 'friend-status', friend.presence === 'game' ? (friend.gameName ? friend.gameName : 'In a game') : PRESENCE_TEXT[friend.presence]));
    if (playing && friend.gameId) {
      var join = el('button', 'btn btn-green btn-xs friend-join', 'Join');
      join.type = 'button';
      join.addEventListener('click', function (event) {
        event.preventDefault();
        play({ placeId: friend.placeId, name: friend.gameName || 'the game' }, friend.gameId);
      });
      card.appendChild(join);
    }
    return card;
  }

  function friendsSection() {
    var row = $('friends-row');
    fetch('/api/friends', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) { return response.ok ? data : null; });
    }, function () { return null; }).then(function (data) {
      row.textContent = '';
      if (!data) { row.appendChild(emptyState("Couldn't load your friends.")); return; }
      var online = data.friends.filter(function (friend) { return friend.presence !== 'offline'; }).length;
      $('friends-title').textContent = 'Friends (' + data.friends.length + ')';
      if (online) $('hello-sub').textContent = plural(online, 'friend', 'friends') + ' online';
      if (!data.friends.length) {
        row.appendChild(emptyState('No friends yet. Find players on the Friends page.'));
        return;
      }
      data.friends.slice(0, 30).forEach(function (friend) { row.appendChild(friendCard(friend)); });
      if (data.requests > 0) $('friends-title').textContent += ' · ' + plural(data.requests, 'request', 'requests');
    });
  }

  function accountHomePage() {
    loadMe(true).then(function (me) {
      if (!me.account) {
        if (!me.offline) location.replace('/login?next=%2Fhome');
        else $('hello-name').textContent = "The game server isn't answering. Try again in a minute.";
        return;
      }
      $('hello-name').classList.remove('loading');
      $('hello-name').textContent = 'Hello, ' + me.account.name + '!';
      $('hello-picture').appendChild(avatarPicture(me.account.userId, me.account.name, 'hello-avatar'));
      robuxCard(me.robux);
      friendsSection();
    });
    var rows = $('account-rows');
    skeletonCards(rows.appendChild(el('div', 'game-row-track')), 6);
    loadGames().then(function (result) {
      showOnline(result);
      return within(loadVotes(), 2500).then(function () { return result; });
    }).then(function (result) {
      rows.textContent = '';
      offlineAlert(result, rows);
      if (!result.games || !result.games.length) return;
      rows.appendChild(gameRow('Popular', sorted(result.games, 'popular').slice(0, 18), '/games?sort=popular'));
      rows.appendChild(gameRow('Recently Added', sorted(result.games, 'recent').slice(0, 18), '/games?sort=recent'));
    });
  }

  // ---- catalog, item pages, inventories, settings (lib/account.js shop routes) ----
  var SHOP_CATEGORIES = [
    ['hats', 'Hats'], ['hair', 'Hair'], ['faces', 'Faces'], ['heads', 'Heads'], ['shirts', 'Shirts'], ['pants', 'Pants'],
    ['tshirts', 'T-Shirts'], ['packages', 'Packages'], ['face', 'Face Accessories'], ['neck', 'Neck'], ['shoulder', 'Shoulder'],
    ['front', 'Front'], ['back', 'Back'], ['waist', 'Waist'], ['torsos', 'Torsos'], ['rightarms', 'Right Arms'],
    ['leftarms', 'Left Arms'], ['rightlegs', 'Right Legs'], ['leftlegs', 'Left Legs'], ['gear', 'Gear'], ['limiteds', 'Limiteds'],
  ];
  var INVENTORY_CATEGORIES = SHOP_CATEGORIES.filter(function (entry) { return entry[0] !== 'limiteds'; });

  function categoryKnown(list, key) {
    return list.some(function (entry) { return entry[0] === key; });
  }

  function itemPictureUrl(item) {
    return '/api/' + (item.kind === 'bundle' ? 'bundle' : 'asset') + '-thumb/' + encodeURIComponent(item.id);
  }

  // Packages and body parts (sold in their package) are bought from their card.
  function itemPageUrl(item) {
    return item.kind === 'bundle' || item.packageId ? null : '/catalog/' + item.id + '/' + slug(item.name);
  }

  // What a card's Buy button buys: the item, or the package a body part comes in.
  function purchaseOf(item) {
    if (item.kind === 'bundle') return { kind: 'bundle', id: item.id, price: item.price, name: item.name };
    if (item.packageId) return { kind: 'bundle', id: item.packageId, price: item.packagePrice, name: item.packageName || 'its package' };
    return { kind: 'asset', id: item.id, price: item.price, name: item.name };
  }

  function priceNode(price) {
    var node = el('div', 'item-price');
    if (price === null || price === undefined) { node.classList.add('off-sale'); node.textContent = 'Off Sale'; return node; }
    if (price === 0) { node.textContent = 'Free'; return node; }
    var badge = rbxBadge();
    badge.classList.add('small');
    node.appendChild(badge);
    node.appendChild(el('span', null, number(price)));
    return node;
  }

  // A 2017 catalog card: the picture (Limited on it), the name, who made it
  // or how many are left, and the price. tag: "li" in the catalog's list.
  function itemCard(item, signedIn, status, tag) {
    var link = itemPageUrl(item);
    var card = el(tag || 'div', 'item-card');
    var main = el(link ? 'a' : 'div');
    if (link) main.href = link;
    var thumb = el('span', 'item-card-thumb');
    var img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = itemPictureUrl(item);
    img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
    thumb.appendChild(img);
    if (item.limited) thumb.appendChild(el('span', 'item-tag', 'Limited'));
    main.appendChild(thumb);
    var name = el('div', 'item-card-name', item.name || 'Item ' + item.id);
    name.title = item.name || '';
    main.appendChild(name);
    card.appendChild(main);
    var stock = item.limitedInfo;
    if (stock && stock.from === 'stock' && stock.remaining > 0) {
      card.appendChild(el('div', 'item-card-label', 'Remaining: ' + number(stock.remaining)));
    } else if (item.creator) {
      var by = el('div', 'item-card-label', 'By ');
      var who = el('a', null, item.creator);
      who.href = '/catalog?category=all&creator=' + encodeURIComponent(item.creator) + '&era=any';
      by.appendChild(who);
      card.appendChild(by);
    } else if (item.typeName) {
      card.appendChild(el('div', 'item-card-label', item.typeName));
    }
    var buying = purchaseOf(item);
    var priceEl = null;
    if (item.owned === true && !item.limited) card.appendChild(el('div', 'item-owned', 'Owned'));
    else if (item.price !== undefined || item.packageId) priceEl = card.appendChild(priceNode(buying.price));
    if (item.packageId) card.title = (item.name || '') + ' (from ' + buying.name + ')';
    if (signedIn && (item.owned === false || item.limited) && buying.price !== null && buying.price !== undefined && !link) {
      var button = el('button', 'btn btn-green btn-xs item-card-buy', buying.price === 0 ? 'Get' : 'Buy');
      button.type = 'button';
      button.addEventListener('click', function (event) {
        event.preventDefault();
        button.disabled = true;
        buyFlow(buying, status).then(function (bought) {
          button.disabled = false;
          if (!bought) return;
          item.owned = true;
          if (priceEl) priceEl.replaceWith(el('div', 'item-owned', 'Owned'));
          button.remove();
        });
      });
      card.appendChild(button);
    }
    return card;
  }

  // ---- the catalog (2017's: a category tree, filters, sorts and pages) ----
  // Answers come from /api/catalog/search (the game server's lib/catalogsearch.js).
  var CATALOG = [
    ['all', 'All Categories', [['all', 'All Categories']]],
    ['featured', 'Featured', [['all', 'All Featured Items'], ['accessories', 'Featured Accessories'], ['faces', 'Featured Faces'], ['gear', 'Featured Gear'], ['packages', 'Featured Packages']]],
    ['collectibles', 'Collectibles', [['all', 'All Collectibles'], ['accessories', 'Collectible Accessories'], ['faces', 'Collectible Faces'], ['gear', 'Collectible Gear']]],
    ['clothing', 'Clothing', [['all', 'All Clothing'], ['shirts', 'Shirts'], ['tshirts', 'T-Shirts'], ['pants', 'Pants'], ['packages', 'Packages']]],
    ['bodyparts', 'Body Parts', [['all', 'All Body Parts'], ['heads', 'Heads'], ['faces', 'Faces'], ['packages', 'Packages']]],
    ['gear', 'Gear', [['all', 'All Gear'], ['building', 'Building'], ['explosive', 'Explosive'], ['melee', 'Melee'], ['musical', 'Musical'], ['navigation', 'Navigation'], ['powerup', 'Power Up'], ['ranged', 'Ranged'], ['social', 'Social'], ['transport', 'Transport']]],
    ['accessories', 'Accessories', [['all', 'All Accessories'], ['hats', 'Hats'], ['hair', 'Hair'], ['face', 'Face'], ['neck', 'Neck'], ['shoulder', 'Shoulder'], ['front', 'Front'], ['back', 'Back'], ['waist', 'Waist']]],
  ];
  var CATALOG_SORTS = [['relevance', 'Relevance'], ['favorited', 'Most Favorited'], ['bestselling', 'Bestselling'], ['updated', 'Recently Updated'], ['price-asc', 'Price (Low to High)'], ['price-desc', 'Price (High to Low)']];
  // Links from the old catalog (?category=hats) and the launcher.
  var OLD_CATEGORIES = {
    hats: ['accessories', 'hats'], hair: ['accessories', 'hair'], face: ['accessories', 'face'], neck: ['accessories', 'neck'],
    shoulder: ['accessories', 'shoulder'], front: ['accessories', 'front'], back: ['accessories', 'back'], waist: ['accessories', 'waist'],
    faces: ['bodyparts', 'faces'], heads: ['bodyparts', 'heads'], packages: ['bodyparts', 'packages'], torsos: ['bodyparts', 'packages'],
    rightarms: ['bodyparts', 'packages'], leftarms: ['bodyparts', 'packages'], rightlegs: ['bodyparts', 'packages'], leftlegs: ['bodyparts', 'packages'],
    shirts: ['clothing', 'shirts'], pants: ['clothing', 'pants'], tshirts: ['clothing', 'tshirts'], limiteds: ['collectibles', 'all'],
  };
  // An item's place in the tree, by asset type (the item page's crumbs).
  var TYPE_PLACE = {
    8: ['accessories', 'hats'], 41: ['accessories', 'hair'], 42: ['accessories', 'face'], 43: ['accessories', 'neck'], 44: ['accessories', 'shoulder'],
    45: ['accessories', 'front'], 46: ['accessories', 'back'], 47: ['accessories', 'waist'], 17: ['bodyparts', 'heads'], 18: ['bodyparts', 'faces'],
    11: ['clothing', 'shirts'], 2: ['clothing', 'tshirts'], 12: ['clothing', 'pants'], 19: ['gear', 'all'], 32: ['bodyparts', 'packages'],
  };

  function catalogCategory(key) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i][0] === key) return CATALOG[i];
    return null;
  }
  function catalogSubName(category, sub) {
    var entry = catalogCategory(category);
    var found = entry && entry[2].filter(function (pair) { return pair[0] === sub; })[0];
    return found ? found[1] : '';
  }

  // The search as the address says it.
  function catalogState(search) {
    var p = new URLSearchParams(search);
    var s = {
      category: p.get('category') || (p.get('keyword') || p.get('q') || p.get('creator') ? 'all' : 'featured'), sub: p.get('sub') || 'all',
      keyword: (p.get('keyword') || p.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      creator: (p.get('creator') || '').trim().slice(0, 20), min: p.get('min') || '', max: p.get('max') || '',
      free: p.get('free') === '1', sort: p.get('sort') || '', era: p.get('era') === 'any' ? 'any' : 'classic',
      unavailable: p.get('unavailable') === 'show', page: Math.min(400, Math.max(1, parseInt(p.get('page'), 10) || 1)),
    };
    if (OLD_CATEGORIES[s.category]) { s.sub = OLD_CATEGORIES[s.category][1]; s.category = OLD_CATEGORIES[s.category][0]; }
    if (s.category === 'gear' && !p.get('sub')) s.sub = 'all';
    var category = catalogCategory(s.category);
    if (!category) { s.category = 'featured'; category = catalogCategory('featured'); }
    if (!category[2].some(function (pair) { return pair[0] === s.sub; })) s.sub = 'all';
    if (!/^[A-Za-z0-9_ ]*$/.test(s.creator)) s.creator = '';
    if (!/^\d{1,8}$/.test(s.min)) s.min = '';
    if (!/^\d{1,8}$/.test(s.max)) s.max = '';
    if (!CATALOG_SORTS.some(function (pair) { return pair[0] === s.sort; })) s.sort = '';
    return s;
  }

  function catalogQuery(s) {
    var q = new URLSearchParams();
    if (s.category !== 'featured' || s.keyword || s.creator) q.set('category', s.category);
    if (s.sub !== 'all') q.set('sub', s.sub);
    if (s.keyword) q.set('keyword', s.keyword);
    if (s.creator) q.set('creator', s.creator);
    if (s.free) q.set('free', '1');
    else {
      if (s.min) q.set('min', s.min);
      if (s.max) q.set('max', s.max);
    }
    if (s.sort) q.set('sort', s.sort);
    if (s.era === 'any') q.set('era', 'any');
    if (s.unavailable) q.set('unavailable', 'show');
    if (s.page > 1) q.set('page', String(s.page));
    return q;
  }

  function radioList(name, options, current, onPick) {
    var list = el('ul', 'filter-list');
    options.forEach(function (option) {
      var item = el('li');
      var label = el('label');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = option[0];
      radio.checked = option[0] === current;
      radio.addEventListener('change', function () { if (radio.checked) onPick(option[0]); });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(option[1]));
      item.appendChild(label);
      if (option[2]) item.appendChild(option[2]);
      list.appendChild(item);
    });
    return list;
  }

  function catalogPage() {
    var state = catalogState(location.search);
    var me = null;
    var grid = $('catalog-grid');
    var status = $('catalog-status');
    var pager = $('catalog-pager');
    var asked = 0;

    var inCategory = $('catalog-in');
    CATALOG.forEach(function (entry) {
      var option = el('option', null, entry[1]);
      option.value = entry[0];
      inCategory.appendChild(option);
    });
    var sortSelect = $('catalog-sort');
    CATALOG_SORTS.forEach(function (pair) {
      var option = el('option', null, pair[1]);
      option.value = pair[0];
      sortSelect.appendChild(option);
    });
    sortSelect.addEventListener('change', function () { change({ sort: sortSelect.value, page: 1 }); });
    $('catalog-search').addEventListener('submit', function (event) {
      event.preventDefault();
      var category = inCategory.value === 'featured' ? 'all' : inCategory.value;
      change({ keyword: $('catalog-q').value.replace(/\s+/g, ' ').trim().slice(0, 50), category: category, sub: category === state.category ? state.sub : 'all', page: 1, sort: '' });
    });
    var toggle = $('catalog-filters-toggle');
    toggle.addEventListener('click', function () {
      var open = !$('search-options').classList.contains('open');
      $('search-options').classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    function change(patch) {
      Object.keys(patch).forEach(function (key) { state[key] = patch[key]; });
      var query = catalogQuery(state).toString();
      history.pushState(null, '', '/catalog' + (query ? '?' + query : ''));
      draw();
      load();
    }
    window.addEventListener('popstate', function () {
      state = catalogState(location.search);
      draw();
      load();
    });

    function drawTree() {
      var menu = $('catalog-cats');
      menu.textContent = '';
      CATALOG.forEach(function (entry) {
        var item = el('li');
        var head = el('div', 'cat-head');
        var link = el('a', null, entry[0] === 'all' ? 'View All Items' : entry[1]);
        link.href = '/catalog?category=' + entry[0];
        if (state.category === entry[0]) link.setAttribute('aria-current', 'true');
        link.addEventListener('click', function (event) {
          event.preventDefault();
          change({ category: entry[0], sub: 'all', page: 1 });
        });
        head.appendChild(link);
        var subs = null;
        if (entry[2].length > 1) {
          var open = state.category === entry[0];
          var plus = el('button', 'cat-toggle', open ? '−' : '+');
          plus.type = 'button';
          plus.setAttribute('aria-label', (open ? 'Hide ' : 'Show ') + entry[1]);
          plus.setAttribute('aria-expanded', open ? 'true' : 'false');
          head.appendChild(plus);
          subs = el('ul', 'cat-subs' + (open ? '' : ' hidden'));
          entry[2].forEach(function (pair) {
            var subItem = el('li');
            var subLink = el('a', null, pair[1]);
            subLink.href = '/catalog?category=' + entry[0] + (pair[0] === 'all' ? '' : '&sub=' + pair[0]);
            if (state.category === entry[0] && state.sub === pair[0]) subLink.setAttribute('aria-current', 'true');
            subLink.addEventListener('click', function (event) {
              event.preventDefault();
              change({ category: entry[0], sub: pair[0], page: 1 });
            });
            subItem.appendChild(subLink);
            subs.appendChild(subItem);
          });
          plus.addEventListener('click', function () {
            var opening = subs.classList.contains('hidden');
            subs.classList.toggle('hidden', !opening);
            plus.textContent = opening ? '−' : '+';
            plus.setAttribute('aria-expanded', opening ? 'true' : 'false');
          });
        }
        item.appendChild(head);
        if (subs) item.appendChild(subs);
        menu.appendChild(item);
      });
    }

    function drawFilters() {
      var box = $('catalog-filters');
      box.textContent = '';
      function label(text) { box.appendChild(el('div', 'filter-label', text)); }

      label('Creator');
      var creatorName = el('input');
      creatorName.type = 'text';
      creatorName.placeholder = 'Username';
      creatorName.maxLength = 20;
      creatorName.setAttribute('aria-label', 'Creator name');
      var robloxMade = /^roblox$/i.test(state.creator);
      if (state.creator && !robloxMade) creatorName.value = state.creator;
      var creatorGo = el('button', 'btn btn-secondary btn-xs', 'Go');
      creatorGo.type = 'button';
      function pickCreator() {
        var name = creatorName.value.trim().replace(/[^A-Za-z0-9_ ]/g, '');
        if (name) change({ creator: name, page: 1, era: 'any' });
      }
      creatorGo.addEventListener('click', pickCreator);
      creatorName.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); pickCreator(); } });
      var creatorRow = el('div', 'filter-inline');
      creatorRow.appendChild(creatorName);
      creatorRow.appendChild(creatorGo);
      box.appendChild(radioList('creator', [['', 'All Creators'], ['roblox', 'Roblox'], ['custom', '', creatorRow]],
        !state.creator ? '' : robloxMade ? 'roblox' : 'custom', function (value) {
          if (value === 'custom') { creatorName.focus(); return; }
          change({ creator: value === 'roblox' ? 'Roblox' : '', page: 1 });
        }));

      label('Price');
      var min = el('input');
      min.type = 'number';
      min.min = '0';
      min.placeholder = 'Min';
      min.setAttribute('aria-label', 'Lowest price');
      min.value = state.min;
      var max = el('input');
      max.type = 'number';
      max.min = '0';
      max.placeholder = 'Max';
      max.setAttribute('aria-label', 'Highest price');
      max.value = state.max;
      var priceGo = el('button', 'btn btn-secondary btn-xs', 'Go');
      priceGo.type = 'button';
      function pickPrice() {
        var low = /^\d{1,8}$/.test(min.value) ? min.value : '';
        var high = /^\d{1,8}$/.test(max.value) ? max.value : '';
        change({ min: low, max: high, free: false, page: 1 });
      }
      priceGo.addEventListener('click', pickPrice);
      [min, max].forEach(function (input) {
        input.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); pickPrice(); } });
      });
      var priceRow = el('div', 'filter-inline');
      priceRow.appendChild(min);
      priceRow.appendChild(el('span', 'to', 'to'));
      priceRow.appendChild(max);
      priceRow.appendChild(priceGo);
      box.appendChild(radioList('price', [['any', 'Any Price'], ['free', 'Free'], ['range', 'R$', priceRow]],
        state.free ? 'free' : state.min || state.max ? 'range' : 'any', function (value) {
          if (value === 'range') { min.focus(); return; }
          change({ free: value === 'free', min: '', max: '', page: 1 });
        }));

      label('Made');
      box.appendChild(radioList('era', [['classic', 'Before 2018'], ['any', 'Any year']], state.era, function (value) {
        change({ era: value, page: 1 });
      }));

      label('Unavailable Items');
      box.appendChild(radioList('unavailable', [['hide', 'Hide'], ['show', 'Show']], state.unavailable ? 'show' : 'hide', function (value) {
        change({ unavailable: value === 'show', page: 1 });
      }));
    }

    function crumb(text, onClick, className) {
      var item = el('li');
      var button = el('button', className || null, text);
      button.type = 'button';
      button.addEventListener('click', onClick);
      item.appendChild(button);
      return item;
    }

    function drawCrumbs() {
      var list = $('catalog-crumbs');
      list.textContent = '';
      var category = catalogCategory(state.category);
      list.appendChild(crumb(category[1], function () { change({ sub: 'all', page: 1 }); }));
      if (state.sub !== 'all') list.appendChild(crumb(catalogSubName(state.category, state.sub), function () { change({ page: 1 }); }));
      if (state.creator) list.appendChild(crumb((/^roblox$/i.test(state.creator) ? 'Roblox' : state.creator), function () { change({ creator: '', page: 1 }); }, 'crumb-filter'));
      if (state.free) list.appendChild(crumb('Free', function () { change({ free: false, page: 1 }); }, 'crumb-filter'));
      else if (state.min || state.max) {
        var text = state.min && state.max ? 'R$ ' + number(state.min) + ' - ' + number(state.max) : state.min ? 'R$ ' + number(state.min) + ' and up' : 'R$ ' + number(state.max) + ' and below';
        list.appendChild(crumb(text, function () { change({ min: '', max: '', page: 1 }); }, 'crumb-filter'));
      }
      if (state.era === 'any') list.appendChild(crumb('Any year', function () { change({ era: 'classic', page: 1 }); }, 'crumb-filter'));
      if (state.unavailable) list.appendChild(crumb('Unavailable shown', function () { change({ unavailable: false, page: 1 }); }, 'crumb-filter'));
      if (state.keyword) list.appendChild(crumb('“' + state.keyword + '”', function () { $('catalog-q').value = ''; change({ keyword: '', page: 1, sort: '' }); }, 'crumb-filter'));
    }

    function draw() {
      $('catalog-q').value = state.keyword;
      inCategory.value = state.category;
      sortSelect.value = state.sort || (state.keyword ? 'relevance' : 'favorited');
      drawTree();
      drawFilters();
      drawCrumbs();
      var featured = state.category === 'featured' && state.sub === 'all' && !state.keyword && state.page === 1;
      $('catalog-featured').classList.toggle('hidden', !featured);
      var title = state.keyword ? '“' + state.keyword + '”' : state.sub !== 'all' ? catalogSubName(state.category, state.sub) : catalogCategory(state.category)[1];
      document.title = title + ' - Catalog - rbx2017';
    }

    function drawPager(page, pages) {
      pager.textContent = '';
      pager.classList.toggle('hidden', pages <= 1);
      if (pages <= 1) return;
      function arrow(name, label, target, off) {
        var button = el('button');
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.disabled = off;
        button.appendChild(icon(name));
        button.addEventListener('click', function () { change({ page: target }); scrollTo(0, 0); });
        pager.appendChild(button);
      }
      arrow('first', 'First page', 1, page <= 1);
      arrow('prev', 'Previous page', page - 1, page <= 1);
      var input = el('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(pages);
      input.value = String(page);
      input.setAttribute('aria-label', 'Page');
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        var target = Math.min(pages, Math.max(1, parseInt(input.value, 10) || 1));
        change({ page: target });
        scrollTo(0, 0);
      });
      pager.appendChild(input);
      pager.appendChild(el('span', null, 'of ' + number(pages)));
      arrow('next', 'Next page', page + 1, page >= pages);
      arrow('last', 'Last page', pages, page >= pages);
    }

    function load() {
      var mine = ++asked;
      var query = catalogQuery(state);
      grid.classList.add('loading');
      status.className = 'catalog-status';
      status.textContent = state.keyword ? 'Searching…' : '';
      fetch('/api/catalog/search' + (query.toString() ? '?' + query : ''), { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) { return { ok: response.ok, data: data || {} }; });
      }, function () { return { ok: false, data: { error: "Couldn't reach the site." } }; }).then(function (result) {
        if (mine !== asked) return;
        grid.classList.remove('loading');
        grid.textContent = '';
        var count = $('catalog-count');
        count.textContent = '';
        if (!result.ok) {
          status.textContent = result.data.error || 'The catalog did not answer. Try again in a minute.';
          status.className = 'catalog-status error';
          drawPager(1, 1);
          return;
        }
        var data = result.data;
        var signedIn = Boolean(me && me.account);
        (data.items || []).forEach(function (item) { grid.appendChild(itemCard(item, signedIn, status, 'li')); });
        if (data.total) {
          var first = (data.page - 1) * data.perPage + 1;
          count.appendChild(el('span', null, number(first) + ' - ' + number(first + data.items.length - 1)));
          count.appendChild(el('span', null, 'of ' + plural(data.total, 'result', 'results')));
          status.textContent = signedIn ? '' : 'Log in to buy items.';
        } else {
          var none = el('li', 'empty-state catalog-empty', state.keyword ? 'No items found.' : 'Nothing here yet.');
          grid.appendChild(none);
          status.textContent = '';
        }
        if (data.page && data.page !== state.page) {
          state.page = data.page;
          history.replaceState(null, '', '/catalog' + (catalogQuery(state).toString() ? '?' + catalogQuery(state) : ''));
        }
        drawPager(data.page || 1, data.pages || 1);
      });
    }

    draw();
    loadMe().then(function (data) {
      me = data;
      load();
    });
  }

  // Buy after a confirmation -> Promise of true when bought.
  function buyFlow(buying, status) {
    var question = buying.price === 0 ? 'Get "' + buying.name + '" for free?' : 'Buy "' + buying.name + '" for R$ ' + number(buying.price) + '?';
    if (!window.confirm(question)) return Promise.resolve(false);
    if (status) { status.textContent = 'Buying…'; status.className = 'catalog-status'; }
    return post('buy', { kind: buying.kind, id: buying.id, price: buying.price }).then(function (result) {
      if (!result.ok) {
        if (status) { status.textContent = result.data.error || 'That did not work.'; status.className = 'catalog-status error'; }
        return false;
      }
      if (status) { status.textContent = 'You own "' + buying.name + '" now. Wear it from the Avatar tab in the launcher.'; status.className = 'catalog-status good'; }
      storeMe(null);
      loadMe(true).then(renderHeaderAccount);
      return true;
    });
  }


  function categoryNav(nav, list, current, hrefFor) {
    nav.textContent = '';
    list.forEach(function (entry) {
      var link = el('a', 'catalog-cat' + (entry[0] === current ? ' active' : ''), entry[1]);
      link.href = hrefFor(entry[0]);
      if (entry[0] === current) link.setAttribute('aria-current', 'page');
      nav.appendChild(link);
    });
  }


  function itemPage() {
    var root = $('item-root');
    var match = /^\/catalog\/(\d{1,15})/.exec(location.pathname);
    if (!match) { location.href = '/catalog'; return; }
    var id = match[1];
    Promise.all([fetch('/api/item/' + id, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) { return { ok: response.ok, data: data || {} }; });
    }, function () { return { ok: false, data: {} }; }), loadMe()]).then(function (results) {
      var result = results[0];
      var me = results[1];
      root.textContent = '';
      if (!result.ok) {
        root.appendChild(el('div', 'empty-state', result.data.error || 'This item could not be found.'));
        return;
      }
      var item = result.data;
      document.title = item.name + ' - rbx2017';
      var place = TYPE_PLACE[item.typeId];
      if (place) {
        var crumbs = el('ul', 'crumbs item-crumbs');
        [['Catalog', '/catalog'], [catalogCategory(place[0])[1], '/catalog?category=' + place[0]],
          place[1] !== 'all' ? [catalogSubName(place[0], place[1]), '/catalog?category=' + place[0] + '&sub=' + place[1]] : null]
          .filter(Boolean).forEach(function (pair) {
            var li = el('li');
            var a = el('a', null, pair[0]);
            a.href = pair[1];
            li.appendChild(a);
            crumbs.appendChild(li);
          });
        root.appendChild(crumbs);
      }
      var page = el('div', 'item-page');
      var picture = el('div', 'item-picture');
      var img = el('img');
      img.alt = item.name;
      img.src = itemPictureUrl({ kind: 'asset', id: item.id });
      picture.appendChild(img);
      if (item.limited) picture.appendChild(el('span', 'item-tag', 'Limited'));
      page.appendChild(picture);
      var info = el('div', 'item-info');
      info.appendChild(el('h1', 'item-title', item.name));
      var by = el('p', 'item-by');
      by.appendChild(document.createTextNode('By '));
      var creator = el('a', null, item.creator);
      creator.href = '/catalog?category=all&creator=' + encodeURIComponent(item.creator) + '&era=any';
      by.appendChild(creator);
      info.appendChild(by);

      var box = el('div', 'item-buy');
      var priceBox = el('div', 'item-buy-price');
      priceBox.appendChild(el('div', 'item-buy-label', item.limited ? 'Best Price' : 'Price'));
      priceBox.appendChild(priceNode(item.price));
      box.appendChild(priceBox);
      var status = el('p', 'catalog-status');
      var balanceNote = null;
      if (item.limited) {
        limitedBox(box, item, me, status);
      } else if (item.owned) {
        box.appendChild(el('div', 'item-owned big', 'You own this item'));
      } else if (!me || !me.account) {
        var login = el('a', 'btn btn-green', 'Log in to buy');
        login.href = '/login?next=' + encodeURIComponent(location.pathname);
        box.appendChild(login);
      } else if (item.price !== null) {
        var buy = el('button', 'btn btn-green', item.price === 0 ? 'Get' : 'Buy');
        buy.type = 'button';
        buy.addEventListener('click', function () {
          buy.disabled = true;
          buyFlow({ kind: 'asset', id: item.id, price: item.price, name: item.name }, status).then(function (bought) {
            buy.disabled = false;
            if (!bought) return;
            buy.replaceWith(el('div', 'item-owned big', 'You own this item'));
            if (balanceNote) balanceNote.remove();
          });
        });
        box.appendChild(buy);
      }
      box.appendChild(status);
      info.appendChild(box);
      if (me && me.account && item.balance !== null && (!item.owned || item.limited)) {
        balanceNote = info.appendChild(el('p', 'item-note', 'You have R$ ' + number(item.balance) + '.'));
      }

      var facts = el('dl', 'item-facts');
      function fact(name, value) {
        if (!value) return;
        facts.appendChild(el('dt', null, name));
        facts.appendChild(el('dd', null, value));
      }
      function day(iso) {
        var date = new Date(iso);
        return isNaN(date) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
      fact('Type', item.typeName);
      fact('Created', item.created && day(item.created));
      fact('Updated', item.updated && day(item.updated));
      info.appendChild(facts);
      if (item.description) info.appendChild(el('p', 'item-description', item.description));
      page.appendChild(info);
      root.appendChild(page);
      moreFrom(root, item, me);
    });
  }

  // "More from <creator>": a row of their other items.
  function moreFrom(root, item, me) {
    var query = new URLSearchParams({ category: 'all', creator: item.creator, era: 'any', sort: 'favorited' });
    fetch('/api/catalog/search?' + query, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      var others = data && Array.isArray(data.items) ? data.items.filter(function (other) { return other.id !== String(item.id); }).slice(0, 6) : [];
      if (!others.length) return;
      var section = el('section', 'section item-more');
      var head = el('div', 'container-header');
      head.appendChild(el('h2', null, 'More from ' + item.creator));
      var all = el('a', 'btn btn-secondary btn-xs', 'See All');
      all.href = '/catalog?' + query;
      head.appendChild(all);
      section.appendChild(head);
      var list = el('ul', 'item-cards');
      others.forEach(function (other) { list.appendChild(itemCard(other, Boolean(me && me.account), null, 'li')); });
      section.appendChild(list);
      root.appendChild(section);
    }).catch(function () {});
  }

  // A limited's stock, sellers and your copies (lib/limiteds.js on the game server).
  function limitedBox(box, item, me, status) {
    var info = item.limitedInfo;
    if (!item.classic) {
      box.appendChild(el('p', 'item-note', 'Only limiteds made before 2018 are sold here.'));
      return;
    }
    if (info) {
      box.appendChild(el('p', 'item-note', (info.remaining > 0 ? info.remaining + ' of ' + info.stock + ' left here' : 'Sold out here') + ' · RAP R$ ' + number(info.rap)));
    }
    if (me && me.account && item.price !== null) {
      var button = el('button', 'btn btn-green', info && info.from === 'resale' ? 'Buy from the cheapest seller' : 'Buy');
      button.type = 'button';
      button.addEventListener('click', function () {
        button.disabled = true;
        buyFlow({ kind: 'asset', id: item.id, price: item.price, name: item.name }, status).then(function (bought) {
          button.disabled = false;
          if (bought) setTimeout(function () { location.reload(); }, 900);
        });
      });
      box.appendChild(button);
    } else if (!me || !me.account) {
      var login = el('a', 'btn btn-primary btn-sm', 'Log in to buy');
      login.href = '/login?next=' + encodeURIComponent(location.pathname);
      box.appendChild(login);
    } else {
      box.appendChild(el('p', 'item-note', 'Nobody is selling one right now.'));
    }
    var more = el('div', 'limited-more');
    box.appendChild(more);
    call('GET', 'limiteds/item/' + item.id).then(function (result) {
      if (!result.ok) return;
      var data = result.data;
      if (data.listings.length) {
        more.appendChild(el('div', 'item-buy-label', 'Sellers'));
        var sellers = el('div', 'limited-list');
        data.listings.forEach(function (listing) {
          var row = el('div', 'limited-row');
          var who = el('a', null, listing.seller.name);
          who.href = profileUrl(listing.seller.userId);
          row.appendChild(who);
          row.appendChild(el('span', null, '#' + listing.serial));
          row.appendChild(el('span', 'limited-price', 'R$ ' + number(listing.price)));
          sellers.appendChild(row);
        });
        more.appendChild(sellers);
      }
      if (data.owned && data.owned.length) {
        more.appendChild(el('div', 'item-buy-label', 'Your copies'));
        var mine = el('div', 'limited-list');
        data.owned.forEach(function (copy) {
          var row = el('div', 'limited-row');
          row.appendChild(el('span', null, '#' + copy.serial));
          var price = el('input');
          price.type = 'number';
          price.min = '1';
          price.placeholder = 'Price';
          if (copy.listed) price.value = String(copy.listed);
          row.appendChild(price);
          row.appendChild(button2(copy.listed ? 'Change' : 'Sell', 'btn-secondary btn-xs', function () {
            call('POST', 'limiteds/' + copy.uaid + '/sell', { price: Number(price.value) }).then(function (r) {
              status.textContent = r.ok ? 'On sale for R$ ' + number(price.value) + '. You get 70%.' : (r.data.error || 'That did not work.');
              status.className = 'catalog-status' + (r.ok ? ' good' : ' error');
            });
          }));
          if (copy.listed) {
            row.appendChild(button2('Take off sale', 'btn-secondary btn-xs', function () {
              call('POST', 'limiteds/' + copy.uaid + '/sell', { price: null }).then(function () { location.reload(); });
            }));
          }
          mine.appendChild(row);
        });
        more.appendChild(mine);
      }
    });
  }

  function button2(label, className, onClick) {
    var node = el('button', 'btn ' + className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function inventoryPage() {
    var match = /^\/users\/(\d{1,15})\/inventory/.exec(location.pathname);
    if (!match) { location.href = '/'; return; }
    var userId = match[1];
    var params = new URLSearchParams(location.search);
    var category = categoryKnown(INVENTORY_CATEGORIES, params.get('category')) ? params.get('category') : 'hats';
    var grid = $('inventory-grid');
    var status = $('inventory-status');
    categoryNav($('inventory-cats'), INVENTORY_CATEGORIES, category, function (key) { return '/users/' + userId + '/inventory?category=' + key; });
    status.textContent = 'Loading…';
    getJson('inventory/' + userId + '?category=' + category).then(function (result) {
      if (!result.ok || !result.data) { status.textContent = (result.data && result.data.error) || 'Could not load this inventory.'; status.className = 'catalog-status error'; return; }
      var data = result.data;
      $('inventory-heading').textContent = data.name + '’s Inventory';
      document.title = data.name + '’s Inventory - rbx2017';
      data.items.forEach(function (item) { grid.appendChild(itemCard(item, false, status)); });
      status.textContent = data.items.length ? '' : 'Nothing here yet.';
    });
  }

  // Settings: tabs down the left (2017). Theme works signed out too.
  function settingsPage() {
    var root = $('settings-root');
    loadMe().then(function (me) {
      var signedIn = Boolean(me && me.account);
      root.textContent = '';
      var layout = el('div', 'settings-layout');
      var tabs = el('ul', 'settings-tabs');
      var panel = el('div', 'settings-panel');
      layout.appendChild(tabs);
      layout.appendChild(panel);
      root.appendChild(layout);
      var TABS = signedIn ? [['account', 'Account Info'], ['bc', 'Builders Club'], ['theme', 'Theme']] : [['theme', 'Theme']];
      function show(key) {
        if (!TABS.some(function (tab) { return tab[0] === key; })) key = TABS[0][0];
        Array.prototype.forEach.call(tabs.querySelectorAll('a'), function (link) {
          if (link.dataset.tab === key) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        });
        panel.textContent = '';
        if (!signedIn) {
          var note = el('p', 'item-note');
          var login = el('a', null, 'Log in');
          login.href = '/login?next=' + encodeURIComponent('/my/account');
          note.appendChild(login);
          note.appendChild(document.createTextNode(' for your account settings.'));
          panel.appendChild(note);
        }
        if (key === 'account') accountSettings(panel, me);
        else if (key === 'bc') membershipSection(panel);
        else themeSettings(panel);
      }
      TABS.forEach(function (tab) {
        var item = el('li');
        var link = el('a', null, tab[1]);
        link.href = '#' + tab[0];
        link.dataset.tab = tab[0];
        item.appendChild(link);
        tabs.appendChild(item);
      });
      window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
      show(location.hash.slice(1));
    });
  }

  function accountSettings(root, me) {
    var account = el('div', 'settings-section settings-box');
    account.appendChild(el('h2', null, 'Account'));
    account.appendChild(el('p', null, 'Username: ' + me.account.name));
    var inv = el('a', null, 'Your inventory');
    inv.href = '/users/' + me.account.userId + '/inventory';
    account.appendChild(inv);
    root.appendChild(account);

    var section = el('div', 'settings-section settings-box');
    section.appendChild(el('h2', null, 'Change password'));
    var form = el('form', 'auth-form');
    form.noValidate = true;
    function field(label, autocomplete) {
      var wrap = el('label', 'field');
      wrap.appendChild(el('span', null, label));
      var input = el('input');
      input.type = 'password';
      input.autocomplete = autocomplete;
      input.maxLength = 200;
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    }
    var current = field('Current password', 'current-password');
    var next = field('New password (at least ' + MIN_PASSWORD + ' characters)', 'new-password');
    var again = field('New password again', 'new-password');
    var message = el('p', 'form-error hidden');
    form.appendChild(message);
    var save = el('button', 'btn btn-primary btn-sm', 'Change password');
    save.type = 'submit';
    form.appendChild(save);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      function say(text, good) { message.textContent = text; message.className = good ? 'form-good' : 'form-error'; }
      if (!current.value || !next.value) return say('Type your current and new password.');
      if (next.value.length < MIN_PASSWORD) return say('Pick a new password of at least ' + MIN_PASSWORD + ' characters.');
      if (next.value !== again.value) return say('The new passwords don’t match.');
      save.disabled = true;
      post('password', { current: current.value, password: next.value }).then(function (result) {
        save.disabled = false;
        if (!result.ok) return say(result.data.error || 'That did not work.');
        current.value = next.value = again.value = '';
        say('Password changed. You were signed out everywhere else.', true);
      });
    });
    section.appendChild(form);
    root.appendChild(section);
  }

  // ---- themes: the built-in looks, your own packs (this browser only) and an editor ----
  // Packs are checked by js/themepack.js (CSS and pictures only: nothing that
  // runs or loads from elsewhere), kept in IndexedDB and never uploaded.
  var MAX_PACKS = 30;
  var EDITOR_COLORS = [
    ['--hdr', 'Header'], ['--hdr-text', 'Header text'], ['--page', 'Page'], ['--card', 'Cards'],
    ['--text', 'Text'], ['--muted', 'Second text'], ['--link', 'Links'], ['--accent', 'Blue buttons'],
    ['--play', 'Green buttons'], ['--side', 'Left column'], ['--side-text', 'Left column text'], ['--side-on-line', 'Chosen line'],
  ];
  var EDITOR_FONTS = [
    ['Source Sans', '"Source Sans Pro", "Source Sans 3", "Segoe UI", Arial, sans-serif'],
    ['Arial', 'Arial, Helvetica, sans-serif'],
    ['Helvetica', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
    ['Segoe UI', '"Segoe UI", Tahoma, sans-serif'],
    ['Verdana', 'Verdana, Geneva, sans-serif'],
    ['Tahoma', 'Tahoma, Verdana, sans-serif'],
    ['Trebuchet', '"Trebuchet MS", Helvetica, sans-serif'],
    ['Georgia', 'Georgia, "Times New Roman", serif'],
    ['Comic Sans', '"Comic Sans MS", "Comic Sans", cursive'],
    ['Courier', '"Courier New", Courier, monospace'],
  ];

  function packStore(mode, work) {
    return new Promise(function (resolve, reject) {
      if (!window.SiteThemes || !window.indexedDB) { reject(new Error('This browser can’t keep themes.')); return; }
      window.SiteThemes.openStore(function (db) {
        var tx = db.transaction('packs', mode);
        var out = work(tx.objectStore('packs'));
        tx.oncomplete = function () { resolve(out && 'result' in out ? out.result : out); };
        tx.onerror = function () { reject(tx.error || new Error('This browser can’t keep themes.')); };
      }, function () { reject(new Error('This browser can’t keep themes.')); });
    });
  }
  function listPacks() {
    return packStore('readonly', function (store) { return store.getAll(); }).then(function (list) {
      return (list || []).sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
    }, function () { return []; });
  }

  function themeFileName(name) {
    return String(name || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) + '.rbx2017theme.json';
  }
  function downloadPack(pack) {
    var clean = {};
    ['rbx2017Theme', 'name', 'year', 'author', 'description', 'targets', 'base', 'dark', 'vars', 'css', 'assets', 'preview'].forEach(function (key) {
      if (pack[key] !== undefined) clean[key] = pack[key];
    });
    var url = URL.createObjectURL(new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' }));
    var link = el('a');
    link.href = url;
    link.download = themeFileName(pack.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // A small picture of a look, drawn from its own colors.
  function themePreview(base, nav, vars, picture) {
    var reset = el('span', 'theme-preview-wrap');
    reset.dataset.theme = 'web2017';
    var box = el('span', 'theme-preview');
    box.dataset.theme = base;
    box.dataset.nav = nav;
    Object.keys(vars || {}).forEach(function (name) { box.style.setProperty(name, vars[name]); });
    if (picture) {
      var img = el('img');
      img.alt = '';
      img.src = picture;
      box.appendChild(img);
    } else {
      var hdr = el('span', 'tp-hdr');
      hdr.appendChild(el('i'));
      hdr.appendChild(el('i'));
      hdr.appendChild(el('i'));
      box.appendChild(hdr);
      var side = el('span', 'tp-side');
      for (var i = 0; i < 4; i++) side.appendChild(el('i'));
      box.appendChild(side);
      var main = el('span', 'tp-main');
      main.appendChild(el('span', 'tp-title'));
      var cards = el('span', 'tp-cards');
      for (var j = 0; j < 3; j++) {
        var card = el('span', 'tp-card');
        card.appendChild(el('b'));
        card.appendChild(el('i'));
        card.appendChild(el('s'));
        cards.appendChild(card);
      }
      main.appendChild(cards);
      box.appendChild(main);
    }
    reset.appendChild(box);
    return reset;
  }

  // A color a fifth of the way to white (hover shades).
  function lighter(hex) {
    var n = parseInt(hex.slice(1), 16);
    return '#' + [16, 8, 0].map(function (shift) {
      var c = (n >> shift) & 255;
      return ('0' + Math.round(c + (255 - c) * 0.2).toString(16)).slice(-2);
    }).join('');
  }

  function themeSettings(root) {
    var Themes = window.SiteThemes;
    var section = el('div', 'settings-section theme-section');
    section.appendChild(el('h2', null, 'Theme'));
    section.appendChild(el('p', 'item-note', 'Kept in this browser.'));
    var builtins = el('div', 'theme-grid');
    section.appendChild(builtins);
    var mineTitle = el('h2', 'hidden', 'Your themes');
    mineTitle.style.marginTop = '18px';
    section.appendChild(mineTitle);
    var mine = el('div', 'theme-grid');
    section.appendChild(mine);
    var tools = el('div', 'theme-tools');
    var file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.className = 'hidden';
    var importButton = el('button', 'btn btn-secondary btn-sm', 'Import a theme');
    importButton.type = 'button';
    importButton.addEventListener('click', function () { file.click(); });
    var makeButton = el('button', 'btn btn-primary btn-sm', 'Make your own');
    makeButton.type = 'button';
    var line = el('span', 'catalog-status');
    line.style.margin = '0';
    tools.appendChild(importButton);
    tools.appendChild(makeButton);
    tools.appendChild(file);
    tools.appendChild(line);
    section.appendChild(tools);
    var editorBox = el('div', 'settings-section hidden');
    root.appendChild(section);
    root.appendChild(editorBox);
    if (!Themes) { line.textContent = 'Themes need a newer browser.'; return; }

    function say(text, kind) {
      line.textContent = text;
      line.className = 'catalog-status' + (kind ? ' ' + kind : '');
      line.style.margin = '0';
    }

    function card(name, note, preview, active, onUse, actions) {
      var node = el('div', 'theme-card');
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
      node.appendChild(preview);
      node.appendChild(el('span', 'theme-card-name', name));
      if (note) node.appendChild(el('span', 'theme-card-note', note));
      if (actions && actions.length) {
        var row = el('span', 'theme-card-actions');
        actions.forEach(function (action) {
          var button = el('button', 'btn btn-secondary btn-xs', action[0]);
          button.type = 'button';
          button.addEventListener('click', function (event) { event.stopPropagation(); action[1](); });
          row.appendChild(button);
        });
        node.appendChild(row);
      }
      node.addEventListener('click', onUse);
      node.addEventListener('keydown', function (event) {
        if (event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onUse(); }
      });
      return node;
    }

    function draw() {
      var current = Themes.current();
      builtins.textContent = '';
      Themes.BUILTIN.forEach(function (theme) {
        builtins.appendChild(card(theme.name, theme.id === Themes.DEFAULT ? 'Default' : '',
          themePreview(theme.id, theme.nav, null, null), current === theme.id, function () {
            Themes.choose(theme.id);
            draw();
          }));
      });
      listPacks().then(function (packs) {
        mine.textContent = '';
        mineTitle.classList.toggle('hidden', !packs.length);
        packs.forEach(function (record) {
          var pack = record.pack;
          var base = Themes.find(pack.base) || Themes.find(Themes.DEFAULT);
          var picture = pack.preview && pack.assets ? pack.assets[pack.preview] : null;
          mine.appendChild(card(pack.name, pack.author ? 'By ' + pack.author : 'From ' + base.name,
            themePreview(base.id, base.nav, record.compiled.vars, picture), current === Themes.CUSTOM + record.id, function () {
              Themes.choose(record.compiled);
              draw();
            }, [
              ['Edit', function () { openEditor(record); }],
              ['Export', function () { downloadPack(pack); }],
              ['Remove', function () {
                if (!window.confirm('Remove "' + pack.name + '" from this browser?')) return;
                packStore('readwrite', function (store) { store.delete(record.id); }).then(function () {
                  if (Themes.current() === Themes.CUSTOM + record.id) Themes.choose(Themes.DEFAULT);
                  say('Removed.');
                  draw();
                });
              }],
            ]));
        });
      });
    }

    // Checks, keeps and uses a pack (its JSON text or an object).
    function keep(input, replacing) {
      if (!window.ThemePack) return Promise.reject(new Error('The theme checker did not load. Reload the page.'));
      var checked;
      try {
        checked = window.ThemePack.check(input, { target: 'site', bases: Themes.BUILTIN.map(function (theme) { return theme.id; }) });
      } catch (error) {
        return Promise.reject(new Error(String(error.message || error).replace('a newer launcher', 'a newer version of the site')));
      }
      var compiled = window.ThemePack.compile(checked);
      return listPacks().then(function (packs) {
        var others = packs.filter(function (record) { return record.id !== checked.id && record.id !== replacing; });
        if (others.length >= MAX_PACKS) throw new Error('You can keep ' + MAX_PACKS + ' themes. Remove one first.');
        return packStore('readwrite', function (store) {
          if (replacing && replacing !== checked.id) store.delete(replacing);
          store.put({ id: checked.id, pack: checked, compiled: compiled, added: Date.now() });
        });
      }).then(function () {
        Themes.choose(compiled);
        return checked;
      });
    }

    file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      file.value = '';
      if (!chosen) return;
      if (chosen.size > 8 * 1024 * 1024) { say('That file is too big for a theme (8 MB at most).', 'error'); return; }
      say('Checking…');
      chosen.text().then(function (text) { return keep(text); }).then(function (pack) {
        say('"' + pack.name + '" is on.', 'good');
        draw();
      }, function (error) { say(error.message || 'That file is not a theme pack.', 'error'); });
    });

    // The editor: colors, font, corners and dark, shown on the page as you go.
    function openEditor(record) {
      var start = record ? record.pack : null;
      var probe = el('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      function hex(value) {
        probe.style.color = '';
        probe.style.color = value;
        var rgb = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
        return rgb ? '#' + [rgb[1], rgb[2], rgb[3]].map(function (n) { return ('0' + Number(n).toString(16)).slice(-2); }).join('') : '#000000';
      }
      function baseValues(base) {
        var holder = el('span');
        holder.dataset.theme = 'web2017';
        var inner = el('span');
        inner.dataset.theme = base;
        holder.appendChild(inner);
        holder.style.display = 'none';
        document.body.appendChild(holder);
        var style = getComputedStyle(inner);
        var out = {};
        EDITOR_COLORS.forEach(function (pair) { out[pair[0]] = hex(style.getPropertyValue(pair[0]).trim()); });
        out['--font'] = style.getPropertyValue('--font').trim();
        out['--r'] = parseInt(style.getPropertyValue('--r'), 10) || 0;
        holder.remove();
        return out;
      }
      var values = { base: start ? start.base : (Themes.find(Themes.current()) ? Themes.current() : Themes.DEFAULT), name: start ? start.name : 'My theme', vars: {} };
      var theme = Themes.find(values.base) || Themes.find(Themes.DEFAULT);
      values.dark = start && typeof start.dark === 'boolean' ? start.dark : Boolean(theme.dark);
      var defaults = baseValues(values.base);
      EDITOR_COLORS.forEach(function (pair) {
        values.vars[pair[0]] = start && start.vars && start.vars[pair[0]] ? hex(start.vars[pair[0]]) : defaults[pair[0]];
      });
      values.font = start && start.vars && start.vars['--font'] ? start.vars['--font'] : defaults['--font'];
      values.radius = start && start.vars && start.vars['--r'] ? parseInt(start.vars['--r'], 10) || 0 : defaults['--r'];

      editorBox.textContent = '';
      editorBox.classList.remove('hidden');
      editorBox.appendChild(el('h2', null, start ? 'Edit "' + start.name + '"' : 'Make your own'));
      var form = el('div', 'theme-editor');
      function row(labelText, control, wide) {
        var label = el('label', wide ? 'wide' : null);
        label.appendChild(el('span', null, labelText));
        label.appendChild(control);
        form.appendChild(label);
        return control;
      }
      var name = el('input');
      name.type = 'text';
      name.maxLength = 40;
      name.value = values.name;
      row('Name', name, true);
      var baseSelect = el('select');
      Themes.BUILTIN.forEach(function (option) {
        var node = el('option', null, option.name);
        node.value = option.id;
        baseSelect.appendChild(node);
      });
      baseSelect.value = values.base;
      row('Starts from', baseSelect);
      var font = el('select');
      var fontKnown = false;
      EDITOR_FONTS.forEach(function (pair) {
        var node = el('option', null, pair[0]);
        node.value = pair[1];
        if (pair[1] === values.font) fontKnown = true;
        font.appendChild(node);
      });
      if (!fontKnown) {
        var theirs = el('option', null, 'The theme’s own');
        theirs.value = values.font;
        font.insertBefore(theirs, font.firstChild);
      }
      font.value = values.font;
      row('Font', font);
      var inputs = {};
      EDITOR_COLORS.forEach(function (pair) {
        var input = el('input');
        input.type = 'color';
        input.value = values.vars[pair[0]];
        inputs[pair[0]] = input;
        row(pair[1], input);
      });
      var radius = el('input');
      radius.type = 'range';
      radius.min = '0';
      radius.max = '12';
      radius.value = String(values.radius);
      row('Corners', radius);
      var dark = el('input');
      dark.type = 'checkbox';
      dark.checked = values.dark;
      row('Dark', dark);
      editorBox.appendChild(form);

      function pack() {
        var vars = {};
        EDITOR_COLORS.forEach(function (pair) { vars[pair[0]] = inputs[pair[0]].value; });
        vars['--hdr-img'] = 'none';
        vars['--font'] = font.value;
        vars['--r'] = radius.value + 'px';
        vars['--r-btn'] = radius.value + 'px';
        vars['--r-btn-big'] = Math.max(Number(radius.value), 5) + 'px';
        vars['--accent-hover'] = lighter(inputs['--accent'].value);
        vars['--play-hover'] = lighter(inputs['--play'].value);
        vars['--side-on-icon'] = inputs['--side-on-line'].value;
        vars['--select'] = inputs['--accent'].value;
        vars['--rbx-text'] = inputs['--play'].value;
        var out = {
          rbx2017Theme: 1, name: name.value.trim() || 'My theme', base: baseSelect.value, dark: dark.checked,
          targets: ['launcher', 'site'], vars: vars,
        };
        if (start) {
          Object.keys(start.vars || {}).forEach(function (key) { if (!(key in vars)) vars[key] = start.vars[key]; });
          ['css', 'assets', 'preview', 'author', 'description', 'year'].forEach(function (key) { if (start[key]) out[key] = start[key]; });
        }
        return out;
      }
      function preview() {
        var draft = pack();
        Themes.apply({ id: 'editing', base: draft.base, dark: draft.dark, vars: draft.vars, css: start && record ? record.compiled.css : '' });
      }
      form.addEventListener('input', preview);
      baseSelect.addEventListener('change', function () {
        var fresh = baseValues(baseSelect.value);
        EDITOR_COLORS.forEach(function (pair) { inputs[pair[0]].value = fresh[pair[0]]; });
        dark.checked = Boolean((Themes.find(baseSelect.value) || {}).dark);
        preview();
      });
      preview();

      var buttons = el('div', 'theme-tools');
      var save = el('button', 'btn btn-green btn-sm', 'Save and use');
      save.type = 'button';
      var exportButton = el('button', 'btn btn-secondary btn-sm', 'Export');
      exportButton.type = 'button';
      var cancel = el('button', 'btn btn-secondary btn-sm', 'Cancel');
      cancel.type = 'button';
      var note = el('span', 'catalog-status');
      note.style.margin = '0';
      buttons.appendChild(save);
      buttons.appendChild(exportButton);
      buttons.appendChild(cancel);
      buttons.appendChild(note);
      editorBox.appendChild(buttons);
      function close() {
        probe.remove();
        editorBox.classList.add('hidden');
        editorBox.textContent = '';
      }
      cancel.addEventListener('click', function () {
        Themes.apply(Themes.saved());
        close();
      });
      exportButton.addEventListener('click', function () {
        try {
          downloadPack(window.ThemePack.check(pack(), { target: 'site' }));
        } catch (error) {
          note.textContent = error.message;
          note.className = 'catalog-status error';
        }
      });
      save.addEventListener('click', function () {
        save.disabled = true;
        keep(pack(), record ? record.id : null).then(function (kept) {
          close();
          say('"' + kept.name + '" is on.', 'good');
          draw();
        }, function (error) {
          save.disabled = false;
          note.textContent = error.message;
          note.className = 'catalog-status error';
        });
      });
      editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    makeButton.addEventListener('click', function () { openEditor(null); });
    draw();
  }

  // ---- friends, profiles, messages and chat (lib/account.js social routes) ----

  function call(method, path, body) {
    if (method === 'POST') return post(path, body);
    return fetch('/api/' + path, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) { return { ok: response.ok, status: response.status, data: data || {} }; });
    }, function () { return { ok: false, status: 0, data: { error: "Couldn't reach the site. Check your connection." } }; });
  }

  // -> Promise of me (signed in), or null after sending the visitor to log in.
  function signedInOnly(root) {
    return loadMe().then(function (me) {
      if (me && me.account) return me;
      if (me && me.offline) {
        if (root) { root.textContent = ''; root.appendChild(emptyState("The game server isn't answering. Try again in a minute.")); }
        return null;
      }
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return null;
    });
  }

  function profileUrl(userId) { return '/users/' + userId + '/profile'; }

  function whenText(iso, long) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var now = new Date();
    var time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === now.toDateString()) return time;
    var day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    return long ? day + ', ' + time : day;
  }

  function setLine(node, text, good) {
    node.textContent = text || '';
    node.className = 'social-status' + (text ? (good ? ' good' : ' error') : '');
  }

  function presenceWord(person) {
    if (person.presence === 'game') return person.online && person.online.gameName ? person.online.gameName : 'In a game';
    return PRESENCE_TEXT[person.presence] || 'Offline';
  }

  function button(label, className, onClick) {
    var node = el('button', 'btn ' + className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  // A person in a grid: picture and name (to their profile), where they are, buttons.
  function personTile(person, buttons) {
    var tile = el('div', 'person p-' + (person.presence || 'offline'));
    var link = el('a', 'person-link');
    link.href = profileUrl(person.userId);
    var picture = avatarPicture(person.userId, person.name, 'friend-picture');
    picture.appendChild(el('span', 'presence-dot'));
    link.appendChild(picture);
    link.appendChild(el('span', 'friend-name', person.name));
    tile.appendChild(link);
    tile.appendChild(el('span', 'friend-status', presenceWord(person)));
    if (buttons && buttons.length) {
      var row = el('div', 'person-buttons');
      buttons.forEach(function (node) { row.appendChild(node); });
      tile.appendChild(row);
    }
    return tile;
  }

  var FRIEND_DONE = {
    request: function (r) { return r.became === 'friends' ? 'You and ' + r.name + ' are now friends!' : 'Friend request sent to ' + r.name + '.'; },
    accept: function (r) { return 'You and ' + r.name + ' are now friends!'; },
    decline: function (r) { return 'Declined ' + r.name + '’s request.'; },
    cancel: function (r) { return 'Took back your request to ' + r.name + '.'; },
    remove: function (r) { return r.name + ' is no longer your friend.'; },
  };

  // -> Promise of the server's answer ({ok, data})
  function friendAction(verb, person, line) {
    if (verb === 'remove' && !window.confirm('Remove ' + person.name + ' from your friends?')) return Promise.resolve({ ok: false, data: {} });
    return call('POST', 'friends/' + verb, { userId: String(person.userId) }).then(function (result) {
      if (line) setLine(line, result.ok ? FRIEND_DONE[verb](result.data) : (result.data.error || 'That did not work.'), result.ok);
      return result;
    });
  }

  function friendsPage() {
    var line = $('friends-status');
    signedInOnly($('friends-root')).then(function (me) {
      if (!me) return;
      function load() {
        call('GET', 'friends/all').then(function (result) {
          if (!result.ok) { setLine(line, result.data.error || 'Could not load your friends.'); return; }
          var data = result.data;
          fill('requests', data.incoming || [], function (person) {
            return [
              button('Accept', 'btn-green btn-xs', function () { friendAction('accept', person, line).then(load); }),
              button('Decline', 'btn-secondary btn-xs', function () { friendAction('decline', person, line).then(load); }),
            ];
          }, 'Friend Requests');
          fill('friends', data.friends || [], function (person) {
            return [
              button('Chat', 'btn-secondary btn-xs', function () { location.href = '/chat?with=' + person.userId; }),
              button('Message', 'btn-secondary btn-xs', function () { location.href = '/my/messages?to=' + encodeURIComponent(person.name); }),
            ];
          }, 'Friends', true);
          fill('sent', data.outgoing || [], function (person) {
            return [button('Take back', 'btn-secondary btn-xs', function () { friendAction('cancel', person, line).then(load); })];
          }, 'Sent Requests');
        });
      }
      function fill(key, list, buttonsFor, title, always) {
        var head = $(key + '-head');
        var grid = $(key + '-grid');
        head.textContent = title + ' (' + list.length + ')';
        head.classList.toggle('hidden', !list.length && !always);
        grid.textContent = '';
        if (!list.length && always) grid.appendChild(emptyState('No friends yet. Find players above and add them.'));
        list.forEach(function (person) { grid.appendChild(personTile(person, buttonsFor(person))); });
      }
      load();

      var form = $('people-form');
      var asked = new URLSearchParams(location.search).get('q');
      if (asked) setTimeout(function () { $('people-q').value = asked.slice(0, 20); form.requestSubmit(); }, 0);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var q = $('people-q').value.trim();
        var grid = $('people-grid');
        $('people-results').classList.remove('hidden');
        grid.textContent = '';
        grid.appendChild(emptyState('Looking…'));
        call('GET', 'people?search=' + encodeURIComponent(q.replace(/[^A-Za-z0-9_]/g, ''))).then(function (result) {
          grid.textContent = '';
          var people = (result.data.people || []).filter(function (person) { return !person.self; });
          if (!result.ok) { grid.appendChild(emptyState(result.data.error || 'Could not search.')); return; }
          if (!people.length) { grid.appendChild(emptyState('Nobody found.')); return; }
          people.slice(0, 40).forEach(function (person) {
            var buttons = [];
            if (person.friendStatus === 'NotFriend') {
              buttons.push(button('Add Friend', 'btn-green btn-xs', function (event) {
                var node = event.currentTarget;
                friendAction('request', person, line).then(function (r) { if (r.ok) { node.disabled = true; node.textContent = r.data.became === 'friends' ? 'Friends' : 'Sent'; load(); } });
              }));
            } else if (person.friendStatus === 'FriendRequestReceived') {
              buttons.push(button('Accept', 'btn-green btn-xs', function () { friendAction('accept', person, line).then(load); }));
            }
            grid.appendChild(personTile(person, buttons));
          });
        });
      });
    });
  }

  function profilePage() {
    var match = /^\/users\/(\d{1,15})\/profile/.exec(location.pathname);
    var root = $('profile-root');
    if (!match) { location.href = '/'; return; }
    var userId = match[1];
    var line = $('profile-status');
    function load() {
      Promise.all([call('GET', 'profile/' + userId), loadMe()]).then(function (both) {
        var result = both[0];
        var me = both[1] && both[1].account ? both[1] : null;
        root.textContent = '';
        if (!result.ok) { root.appendChild(emptyState(result.data.error || 'Could not load this profile.')); return; }
        var person = result.data;
        document.title = person.name + ' - rbx2017';
        var head = el('div', 'profile-head p-' + (person.presence || 'offline'));
        var picture = avatarPicture(person.userId, person.name, 'hello-avatar');
        picture.appendChild(el('span', 'presence-dot'));
        head.appendChild(picture);
        var text = el('div', 'profile-text');
        var name = el('h1', null, person.name);
        if (person.admin) name.appendChild(el('span', 'admin-tag', 'Admin'));
        if (person.membership) name.appendChild(el('span', 'admin-tag bc-tag', BC_SHORT[person.membership] || 'BC'));
        text.appendChild(name);
        var where = el('p', 'profile-where', presenceWord(person));
        if (person.presence === 'game' && person.online && person.online.placeId) {
          where.textContent = '';
          var game = el('a', null, person.online.gameName || 'a game');
          game.href = gameUrl({ placeId: person.online.placeId, name: person.online.gameName || '' });
          where.appendChild(document.createTextNode('Playing '));
          where.appendChild(game);
        }
        text.appendChild(where);
        var stats = el('div', 'profile-stats');
        [[person.friendCount, 'Friends'], [person.followerCount, 'Followers'], [person.followingCount, 'Following']].forEach(function (pair) {
          if (typeof pair[0] !== 'number') return;
          var stat = el('div');
          stat.appendChild(el('b', null, number(pair[0])));
          stat.appendChild(el('span', null, pair[1]));
          stats.appendChild(stat);
        });
        text.appendChild(stats);
        var actions = el('div', 'profile-actions');
        if (me && !person.self && !person.blocked) {
          var again = function () { load(); };
          var status = person.friendStatus;
          if (status === 'Friend') {
            actions.appendChild(button('Chat', 'btn-primary btn-sm', function () { location.href = '/chat?with=' + person.userId; }));
          } else if (status === 'FriendRequestSent') {
            actions.appendChild(button('Request Sent', 'btn-secondary btn-sm', function () { friendAction('cancel', person, line).then(again); }));
          } else if (status === 'FriendRequestReceived') {
            actions.appendChild(button('Accept Request', 'btn-green btn-sm', function () { friendAction('accept', person, line).then(again); }));
            actions.appendChild(button('Decline', 'btn-secondary btn-sm', function () { friendAction('decline', person, line).then(again); }));
          } else {
            actions.appendChild(button('Add Friend', 'btn-green btn-sm', function () { friendAction('request', person, line).then(again); }));
          }
          actions.appendChild(button('Message', 'btn-secondary btn-sm', function () { location.href = '/my/messages?to=' + encodeURIComponent(person.name); }));
          if (person.membership) actions.appendChild(button('Trade', 'btn-secondary btn-sm', function () { location.href = '/my/trades?with=' + person.userId; }));
          if (status === 'Friend') actions.appendChild(button('Unfriend', 'btn-secondary btn-sm', function () { friendAction('remove', person, line).then(again); }));
        } else if (!me) {
          var login = el('a', 'btn btn-green btn-sm', 'Log in to add friends');
          login.href = '/login?next=' + encodeURIComponent(location.pathname);
          actions.appendChild(login);
        }
        var inventory = el('a', 'btn btn-secondary btn-sm', 'Inventory');
        inventory.href = '/users/' + person.userId + '/inventory';
        actions.appendChild(inventory);
        text.appendChild(actions);
        head.appendChild(text);
        root.appendChild(head);
        var about = el('section', 'settings-section');
        about.appendChild(el('h2', null, 'About'));
        about.appendChild(el('p', 'profile-bio' + (person.bio ? '' : ' empty'), person.bio || 'No bio yet.'));
        if (person.joinedAt) about.appendChild(el('p', 'profile-joined', 'Joined ' + new Date(person.joinedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })));
        root.appendChild(about);
        profileGroups(root, person.userId);
      });
    }
    load();
  }

  function profileGroups(root, userId) {
    call('GET', 'groups/of/' + userId).then(function (result) {
      if (!result.ok || !result.data.groups || !result.data.groups.length) return;
      var box = el('section', 'settings-section');
      box.appendChild(el('h2', null, 'Groups (' + result.data.groups.length + ')'));
      var grid = el('div', 'group-grid');
      result.data.groups.slice(0, 24).forEach(function (group) { grid.appendChild(groupCard(group, group.role)); });
      box.appendChild(grid);
      root.appendChild(box);
    });
  }

  function messagesPage() {
    var root = $('messages-main');
    var line = $('messages-status');
    var params = new URLSearchParams(location.search);
    var folder = ['inbox', 'sent', 'archive'].indexOf(params.get('folder')) >= 0 ? params.get('folder') : 'inbox';
    var page = 1;
    signedInOnly(root).then(function (me) {
      if (!me) return;
      var nav = $('message-folders');
      function folderNav() {
        nav.textContent = '';
        [['inbox', 'Inbox'], ['sent', 'Sent'], ['archive', 'Archive']].forEach(function (pair) {
          var link = el('a', 'catalog-cat' + (pair[0] === folder ? ' active' : ''), pair[1]);
          link.href = '/my/messages?folder=' + pair[0];
          link.addEventListener('click', function (event) {
            event.preventDefault();
            folder = pair[0];
            page = 1;
            history.replaceState(null, '', '/my/messages?folder=' + folder);
            list();
          });
          nav.appendChild(link);
        });
      }
      function list() {
        folderNav();
        setLine(line, '');
        root.textContent = '';
        root.appendChild(emptyState('Loading…'));
        call('GET', 'talk/messages?folder=' + folder + '&page=' + page).then(function (result) {
          root.textContent = '';
          if (!result.ok) { root.appendChild(emptyState(result.data.error || 'Could not load messages.')); return; }
          var data = result.data;
          if (!data.messages.length) { root.appendChild(emptyState(folder === 'inbox' ? 'No messages.' : folder === 'sent' ? 'Nothing sent yet.' : 'Nothing archived.')); return; }
          var table = el('div', 'message-list');
          data.messages.forEach(function (m) {
            var other = m.mine ? m.to : m.from;
            var row = el('button', 'message-row' + (m.read ? '' : ' unread'));
            row.type = 'button';
            row.appendChild(avatarPicture(other.userId, other.name, 'message-picture'));
            var text = el('span', 'message-text');
            text.appendChild(el('span', 'message-who', (m.mine ? 'To ' : '') + other.name));
            text.appendChild(el('span', 'message-subject', m.subject));
            text.appendChild(el('span', 'message-preview', m.body.slice(0, 120)));
            row.appendChild(text);
            row.appendChild(el('span', 'message-when', whenText(m.at)));
            row.addEventListener('click', function () { read(m.id); });
            table.appendChild(row);
          });
          root.appendChild(table);
          if (data.pages > 1) {
            var pager = el('div', 'pager');
            var back = button('‹ Newer', 'btn-secondary btn-xs', function () { page -= 1; list(); });
            var next = button('Older ›', 'btn-secondary btn-xs', function () { page += 1; list(); });
            back.disabled = data.page <= 1;
            next.disabled = data.page >= data.pages;
            pager.appendChild(back);
            pager.appendChild(el('span', null, 'Page ' + data.page + ' of ' + data.pages));
            pager.appendChild(next);
            root.appendChild(pager);
          }
        });
      }
      function read(id) {
        setLine(line, '');
        call('GET', 'talk/messages/' + id).then(function (result) {
          if (!result.ok) { setLine(line, result.data.error || 'Could not open it.'); return; }
          var m = result.data.message;
          var other = m.mine ? m.to : m.from;
          root.textContent = '';
          var box = el('article', 'settings-section message-open');
          box.appendChild(el('h2', null, m.subject));
          var who = el('p', 'message-meta');
          who.appendChild(document.createTextNode(m.mine ? 'To ' : 'From '));
          var link = el('a', null, other.name);
          link.href = profileUrl(other.userId);
          who.appendChild(link);
          who.appendChild(document.createTextNode(' · ' + whenText(m.at, true)));
          box.appendChild(who);
          box.appendChild(el('div', 'message-body', m.body));
          var actions = el('div', 'profile-actions');
          actions.appendChild(button('Back', 'btn-secondary btn-sm', list));
          if (!m.mine) {
            actions.appendChild(button('Reply', 'btn-primary btn-sm', function () { write(other.name, m.subject.indexOf('RE: ') === 0 ? m.subject : 'RE: ' + m.subject, m.id); }));
            actions.appendChild(button(m.archived ? 'Move to Inbox' : 'Archive', 'btn-secondary btn-sm', function () {
              call('POST', 'talk/messages/' + m.id + '/archive', { archived: !m.archived }).then(function (r) {
                if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
                list();
              });
            }));
          }
          box.appendChild(actions);
          root.appendChild(box);
          refreshCounts();
        });
      }
      function write(to, subject, replyTo) {
        setLine(line, '');
        root.textContent = '';
        var form = el('form', 'settings-section auth-form message-write');
        form.noValidate = true;
        form.appendChild(el('h2', null, 'New Message'));
        function field(label, node) {
          var wrap = el('label', 'field');
          wrap.appendChild(el('span', null, label));
          wrap.appendChild(node);
          form.appendChild(wrap);
          return node;
        }
        var toInput = el('input');
        toInput.maxLength = 20;
        toInput.value = to || '';
        toInput.autocomplete = 'off';
        field('To', toInput);
        var subjectInput = el('input');
        subjectInput.maxLength = 64;
        subjectInput.value = subject || '';
        field('Subject', subjectInput);
        var bodyInput = el('textarea');
        bodyInput.maxLength = 1000;
        bodyInput.rows = 8;
        field('Message', bodyInput);
        var actions = el('div', 'profile-actions');
        var send = el('button', 'btn btn-primary btn-sm', 'Send');
        send.type = 'submit';
        actions.appendChild(send);
        actions.appendChild(button('Cancel', 'btn-secondary btn-sm', list));
        form.appendChild(actions);
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          send.disabled = true;
          call('POST', 'talk/messages', { to: toInput.value.trim(), subject: subjectInput.value, body: bodyInput.value, replyTo: replyTo || null }).then(function (result) {
            send.disabled = false;
            if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return; }
            folder = 'sent';
            page = 1;
            history.replaceState(null, '', '/my/messages?folder=sent');
            list();
            setLine(line, 'Sent.', true);
          });
        });
        root.appendChild(form);
        (to ? bodyInput : toInput).focus();
      }
      $('compose-button').addEventListener('click', function (event) {
        event.preventDefault();
        write('', '', null);
      });
      if (params.get('to')) write(params.get('to'), '', null);
      else list();
    });
  }

  function chatPage() {
    var main = $('chat-main');
    var listBox = $('chat-list');
    var line = $('chat-status');
    var convos = [];
    var open = null; // { id, convo, lastSeq }
    var shown = [];
    var timer = null;
    var sending = false;
    signedInOnly(main).then(function (me) {
      if (!me) return;
      function renderList() {
        listBox.textContent = '';
        if (!convos.length) { listBox.appendChild(el('p', 'chat-none', 'No chats yet.')); return; }
        convos.forEach(function (c) {
          var item = el('button', 'chat-item' + (open && open.id === c.id ? ' active' : '') + (c.unread ? ' unread' : ''));
          item.type = 'button';
          var other = c.members.filter(function (m) { return !m.self; })[0] || c.members[0];
          item.appendChild(avatarPicture(other.userId, other.name, 'message-picture'));
          var text = el('span', 'message-text');
          text.appendChild(el('span', 'message-who', c.title));
          var last = c.last ? (c.last.mine ? 'You: ' : c.type === 'group' ? c.last.name + ': ' : '') + c.last.text : 'No messages yet';
          text.appendChild(el('span', 'message-preview', last));
          item.appendChild(text);
          if (c.unread) item.appendChild(el('span', 'count-badge', String(c.unread)));
          item.addEventListener('click', function () { openChat(c.id); });
          listBox.appendChild(item);
        });
      }
      function loadList() {
        return call('GET', 'talk/chat').then(function (result) {
          if (!result.ok) { setLine(line, result.data.error || 'Could not load chats.'); return; }
          convos = result.data.conversations || [];
          renderList();
          if (result.data.counts) showCounts(result.data.counts);
        });
      }
      function messageNode(m, previous) {
        var run = previous && previous.from === m.from && new Date(m.at) - new Date(previous.at) < 300000;
        var row = el('div', 'chat-msg ' + (m.mine ? 'mine' : 'theirs') + (run ? ' run' : ''));
        if (!run && !m.mine && open.convo.type === 'group') row.appendChild(el('span', 'chat-msg-name', m.name));
        var bubble = el('span', 'chat-msg-text', m.text);
        bubble.title = whenText(m.at, true);
        row.appendChild(bubble);
        return row;
      }
      function renderMessages(stick) {
        var box = $('chat-messages');
        if (!box) return;
        var near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.textContent = '';
        if (!shown.length) box.appendChild(el('p', 'chat-none', 'Say hi!'));
        shown.forEach(function (m, index) { box.appendChild(messageNode(m, shown[index - 1])); });
        if (stick || near) box.scrollTop = box.scrollHeight;
      }
      function renderOpen() {
        var c = open.convo;
        main.textContent = '';
        var head = el('div', 'chat-head');
        var title = el('div', 'chat-title');
        title.appendChild(el('h2', null, c.title));
        var members = el('div', 'chat-members');
        c.members.forEach(function (m) {
          var link = el('a', 'p-' + (m.presence || 'offline'), m.self ? m.name + ' (you)' : m.name);
          link.href = profileUrl(m.userId);
          members.appendChild(link);
        });
        title.appendChild(members);
        head.appendChild(title);
        if (c.type === 'group') {
          head.appendChild(button('Add', 'btn-secondary btn-xs', function () { pick('add'); }));
          head.appendChild(button('Rename', 'btn-secondary btn-xs', function () {
            var name = window.prompt('Group name', c.customTitle || '');
            if (name === null) return;
            call('POST', 'talk/chat/' + c.id + '/rename', { title: name }).then(function (r) { if (!r.ok) setLine(line, r.data.error); refreshOpen(); loadList(); });
          }));
          head.appendChild(button('Leave', 'btn-secondary btn-xs', function () {
            if (!window.confirm('Leave "' + c.title + '"?')) return;
            call('POST', 'talk/chat/' + c.id + '/leave', {}).then(function () { open = null; showEmpty(); loadList(); });
          }));
        }
        main.appendChild(head);
        main.appendChild(el('div', 'chat-messages')).id = 'chat-messages';
        var typing = el('div', 'chat-typing');
        typing.id = 'chat-typing';
        main.appendChild(typing);
        if (c.canSend) {
          var form = el('form', 'chat-form');
          var input = el('input');
          input.maxLength = 200;
          input.placeholder = 'Say something';
          input.autocomplete = 'off';
          var send = el('button', 'btn btn-primary btn-sm', 'Send');
          send.type = 'submit';
          form.appendChild(input);
          form.appendChild(send);
          var typedAt = 0;
          input.addEventListener('input', function () {
            if (!input.value.trim() || Date.now() - typedAt < 3000) return;
            typedAt = Date.now();
            call('POST', 'talk/chat/' + c.id + '/typing', { on: true });
          });
          form.addEventListener('submit', function (event) {
            event.preventDefault();
            var text = input.value.trim();
            if (!text || sending) return;
            sending = true;
            call('POST', 'talk/chat/' + c.id + '/send', { text: text }).then(function (r) {
              sending = false;
              if (!r.ok) { setLine(line, r.data.error || 'Not sent.'); return; }
              setLine(line, '');
              input.value = '';
              typedAt = 0;
              if (r.data.message && r.data.message.seq > open.lastSeq) {
                shown.push(r.data.message);
                open.lastSeq = r.data.message.seq;
                renderMessages(true);
              }
              loadList();
              input.focus();
            });
          });
          main.appendChild(form);
          input.focus();
        } else {
          main.appendChild(el('p', 'chat-closed', c.reason || ''));
        }
        renderMessages(true);
      }
      function showEmpty() {
        clearInterval(timer);
        main.textContent = '';
        main.appendChild(el('p', 'chat-empty', 'Pick a chat, or start one with a friend.'));
        renderList();
      }
      function openChat(id) {
        clearInterval(timer);
        setLine(line, '');
        call('GET', 'talk/chat/' + id).then(function (result) {
          if (!result.ok) { setLine(line, result.data.error || 'Could not open it.'); return; }
          open = { id: id, convo: result.data.conversation, lastSeq: 0 };
          shown = result.data.messages || [];
          open.lastSeq = shown.length ? shown[shown.length - 1].seq : 0;
          renderOpen();
          history.replaceState(null, '', '/chat?c=' + id);
          if (open.convo.unread) call('POST', 'talk/chat/' + id + '/read', {}).then(loadList);
          else renderList();
          timer = setInterval(refreshOpen, 3000);
        });
      }
      function refreshOpen() {
        if (!open || document.hidden) return;
        var id = open.id;
        call('GET', 'talk/chat/' + id + '?after=' + open.lastSeq).then(function (result) {
          if (!open || open.id !== id) return;
          if (!result.ok) { if (result.status === 404) { open = null; showEmpty(); loadList(); } return; }
          var fresh = (result.data.messages || []).filter(function (m) { return m.seq > open.lastSeq; });
          var changed = JSON.stringify([open.convo.canSend, open.convo.title, open.convo.members.length]) !== JSON.stringify([result.data.conversation.canSend, result.data.conversation.title, result.data.conversation.members.length]);
          open.convo = result.data.conversation;
          if (changed) renderOpen();
          if (fresh.length) {
            shown = shown.concat(fresh);
            open.lastSeq = fresh[fresh.length - 1].seq;
            renderMessages(false);
            call('POST', 'talk/chat/' + id + '/read', {}).then(loadList);
          }
          var typing = $('chat-typing');
          var names = result.data.typing || [];
          if (typing) typing.textContent = names.length ? names.join(', ') + (names.length === 1 ? ' is' : ' are') + ' typing…' : '';
        });
      }
      // Picking friends: a new chat (one), a new group, or adding to the open group.
      function pick(kind) {
        clearInterval(timer);
        main.textContent = '';
        var box = el('div', 'chat-picker');
        box.appendChild(el('h2', null, kind === 'one' ? 'New Chat' : kind === 'group' ? 'New Group' : 'Add to Group'));
        var name = null;
        if (kind === 'group') {
          name = el('input', 'chat-group-name');
          name.placeholder = 'Group name (optional)';
          name.maxLength = 50;
          box.appendChild(name);
        }
        var grid = el('div', 'picker-grid');
        grid.appendChild(el('p', 'chat-none', 'Loading friends…'));
        box.appendChild(grid);
        var chosen = {};
        var actions = el('div', 'profile-actions');
        if (kind !== 'one') {
          actions.appendChild(button(kind === 'group' ? 'Start' : 'Add', 'btn-primary btn-sm', function () {
            var ids = Object.keys(chosen).map(Number);
            if (!ids.length) { setLine(line, 'Pick at least one friend.'); return; }
            var request = kind === 'group' ? call('POST', 'talk/chat/group', { userIds: ids, title: name.value }) : call('POST', 'talk/chat/' + open.id + '/add', { userIds: ids });
            request.then(function (r) {
              if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
              if (r.data.rejected && r.data.rejected.length) setLine(line, 'Couldn’t add ' + r.data.rejected.join(', ') + '.');
              loadList().then(function () { openChat(kind === 'group' ? r.data.conversation.id : open.id); });
            });
          }));
        }
        actions.appendChild(button('Cancel', 'btn-secondary btn-sm', function () { if (open) openChat(open.id); else showEmpty(); }));
        box.appendChild(actions);
        main.appendChild(box);
        call('GET', 'friends/all').then(function (result) {
          grid.textContent = '';
          var inIt = {};
          if (kind === 'add' && open) open.convo.members.forEach(function (m) { inIt[m.userId] = true; });
          var list = (result.data.friends || []).filter(function (f) { return !inIt[f.userId]; });
          if (!list.length) { grid.appendChild(el('p', 'chat-none', kind === 'add' ? 'All your friends are in it already.' : 'No friends yet. Add some on the Friends page.')); return; }
          list.forEach(function (friend) {
            var chip = el('button', 'picker-friend p-' + (friend.presence || 'offline'));
            chip.type = 'button';
            chip.appendChild(avatarPicture(friend.userId, friend.name, 'message-picture'));
            chip.appendChild(el('span', null, friend.name));
            chip.addEventListener('click', function () {
              if (kind === 'one') { startWith(friend.userId); return; }
              if (chosen[friend.userId]) delete chosen[friend.userId];
              else chosen[friend.userId] = true;
              chip.classList.toggle('chosen', Boolean(chosen[friend.userId]));
            });
            grid.appendChild(chip);
          });
        });
      }
      function startWith(userId) {
        call('POST', 'talk/chat/start', { userId: Number(userId) }).then(function (r) {
          if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
          loadList().then(function () { openChat(r.data.conversation.id); });
        });
      }
      $('chat-new').addEventListener('click', function () { pick('one'); });
      $('chat-new-group').addEventListener('click', function () { pick('group'); });
      var params = new URLSearchParams(location.search);
      loadList().then(function () {
        if (/^\d{1,15}$/.test(params.get('with') || '')) startWith(params.get('with'));
        else if (/^\d{1,12}$/.test(params.get('c') || '')) openChat(Number(params.get('c')));
        else showEmpty();
      });
      setInterval(function () { if (!document.hidden) loadList(); }, 10000);
    });
  }

  // Unread chats, messages and friend requests: a dot on the name and counts in its menu.
  var counts = null;
  function showCounts(next) {
    counts = next;
    var total = (next.chat || 0) + (next.messages || 0) + (next.friendRequests || 0);
    var dot = document.querySelector('.user-menu-count');
    if (dot) { dot.textContent = String(total); dot.classList.toggle('hidden', !total); }
    [['friends', next.friendRequests], ['messages', next.messages], ['chat', next.chat]].forEach(function (pair) {
      ['menu-', 'nav-'].forEach(function (prefix) {
        var node = $(prefix + pair[0]);
        if (node) { node.textContent = String(pair[1] || 0); node.classList.toggle('hidden', !pair[1]); }
      });
    });
  }
  function refreshCounts() {
    call('GET', 'talk/counts').then(function (result) { if (result.ok) showCounts(result.data); });
  }

  // ---- groups (lib/account.js group routes; the game server's lib/groupapi.js) ----

  function groupUrl(group) { return '/groups/' + group.id + '/' + slug(group.name); }

  function emblemSrc(group) {
    if (!group || !group.emblem) return null;
    var version = /[?&]v=([0-9a-z]+)/.exec(group.emblem);
    return '/api/group-emblem/' + group.id + (version ? '?v=' + version[1] : '');
  }

  function groupEmblem(group, className) {
    var box = el('span', className || 'group-emblem');
    box.appendChild(el('span', 'avatar-letter', String(group.name || '?').charAt(0).toUpperCase()));
    var src = emblemSrc(group);
    if (src) {
      var img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('load', function () { box.classList.add('has-picture'); });
      img.addEventListener('error', function () { img.remove(); });
      img.src = src;
      box.appendChild(img);
    }
    return box;
  }

  function groupCard(group, line) {
    var card = el('a', 'group-card');
    card.href = groupUrl(group);
    card.appendChild(groupEmblem(group));
    card.appendChild(el('span', 'group-card-name', group.name));
    card.appendChild(el('span', 'group-card-line', line || plural(group.memberCount, 'member', 'members')));
    return card;
  }

  function fillGroups(grid, list, empty, lineFor) {
    grid.textContent = '';
    if (!list.length) { grid.appendChild(emptyState(empty)); return; }
    list.forEach(function (group) { grid.appendChild(groupCard(group, lineFor ? lineFor(group) : null)); });
  }

  function groupsPage() {
    var line = $('groups-status');
    var cost = 100;
    call('GET', 'groups').then(function (result) {
      if (!result.ok) { setLine(line, result.data.error || 'Could not load groups.'); return; }
      cost = result.data.cost || cost;
      fillGroups($('groups-popular-grid'), result.data.groups.slice(0, 24), 'No groups yet.');
    });
    loadMe().then(function (me) {
      if (!me || !me.account) {
        $('groups-mine').classList.add('hidden');
        return;
      }
      var create = $('groups-create');
      create.classList.remove('hidden');
      create.addEventListener('click', function () { showCreate(me); });
      call('GET', 'groups/mine').then(function (result) {
        if (!result.ok) return;
        $('groups-mine-title').textContent = 'My Groups (' + result.data.groups.length + ')';
        fillGroups($('groups-mine-grid'), result.data.groups, 'You are not in any groups yet.', function (group) { return group.mine.role; });
      });
    });
    $('groups-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var q = $('groups-q').value.trim();
      var section = $('groups-results');
      if (!q) { section.classList.add('hidden'); return; }
      section.classList.remove('hidden');
      var grid = $('groups-results-grid');
      grid.textContent = '';
      grid.appendChild(emptyState('Looking…'));
      call('GET', 'groups?search=' + encodeURIComponent(q.replace(/[^0-9A-Za-z_ '.&!-]/g, '').slice(0, 50))).then(function (result) {
        fillGroups(grid, result.ok ? result.data.groups : [], result.ok ? 'No groups found.' : (result.data.error || 'Could not search.'));
      });
    });
    var groupsAsked = new URLSearchParams(location.search).get('q');
    if (groupsAsked) { $('groups-q').value = groupsAsked.slice(0, 50); $('groups-form').requestSubmit(); }

    function showCreate() {
      var root = $('groups-root');
      root.textContent = '';
      var form = el('form', 'settings-section auth-form');
      form.noValidate = true;
      form.appendChild(el('h2', null, 'Create Group'));
      function field(label, node) {
        var wrap = el('label', 'field');
        wrap.appendChild(el('span', null, label));
        wrap.appendChild(node);
        form.appendChild(wrap);
        return node;
      }
      var name = el('input');
      name.maxLength = 50;
      field('Name', name);
      var description = el('textarea');
      description.maxLength = 1000;
      description.rows = 5;
      field('Description', description);
      var openWrap = el('label', 'check-line');
      var open = el('input');
      open.type = 'checkbox';
      open.checked = true;
      openWrap.appendChild(open);
      openWrap.appendChild(document.createTextNode(' Anyone can join'));
      form.appendChild(openWrap);
      var actions = el('div', 'profile-actions');
      var go = el('button', 'btn btn-green btn-sm', 'Create for R$ ' + cost);
      go.type = 'submit';
      actions.appendChild(go);
      actions.appendChild(button('Cancel', 'btn-secondary btn-sm', function () { location.href = '/groups'; }));
      form.appendChild(actions);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        go.disabled = true;
        call('POST', 'groups', { name: name.value, description: description.value, public: open.checked }).then(function (result) {
          go.disabled = false;
          if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return; }
          storeMe(null);
          location.href = groupUrl(result.data.group);
        });
      });
      root.appendChild(form);
      name.focus();
    }
  }

  function groupPage() {
    var match = /^\/groups\/(\d{1,15})/.exec(location.pathname);
    var root = $('group-root');
    var line = $('group-status');
    if (!match) { location.href = '/groups'; return; }
    var groupId = match[1];
    var section = 'about';
    var roleFilter = 0;
    var me = null;

    function act(route, body, done) {
      setLine(line, '');
      return call('POST', 'groups/' + groupId + '/' + route, body || {}).then(function (result) {
        if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return null; }
        if (done) setLine(line, typeof done === 'function' ? done(result.data) : done, true);
        if (result.data.group) render(result.data.group);
        else location.href = '/groups';
        return result.data;
      });
    }

    function load() {
      return Promise.all([call('GET', 'groups/' + groupId), loadMe()]).then(function (both) {
        me = both[1] && both[1].account ? both[1] : null;
        if (!both[0].ok) {
          root.textContent = '';
          root.appendChild(emptyState(both[0].data.error || 'Could not load this group.'));
          return;
        }
        render(both[0].data.group);
      });
    }

    function render(group) {
      document.title = group.name + ' - rbx2017';
      root.textContent = '';
      var head = el('div', 'group-head');
      head.appendChild(groupEmblem(group, 'group-emblem big'));
      var text = el('div', 'profile-text');
      text.appendChild(el('h1', null, group.name));
      var by = el('p', 'profile-where');
      by.appendChild(document.createTextNode('By '));
      if (group.owner.userId) {
        var owner = el('a', null, group.owner.name);
        owner.href = profileUrl(group.owner.userId);
        by.appendChild(owner);
      } else by.appendChild(document.createTextNode(group.owner.name));
      by.appendChild(document.createTextNode(' · ' + plural(group.memberCount, 'member', 'members') + (group.public ? '' : ' · Ask to join')));
      text.appendChild(by);
      if (group.mine) text.appendChild(el('p', 'group-rank', 'Your rank: ' + group.mine.role));
      var actions = el('div', 'profile-actions');
      if (me) {
        if (group.mine) {
          if (!(group.canOwn && group.owner.userId)) actions.appendChild(button('Leave Group', 'btn-secondary btn-sm', function () {
            if (window.confirm('Leave ' + group.name + '?')) act('leave', {}, 'You left ' + group.name + '.');
          }));
        } else if (group.requested) {
          actions.appendChild(button('Cancel Request', 'btn-secondary btn-sm', function () { act('leave', {}, 'Request taken back.'); }));
        } else {
          actions.appendChild(button(group.public ? 'Join Group' : 'Ask to Join', 'btn-green btn-sm', function () {
            act('join', {}, function (d) { return d.requested ? 'Asked to join.' : 'You joined ' + group.name + '!'; });
          }));
        }
      } else {
        var login = el('a', 'btn btn-green btn-sm', 'Log in to join');
        login.href = '/login?next=' + encodeURIComponent(location.pathname);
        actions.appendChild(login);
      }
      text.appendChild(actions);
      head.appendChild(text);
      root.appendChild(head);
      if (group.shout) {
        var shout = el('div', 'group-shout');
        shout.appendChild(el('div', 'group-shout-text', group.shout.text));
        shout.appendChild(el('div', 'message-meta', group.shout.by.name + ' · ' + whenText(group.shout.at, true)));
        root.appendChild(shout);
      }
      var tabs = el('nav', 'group-tabs');
      [['about', 'About'], ['members', 'Members'], ['wall', 'Wall'], ['manage', 'Manage']].forEach(function (pair) {
        if (pair[0] === 'manage' && !group.canManage && !group.isAdmin) return;
        var tab = el('button', 'group-tab' + (section === pair[0] ? ' active' : ''), pair[0] === 'manage' && group.requestCount ? pair[1] + ' (' + group.requestCount + ')' : pair[1]);
        tab.type = 'button';
        tab.addEventListener('click', function () { section = pair[0]; render(group); });
        tabs.appendChild(tab);
      });
      if (section === 'manage' && !group.canManage && !group.isAdmin) section = 'about';
      root.appendChild(tabs);
      var body = el('section', 'settings-section group-body');
      root.appendChild(body);
      if (section === 'about') about(body, group);
      else if (section === 'members') members(body, group);
      else if (section === 'wall') wall(body, group);
      else manage(body, group);
    }

    function about(body, group) {
      body.appendChild(el('p', 'profile-bio' + (group.description ? '' : ' empty'), group.description || 'No description.'));
      if (group.games && group.games.length) {
        body.appendChild(el('h2', null, 'Games'));
        var list = el('div', 'group-games');
        group.games.forEach(function (game) {
          var link = el('a', 'group-game', game.name);
          link.href = gameUrl({ placeId: game.placeId, name: game.name });
          list.appendChild(link);
        });
        body.appendChild(list);
      }
      if (!group.imported) body.appendChild(el('p', 'profile-joined', 'Made ' + new Date(group.created).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })));
    }

    function members(body, group) {
      var filter = el('select', 'group-filter');
      var all = el('option', null, 'All (' + group.memberCount + ')');
      all.value = '0';
      filter.appendChild(all);
      group.roles.slice().reverse().forEach(function (role) {
        var option = el('option', null, role.name + ' (' + role.count + ')');
        option.value = String(role.id);
        if (role.id === roleFilter) option.selected = true;
        filter.appendChild(option);
      });
      filter.addEventListener('change', function () { roleFilter = Number(filter.value) || 0; render(group); });
      body.appendChild(filter);
      var grid = el('div', 'person-grid');
      grid.appendChild(emptyState('Loading…'));
      body.appendChild(grid);
      call('GET', 'groups/' + groupId + '/members?role=' + roleFilter).then(function (result) {
        grid.textContent = '';
        if (!result.ok) { grid.appendChild(emptyState(result.data.error || 'Could not load members.')); return; }
        if (!result.data.members.length) { grid.appendChild(emptyState('Nobody here.')); return; }
        var myRank = group.canOwn ? 256 : group.mine ? group.mine.rank : 0;
        result.data.members.forEach(function (member) {
          var buttons = [];
          if (group.canManage && me && member.userId !== me.account.userId && member.rank < myRank && member.userId !== group.owner.userId) {
            var pick = el('select', 'group-rank-pick');
            group.roles.forEach(function (role) {
              if (role.rank >= Math.min(myRank, 255)) return;
              var option = el('option', null, role.name);
              option.value = String(role.id);
              if (role.id === member.roleId) option.selected = true;
              pick.appendChild(option);
            });
            pick.addEventListener('change', function () {
              act('members/' + member.userId + '/rank', { roleId: Number(pick.value) }, member.name + ' is now ' + pick.options[pick.selectedIndex].textContent + '.');
            });
            buttons.push(pick);
            buttons.push(button('Remove', 'btn-secondary btn-xs', function () {
              if (window.confirm('Remove ' + member.name + ' from ' + group.name + '?')) act('members/' + member.userId + '/kick', {}, 'Removed ' + member.name + '.');
            }));
          }
          var tile = personTile({ userId: member.userId, name: member.name, presence: member.presence, online: member.online }, buttons);
          tile.insertBefore(el('span', 'group-member-role', member.role), tile.children[2] || null);
          grid.appendChild(tile);
        });
      });
    }

    function wall(body, group) {
      if (group.mine) {
        var form = el('form', 'group-post');
        var text = el('textarea');
        text.maxLength = 500;
        text.rows = 3;
        text.placeholder = 'Say something';
        var go = el('button', 'btn btn-primary btn-sm', 'Post');
        go.type = 'submit';
        form.appendChild(text);
        form.appendChild(go);
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          if (!text.value.trim()) return;
          go.disabled = true;
          act('wall', { text: text.value }).then(function () { go.disabled = false; });
        });
        body.appendChild(form);
      }
      var list = el('div', 'group-wall');
      list.appendChild(emptyState('Loading…'));
      body.appendChild(list);
      call('GET', 'groups/' + groupId + '/wall').then(function (result) {
        list.textContent = '';
        if (!result.ok) { list.appendChild(emptyState(result.data.error || 'Could not load the wall.')); return; }
        if (!result.data.posts.length) { list.appendChild(emptyState('No posts yet.')); return; }
        result.data.posts.forEach(function (post) {
          var row = el('div', 'group-wall-post');
          var top = el('div', 'group-wall-top');
          var who = el('a', null, post.from.name);
          who.href = profileUrl(post.from.userId);
          top.appendChild(who);
          top.appendChild(el('span', 'message-when', whenText(post.at, true)));
          if (post.canDelete) top.appendChild(button('Delete', 'btn-secondary btn-xs', function () { act('wall/' + post.id + '/delete', {}, 'Post deleted.'); }));
          row.appendChild(top);
          row.appendChild(el('div', 'message-body', post.text));
          list.appendChild(row);
        });
      });
    }

    function manage(body, group) {
      function field(label, node) {
        var wrap = el('label', 'field');
        wrap.appendChild(el('span', null, label));
        wrap.appendChild(node);
        return wrap;
      }
      if (group.canManage) {
        body.appendChild(el('h2', null, 'Shout'));
        var shoutForm = el('form', 'group-inline');
        var shout = el('input');
        shout.maxLength = 255;
        shout.value = group.shout ? group.shout.text : '';
        var shoutGo = el('button', 'btn btn-primary btn-sm', 'Shout');
        shoutGo.type = 'submit';
        shoutForm.appendChild(shout);
        shoutForm.appendChild(shoutGo);
        shoutForm.addEventListener('submit', function (event) { event.preventDefault(); act('shout', { text: shout.value }, 'Shout updated.'); });
        body.appendChild(shoutForm);
        if (!group.public || group.requestCount) {
          body.appendChild(el('h2', null, 'Requests (' + group.requestCount + ')'));
          var requests = el('div', 'group-requests');
          body.appendChild(requests);
          call('GET', 'groups/' + groupId + '/requests').then(function (result) {
            if (!result.ok) { requests.appendChild(emptyState(result.data.error || 'Could not load requests.')); return; }
            if (!result.data.requests.length) { requests.appendChild(emptyState('Nobody is waiting.')); return; }
            result.data.requests.forEach(function (request) {
              var row = el('div', 'group-request');
              var who = el('a', null, request.name);
              who.href = profileUrl(request.userId);
              row.appendChild(who);
              row.appendChild(button('Accept', 'btn-green btn-xs', function () { act('requests/' + request.userId + '/accept', {}, request.name + ' joined.'); }));
              row.appendChild(button('Decline', 'btn-secondary btn-xs', function () { act('requests/' + request.userId + '/decline', {}, 'Declined.'); }));
              requests.appendChild(row);
            });
          });
        }
      }
      if (group.canOwn) {
        body.appendChild(el('h2', null, 'Settings'));
        var description = el('textarea');
        description.maxLength = 1000;
        description.rows = 5;
        description.value = group.description || '';
        body.appendChild(field('Description', description));
        var openWrap = el('label', 'check-line');
        var open = el('input');
        open.type = 'checkbox';
        open.checked = group.public;
        openWrap.appendChild(open);
        openWrap.appendChild(document.createTextNode(' Anyone can join'));
        body.appendChild(openWrap);
        body.appendChild(button('Save', 'btn-primary btn-sm', function () { act('settings', { description: description.value, public: open.checked }, 'Saved.'); }));

        body.appendChild(el('h2', null, 'Picture'));
        var pictureRow = el('div', 'group-inline');
        pictureRow.appendChild(groupEmblem(group));
        var file = el('input');
        file.type = 'file';
        file.accept = 'image/png,image/jpeg';
        file.className = 'hidden';
        file.addEventListener('change', function () {
          var chosen = file.files && file.files[0];
          if (!chosen) return;
          if (chosen.size > 1024 * 1024) { setLine(line, 'Pictures can be up to 1 MB.'); return; }
          setLine(line, 'Uploading…', true);
          fetch('/api/groups/' + groupId + '/emblem', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': chosen.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', Accept: 'application/json' }, body: chosen })
            .then(function (response) { return response.json().catch(function () { return {}; }).then(function (data) { return { ok: response.ok, data: data }; }); })
            .then(function (result) {
              if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return; }
              setLine(line, 'Picture changed.', true);
              render(result.data.group);
            }, function () { setLine(line, "Couldn't reach the site."); });
        });
        pictureRow.appendChild(file);
        pictureRow.appendChild(button('Upload Picture', 'btn-secondary btn-sm', function () { file.click(); }));
        if (group.emblem) pictureRow.appendChild(button('Remove Picture', 'btn-secondary btn-sm', function () { act('emblem/remove', {}, 'Picture removed.'); }));
        body.appendChild(pictureRow);

        body.appendChild(el('h2', null, 'Ranks'));
        var rows = [];
        var list = el('div', 'group-ranks');
        function addRow(role) {
          var row = el('div', 'group-inline');
          var name = el('input');
          name.maxLength = 50;
          name.placeholder = 'Rank name';
          name.value = role.name || '';
          var number = el('input');
          number.type = 'number';
          number.min = '1';
          number.max = '254';
          number.className = 'rank-number';
          number.value = role.rank ? String(role.rank) : '';
          var entry = { id: role.id || 0, name: name, number: number };
          rows.push(entry);
          row.appendChild(name);
          row.appendChild(number);
          row.appendChild(button('Remove', 'btn-secondary btn-xs', function () { rows.splice(rows.indexOf(entry), 1); row.remove(); }));
          list.appendChild(row);
        }
        group.roles.forEach(function (role) { if (role.rank < 255) addRow(role); });
        body.appendChild(list);
        var rankActions = el('div', 'profile-actions');
        rankActions.appendChild(button('Add Rank', 'btn-secondary btn-sm', function () { addRow({}); }));
        rankActions.appendChild(button('Save Ranks', 'btn-primary btn-sm', function () {
          act('roles', { roles: rows.map(function (r) { return { id: r.id, name: r.name.value, rank: Number(r.number.value) }; }) }, 'Ranks saved.');
        }));
        body.appendChild(rankActions);

        if (group.owner.userId) {
          body.appendChild(el('h2', null, 'Owner'));
          var giveRow = el('div', 'group-inline');
          var who = el('input');
          who.maxLength = 20;
          who.placeholder = 'Member name';
          giveRow.appendChild(who);
          giveRow.appendChild(button('Give Group Away', 'btn-secondary btn-sm', function () {
            var name = who.value.trim().toLowerCase();
            if (!name) return;
            call('GET', 'groups/' + groupId + '/members').then(function (result) {
              var member = result.ok ? result.data.members.filter(function (m) { return m.name.toLowerCase() === name; })[0] : null;
              if (!member) { setLine(line, who.value.trim() + ' is not in the group (or not on the first page of members).'); return; }
              if (window.confirm('Give ' + group.name + ' to ' + member.name + '? You can’t undo this yourself.')) act('transfer', { userId: member.userId }, member.name + ' owns ' + group.name + ' now.');
            });
          }));
          body.appendChild(giveRow);
        }
      }
      if (group.isAdmin && !group.canOwn && group.emblem) {
        body.appendChild(el('h2', null, 'Server Admin'));
        body.appendChild(button('Remove Picture', 'btn-secondary btn-sm', function () { act('emblem/remove', {}, 'Picture removed.'); }));
      }
      if (group.isAdmin || (group.canOwn && group.owner.userId && group.memberCount === 1)) {
        var del = button('Delete Group', 'btn-secondary btn-sm danger', function () {
          if (window.confirm('Delete ' + group.name + ' for good? Its members, wall and ranks go with it.')) act('delete', {}, 'Group deleted.');
        });
        body.appendChild(del);
      }
    }

    load();
  }

  // ---- Builders Club and trades (lib/account.js economy routes) ----

  var BC_SHORT = { BC: 'BC', TBC: 'TBC', OBC: 'OBC' };

  function membershipSection(root) {
    var section = el('div', 'settings-section');
    section.appendChild(el('h2', null, 'Builders Club'));
    var line = el('p', 'item-note');
    section.appendChild(line);
    var tiers = el('div', 'bc-tiers');
    section.appendChild(tiers);
    var renewWrap = el('label', 'check-line hidden');
    var renew = el('input');
    renew.type = 'checkbox';
    renewWrap.appendChild(renew);
    renewWrap.appendChild(document.createTextNode(' Renew every 30 days with R$'));
    section.appendChild(renewWrap);
    var message = el('p', 'form-error hidden');
    section.appendChild(message);
    root.appendChild(section);
    function show(text, good) { message.textContent = text; message.className = good ? 'form-good' : 'form-error'; }
    renew.addEventListener('change', function () {
      call('POST', 'membership/renew', { on: renew.checked }).then(function (r) {
        show(r.ok ? (renew.checked ? 'It renews by itself while you have the R$.' : 'It ends when the time runs out.') : (r.data.error || 'That did not work.'), r.ok);
      });
    });
    function load() {
      call('GET', 'membership').then(function (result) {
        if (!result.ok) { section.classList.add('hidden'); return; }
        var data = result.data;
        line.textContent = data.tier
          ? data.name + ' until ' + new Date(data.until).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + '.'
          : 'Not a member. Members get daily R$, can trade limiteds and join more groups.';
        tiers.textContent = '';
        data.tiers.forEach(function (tier) {
          var card = el('div', 'bc-tier' + (data.tier === tier.key ? ' current' : ''));
          card.appendChild(el('b', null, tier.name));
          card.appendChild(el('span', null, 'R$ ' + number(tier.price) + ' for ' + tier.days + ' days'));
          card.appendChild(el('span', null, '+R$ ' + tier.daily + ' every day'));
          card.appendChild(button(data.tier === tier.key ? 'Add 30 days' : 'Join', data.tier === tier.key ? 'btn-secondary btn-xs' : 'btn-green btn-xs', function () {
            if (!window.confirm(tier.name + ' for R$ ' + number(tier.price) + '?')) return;
            call('POST', 'membership/buy', { tier: tier.key }).then(function (r) {
              if (!r.ok) { show(r.data.error || 'That did not work.'); return; }
              storeMe(null);
              show('You’re in ' + r.data.name + '!', true);
              load();
            });
          }));
          tiers.appendChild(card);
        });
        renewWrap.classList.toggle('hidden', !data.tier);
        renew.checked = Boolean(data.autoRenew);
      });
    }
    load();
  }

  function tradesPage() {
    var root = $('trades-main');
    var line = $('trades-status');
    var params = new URLSearchParams(location.search);
    var kind = ['inbound', 'outbound', 'completed', 'inactive'].indexOf(params.get('kind')) >= 0 ? params.get('kind') : 'inbound';
    signedInOnly(root).then(function (me) {
      if (!me) return;
      var nav = $('trade-kinds');
      function kinds() {
        nav.textContent = '';
        [['inbound', 'Inbound'], ['outbound', 'Outbound'], ['completed', 'Completed'], ['inactive', 'Inactive']].forEach(function (pair) {
          var link = el('a', 'catalog-cat' + (pair[0] === kind ? ' active' : ''), pair[1]);
          link.href = '/my/trades?kind=' + pair[0];
          link.addEventListener('click', function (event) {
            event.preventDefault();
            kind = pair[0];
            history.replaceState(null, '', '/my/trades?kind=' + kind);
            list();
          });
          nav.appendChild(link);
        });
      }
      function itemTile(item, chosen, onClick) {
        var tile = el(onClick ? 'button' : 'div', 'trade-tile' + (chosen ? ' chosen' : ''));
        if (onClick) { tile.type = 'button'; tile.addEventListener('click', onClick); }
        var img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = itemPictureUrl({ kind: 'asset', id: item.assetId });
        tile.appendChild(img);
        tile.appendChild(el('span', 'trade-tile-name', item.name));
        tile.appendChild(el('span', 'trade-tile-meta', '#' + item.serial + (item.stock ? ' / ' + item.stock : '') + ' · RAP R$ ' + number(item.rap)));
        return tile;
      }
      function sideBox(title, side) {
        var box = el('div', 'trade-side');
        box.appendChild(el('h2', null, title));
        var grid = el('div', 'trade-grid');
        side.items.forEach(function (item) { grid.appendChild(itemTile(item)); });
        if (side.robux) grid.appendChild(el('div', 'trade-robux', '+ R$ ' + number(side.robux)));
        box.appendChild(grid);
        var value = side.items.reduce(function (sum, item) { return sum + (item.rap || 0); }, 0);
        box.appendChild(el('p', 'item-note', 'Value R$ ' + number(value) + (side.robux ? ' + R$ ' + number(side.robux) : '')));
        return box;
      }
      function list() {
        kinds();
        setLine(line, '');
        root.textContent = '';
        root.appendChild(emptyState('Loading…'));
        call('GET', 'trades?kind=' + kind).then(function (result) {
          root.textContent = '';
          if (!result.ok) { root.appendChild(emptyState(result.data.error || 'Could not load trades.')); return; }
          if (!result.data.membership) root.appendChild(el('p', 'form-error', 'Trading needs Builders Club. Join it in Settings.'));
          if (!result.data.trades.length) { root.appendChild(emptyState(kind === 'inbound' ? 'No trades waiting for you.' : 'Nothing here.')); return; }
          var table = el('div', 'message-list');
          result.data.trades.forEach(function (trade) {
            var other = trade.mine === 'sent' ? trade.to : trade.from;
            var row = el('button', 'message-row');
            row.type = 'button';
            row.appendChild(avatarPicture(other.userId, other.name, 'message-picture'));
            var text = el('span', 'message-text');
            text.appendChild(el('span', 'message-who', other.name));
            text.appendChild(el('span', 'message-preview', trade.offer.items.length + ' for ' + trade.request.items.length + ' · ' + trade.status));
            row.appendChild(text);
            row.appendChild(el('span', 'message-when', whenText(trade.updated)));
            row.addEventListener('click', function () { view(trade); });
            table.appendChild(row);
          });
          root.appendChild(table);
        });
      }
      function view(trade) {
        root.textContent = '';
        var other = trade.mine === 'sent' ? trade.to : trade.from;
        var box = el('section', 'settings-section');
        var who = el('a', null, other.name);
        who.href = profileUrl(other.userId);
        var head = el('h2', null, 'Trade with ');
        head.appendChild(who);
        box.appendChild(head);
        box.appendChild(el('p', 'message-meta', trade.status + ' · ' + whenText(trade.created, true)));
        var sides = el('div', 'trade-sides');
        sides.appendChild(sideBox('You give', trade.mine === 'sent' ? trade.offer : trade.request));
        sides.appendChild(sideBox('You get', trade.mine === 'sent' ? trade.request : trade.offer));
        box.appendChild(sides);
        box.appendChild(el('p', 'item-note', 'R$ in a trade arrive minus 30%.'));
        var actions = el('div', 'profile-actions');
        actions.appendChild(button('Back', 'btn-secondary btn-sm', list));
        if (trade.status === 'open') {
          if (trade.mine === 'received') {
            actions.appendChild(button('Accept', 'btn-green btn-sm', function () {
              if (window.confirm('Accept this trade? Items and R$ move at once.')) answer(trade, 'accept');
            }));
            actions.appendChild(button('Decline', 'btn-secondary btn-sm', function () { answer(trade, 'decline'); }));
          } else {
            actions.appendChild(button('Cancel Trade', 'btn-secondary btn-sm', function () { answer(trade, 'decline'); }));
          }
        }
        box.appendChild(actions);
        root.appendChild(box);
      }
      function answer(trade, verb) {
        call('POST', 'trades/' + trade.id + '/' + verb, {}).then(function (result) {
          if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return; }
          storeMe(null);
          setLine(line, verb === 'accept' ? 'Trade done!' : 'Trade closed.', true);
          view(result.data.trade);
        });
      }
      function compose(userId) {
        root.textContent = '';
        root.appendChild(emptyState('Loading items…'));
        Promise.all([call('GET', 'limiteds/of/' + me.account.userId), call('GET', 'limiteds/of/' + userId), call('GET', 'profile/' + userId)]).then(function (all) {
          root.textContent = '';
          if (!all[2].ok) { root.appendChild(emptyState(all[2].data.error || 'No such player.')); return; }
          var person = all[2].data;
          var box = el('section', 'settings-section');
          box.appendChild(el('h2', null, 'New trade with ' + person.name));
          box.appendChild(el('p', 'item-note', 'Up to 4 items a side. R$ can be up to half the value of the items with them.'));
          var give = {};
          var get = {};
          var inputs = [];
          var sides = el('div', 'trade-sides');
          [['Your items', all[0].data.items || [], give], [person.name + '’s items', all[1].data.items || [], get]].forEach(function (entry) {
            var side = el('div', 'trade-side');
            side.appendChild(el('h2', null, entry[0]));
            var grid = el('div', 'trade-grid');
            function draw() {
              grid.textContent = '';
              if (!entry[1].length) grid.appendChild(el('p', 'item-note', 'No limited items.'));
              entry[1].forEach(function (item) {
                grid.appendChild(itemTile(item, entry[2][item.uaid], function () {
                  if (entry[2][item.uaid]) delete entry[2][item.uaid];
                  else if (Object.keys(entry[2]).length < 4) entry[2][item.uaid] = true;
                  draw();
                }));
              });
            }
            draw();
            side.appendChild(grid);
            var robuxInput = el('input', 'trade-robux-input');
            robuxInput.type = 'number';
            robuxInput.min = '0';
            robuxInput.placeholder = 'R$ (optional)';
            inputs.push(robuxInput);
            side.appendChild(robuxInput);
            sides.appendChild(side);
          });
          box.appendChild(sides);
          var actions = el('div', 'profile-actions');
          actions.appendChild(button('Send Trade', 'btn-green btn-sm', function () {
            call('POST', 'trades', {
              userId: Number(userId),
              offer: { uaids: Object.keys(give).map(Number), robux: Number(inputs[0].value) || 0 },
              request: { uaids: Object.keys(get).map(Number), robux: Number(inputs[1].value) || 0 },
            }).then(function (result) {
              if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return; }
              kind = 'outbound';
              history.replaceState(null, '', '/my/trades?kind=outbound');
              list();
              setLine(line, 'Trade sent to ' + person.name + '.', true);
            });
          }));
          actions.appendChild(button('Cancel', 'btn-secondary btn-sm', list));
          box.appendChild(actions);
          root.appendChild(box);
        });
      }
      if (/^\d{1,15}$/.test(params.get('with') || '')) { kinds(); compose(params.get('with')); }
      else list();
    });
  }

  // ---- forums (lib/account.js forum routes; the game server's lib/forumapi.js) ----

  function forumPage() {
    var root = $('forum-root');
    var line = $('forum-status');
    var path = location.pathname.replace(/\/+$/, '');
    var params = new URLSearchParams(location.search);
    var thread = /^\/forum\/thread\/(\d{1,12})$/.exec(path);
    var board = /^\/forum\/(\d{1,3})$/.exec(path);
    function crumbs(parts) {
      var nav = el('div', 'forum-crumbs');
      parts.forEach(function (part, index) {
        if (index) nav.appendChild(document.createTextNode(' › '));
        if (part[1]) {
          var link = el('a', null, part[0]);
          link.href = part[1];
          nav.appendChild(link);
        } else nav.appendChild(document.createTextNode(part[0]));
      });
      return nav;
    }
    function lastLine(last) {
      if (!last) return el('span', 'forum-muted', 'No posts yet');
      var box = el('span', 'forum-last');
      var link = el('a', null, last.title);
      link.href = '/forum/thread/' + last.threadId + '?page=last';
      box.appendChild(link);
      box.appendChild(el('span', 'forum-muted', whenText(last.at, true) + ' by ' + last.by.name));
      return box;
    }
    function pager(data, href) {
      if (data.pages <= 1) return null;
      var nav = el('div', 'pager');
      var back = el('a', 'btn btn-secondary btn-xs', '‹ Back');
      var next = el('a', 'btn btn-secondary btn-xs', 'Next ›');
      if (data.page > 1) back.href = href(data.page - 1); else back.classList.add('disabled');
      if (data.page < data.pages) next.href = href(data.page + 1); else next.classList.add('disabled');
      nav.appendChild(back);
      nav.appendChild(el('span', null, 'Page ' + data.page + ' of ' + data.pages));
      nav.appendChild(next);
      return nav;
    }

    function index() {
      document.title = 'Forum - rbx2017';
      call('GET', 'forum').then(function (result) {
        root.textContent = '';
        if (!result.ok) { root.appendChild(emptyState(result.data.error || 'Could not load the forum.')); return; }
        result.data.sections.forEach(function (section) {
          var box = el('section', 'forum-section');
          box.appendChild(el('h2', 'forum-section-title', section.name));
          section.forums.forEach(function (forum) {
            var row = el('div', 'forum-row');
            var name = el('div', 'forum-name');
            var link = el('a', null, forum.name);
            link.href = '/forum/' + forum.id;
            name.appendChild(link);
            name.appendChild(el('span', 'forum-muted', forum.description));
            row.appendChild(name);
            row.appendChild(el('div', 'forum-count', plural(forum.threads, 'thread', 'threads')));
            row.appendChild(el('div', 'forum-count', plural(forum.posts, 'post', 'posts')));
            row.appendChild(lastLine(forum.last));
            box.appendChild(row);
          });
          root.appendChild(box);
        });
      });
    }

    function forumBoard(forumId) {
      var page = Number(params.get('page')) || 1;
      var search = (params.get('search') || '').slice(0, 50);
      call('GET', 'forum/' + forumId + '?page=' + page + (search ? '&search=' + encodeURIComponent(search.replace(/[^0-9A-Za-z_ '.&!-]/g, '')) : '')).then(function (result) {
        root.textContent = '';
        if (!result.ok) { root.appendChild(emptyState(result.data.error || 'Could not load this forum.')); return; }
        var data = result.data;
        document.title = data.forum.name + ' - Forum - rbx2017';
        root.appendChild(crumbs([['Forum', '/forum'], [data.forum.section, null], [data.forum.name, null]]));
        var head = el('div', 'catalog-head');
        head.appendChild(el('h1', null, data.forum.name));
        var form = el('form', 'people-search');
        var input = el('input');
        input.placeholder = 'Search threads';
        input.value = search;
        input.maxLength = 50;
        var go = el('button', 'btn btn-secondary btn-sm', 'Search');
        go.type = 'submit';
        form.appendChild(input);
        form.appendChild(go);
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          location.href = '/forum/' + forumId + (input.value.trim() ? '?search=' + encodeURIComponent(input.value.trim()) : '');
        });
        head.appendChild(form);
        root.appendChild(head);
        if (data.canPost) root.appendChild(composer(forumId));
        else if (!data.forum.adminOnly) {
          var login = el('p', 'item-note');
          var link = el('a', null, 'Log in');
          link.href = '/login?next=' + encodeURIComponent(location.pathname);
          login.appendChild(link);
          login.appendChild(document.createTextNode(' to post.'));
          root.appendChild(login);
        }
        var list = el('div', 'forum-threads');
        if (!data.threads.length) list.appendChild(emptyState(search ? 'No threads found.' : 'No threads yet. Start one!'));
        data.threads.forEach(function (t) {
          var row = el('div', 'forum-row' + (t.pinned ? ' pinned' : ''));
          var name = el('div', 'forum-name');
          var link = el('a', null, (t.pinned ? 'Pinned: ' : '') + (t.locked ? '🔒 ' : '') + t.title);
          link.href = '/forum/thread/' + t.id;
          name.appendChild(link);
          name.appendChild(el('span', 'forum-muted', 'by ' + t.author.name));
          row.appendChild(name);
          row.appendChild(el('div', 'forum-count', plural(t.replies, 'reply', 'replies')));
          row.appendChild(el('div', 'forum-count', plural(t.views, 'view', 'views')));
          row.appendChild(lastLine({ threadId: t.id, title: 'Last post', at: t.lastPostAt, by: t.lastPoster }));
          list.appendChild(row);
        });
        root.appendChild(list);
        var nav = pager(data, function (n) { return '/forum/' + forumId + '?page=' + n + (search ? '&search=' + encodeURIComponent(search) : ''); });
        if (nav) root.appendChild(nav);
      });
    }

    function composer(forumId) {
      var wrap = el('div', 'forum-compose');
      var open = el('button', 'btn btn-green btn-sm', 'New Thread');
      open.type = 'button';
      var form = el('form', 'settings-section auth-form hidden');
      var title = el('input');
      title.maxLength = 80;
      title.placeholder = 'Title';
      var text = el('textarea');
      text.maxLength = 4000;
      text.rows = 8;
      text.placeholder = 'Your post';
      var post = el('button', 'btn btn-primary btn-sm', 'Post Thread');
      post.type = 'submit';
      form.appendChild(title);
      form.appendChild(text);
      form.appendChild(post);
      open.addEventListener('click', function () { form.classList.toggle('hidden'); title.focus(); });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        post.disabled = true;
        call('POST', 'forum/' + forumId + '/threads', { title: title.value, text: text.value }).then(function (result) {
          post.disabled = false;
          if (!result.ok) { setLine(line, result.data.error || 'That did not work.'); return; }
          location.href = '/forum/thread/' + result.data.thread.id;
        });
      });
      wrap.appendChild(open);
      wrap.appendChild(form);
      return wrap;
    }

    function threadPage(threadId) {
      var page = params.get('page') === 'last' ? 'last' : (Number(params.get('page')) || 1);
      call('GET', 'forum/thread/' + threadId + '?page=' + page).then(function (result) {
        root.textContent = '';
        if (!result.ok) { root.appendChild(emptyState(result.data.error || 'Could not load this thread.')); return; }
        var data = result.data;
        var t = data.thread;
        document.title = t.title + ' - Forum - rbx2017';
        root.appendChild(crumbs([['Forum', '/forum'], [data.forum.section, null], [data.forum.name, '/forum/' + data.forum.id]]));
        root.appendChild(el('h1', 'forum-title', (t.locked ? '🔒 ' : '') + t.title));
        if (data.admin) root.appendChild(adminBar(data));
        var nav = pager(data, function (n) { return '/forum/thread/' + t.id + '?page=' + n; });
        if (nav) root.appendChild(nav);
        data.posts.forEach(function (p) { root.appendChild(postBox(p, data)); });
        if (nav) root.appendChild(pager(data, function (n) { return '/forum/thread/' + t.id + '?page=' + n; }));
        if (data.canReply) {
          var form = el('form', 'settings-section auth-form forum-reply');
          form.appendChild(el('h2', null, 'Reply'));
          var text = el('textarea');
          text.maxLength = 4000;
          text.rows = 6;
          var send = el('button', 'btn btn-primary btn-sm', 'Post Reply');
          send.type = 'submit';
          form.appendChild(text);
          form.appendChild(send);
          form.addEventListener('submit', function (event) {
            event.preventDefault();
            send.disabled = true;
            call('POST', 'forum/thread/' + t.id + '/reply', { text: text.value }).then(function (r) {
              send.disabled = false;
              if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
              location.href = '/forum/thread/' + t.id + '?page=' + r.data.pages + '#post-' + r.data.postId;
            });
          });
          root.appendChild(form);
        } else if (t.locked) {
          root.appendChild(el('p', 'item-note', 'This thread is locked.'));
        } else {
          var login = el('p', 'item-note');
          var link = el('a', null, 'Log in');
          link.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
          login.appendChild(link);
          login.appendChild(document.createTextNode(' to reply.'));
          root.appendChild(login);
        }
        if (location.hash) {
          var target = document.getElementById(location.hash.slice(1));
          if (target) target.scrollIntoView();
        }
      });
    }

    function postBox(p, data) {
      var box = el('article', 'forum-post' + (p.deleted ? ' deleted' : ''));
      box.id = 'post-' + p.id;
      var side = el('div', 'forum-author');
      side.appendChild(avatarPicture(p.author.userId, p.author.name, 'forum-avatar'));
      var name = el('a', 'forum-author-name', p.author.name);
      name.href = profileUrl(p.author.userId);
      side.appendChild(name);
      if (p.author.admin) side.appendChild(el('span', 'admin-tag', 'Admin'));
      if (p.author.membership) side.appendChild(el('span', 'admin-tag bc-tag', BC_SHORT[p.author.membership] || 'BC'));
      side.appendChild(el('span', 'forum-muted', 'Posts: ' + number(p.author.posts)));
      box.appendChild(side);
      var main = el('div', 'forum-post-main');
      main.appendChild(el('div', 'forum-muted', whenText(p.at, true) + (p.edited ? ' · edited' : '')));
      var text = el('div', 'forum-post-text', p.deleted ? 'This post was deleted.' : p.text);
      main.appendChild(text);
      var actions = el('div', 'forum-post-actions');
      if (p.canEdit) {
        actions.appendChild(button('Edit', 'btn-secondary btn-xs', function () {
          var area = el('textarea');
          area.maxLength = 4000;
          area.rows = 6;
          area.value = p.text;
          var save = button('Save', 'btn-primary btn-xs', function () {
            call('POST', 'forum/post/' + p.id + '/edit', { text: area.value }).then(function (r) {
              if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
              location.reload();
            });
          });
          text.replaceWith(area);
          actions.textContent = '';
          actions.appendChild(save);
        }));
        actions.appendChild(button('Delete', 'btn-secondary btn-xs', function () {
          if (!window.confirm(p.first ? 'Delete this thread?' : 'Delete this post?')) return;
          call('POST', 'forum/post/' + p.id + '/delete', {}).then(function (r) {
            if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
            if (r.data.deleted) location.href = '/forum/' + r.data.forumId;
            else location.reload();
          });
        }));
      }
      if (!p.deleted && me() && me().account && p.author.userId !== me().account.userId) {
        actions.appendChild(button('Report', 'btn-secondary btn-xs', function () {
          var reason = window.prompt('What is wrong with this post?', '');
          if (reason === null) return;
          call('POST', 'forum/post/' + p.id + '/report', { reason: reason || 'Forum post' }).then(function (r) {
            setLine(line, r.ok ? 'Reported. Thanks.' : (r.data.error || 'That did not work.'), r.ok);
          });
        }));
      }
      main.appendChild(actions);
      box.appendChild(main);
      return box;
    }

    function adminBar(data) {
      var t = data.thread;
      var bar = el('div', 'forum-admin');
      bar.appendChild(el('span', 'forum-muted', 'Admin:'));
      function moderate(change, done) {
        call('POST', 'forum/thread/' + t.id + '/moderate', change).then(function (r) {
          if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
          setLine(line, done, true);
          setTimeout(function () { location.reload(); }, 500);
        });
      }
      bar.appendChild(button(t.pinned ? 'Unpin' : 'Pin', 'btn-secondary btn-xs', function () { moderate({ pinned: !t.pinned }, t.pinned ? 'Unpinned.' : 'Pinned.'); }));
      bar.appendChild(button(t.locked ? 'Unlock' : 'Lock', 'btn-secondary btn-xs', function () { moderate({ locked: !t.locked }, t.locked ? 'Unlocked.' : 'Locked.'); }));
      var move = el('select', 'group-filter');
      (data.forums || []).forEach(function (f) {
        var option = el('option', null, f.name);
        option.value = String(f.id);
        if (f.id === data.forum.id) option.selected = true;
        move.appendChild(option);
      });
      move.addEventListener('change', function () { moderate({ forumId: Number(move.value) }, 'Moved.'); });
      bar.appendChild(move);
      bar.appendChild(button('Delete Thread', 'btn-secondary btn-xs danger', function () {
        if (!window.confirm('Delete this whole thread?')) return;
        call('POST', 'forum/thread/' + t.id + '/delete', {}).then(function (r) {
          if (!r.ok) { setLine(line, r.data.error || 'That did not work.'); return; }
          location.href = '/forum/' + r.data.forumId;
        });
      }));
      return bar;
    }

    var signedIn = null;
    function me() { return signedIn; }
    loadMe().then(function (data) {
      signedIn = data;
      if (thread) threadPage(thread[1]);
      else if (board) forumBoard(board[1]);
      else index();
    });
  }

  // ---- start ----
  fillSearch();
  navToggle();
  var pages = {
    home: homePage, games: gamesPage, game: gamePage, download: downloadPage,
    login: authPage('login'), signup: authPage('signup'), 'account-home': accountHomePage,
    catalog: catalogPage, item: itemPage, inventory: inventoryPage, settings: settingsPage,
    friends: friendsPage, profile: profilePage, messages: messagesPage, chat: chatPage,
    groups: groupsPage, group: groupPage, trades: tradesPage, forum: forumPage,
  };
  (pages[document.body.dataset.page] || simplePage)();
  loadMe().then(function (me) {
    renderHeaderAccount(me);
    if (me && me.account) refreshCounts();
  });

  // The 404 page's Go back button.
  var back = $('go-back');
  if (back) back.addEventListener('click', function () { if (history.length > 1) history.back(); else location.href = '/'; });
})();
