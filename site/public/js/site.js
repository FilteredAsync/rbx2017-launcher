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

  function fillSearch() {
    var input = document.querySelector('.header-search input');
    var q = new URLSearchParams(location.search).get('q');
    if (input && q && document.body.dataset.page === 'games') input.value = q;
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
    calls.appendChild(playButton);
    calls.appendChild(el('p', 'game-play-note', game.online ? (game.playing > 0 ? plural(game.playing, 'person', 'people') + ' playing now' : '') : 'Game servers are offline right now.'));

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
    if (!box) return;
    box.textContent = '';
    if (!me || me.offline) return;
    if (!me.account) {
      var page = document.body.dataset.page;
      if (page !== 'signup') {
        var signup = el('a', 'btn btn-green btn-xs header-signup', 'Sign Up');
        signup.href = '/signup';
        box.appendChild(signup);
      }
      if (page !== 'login') {
        var login = el('a', 'header-link', 'Log In');
        login.href = page === 'home' || page === 'signup' ? '/login' : '/login?next=' + encodeURIComponent(location.pathname + location.search);
        box.appendChild(login);
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
    var wrap = el('div', 'user-menu');
    var button = el('button', 'user-menu-button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(el('span', 'user-menu-name', me.account.name));
    button.appendChild(el('span', 'user-menu-count hidden'));
    button.appendChild(icon('caret'));
    var list = el('div', 'user-menu-list hidden');
    var home = el('a', null, 'Home');
    home.href = '/home';
    var inventory = el('a', null, 'Inventory');
    inventory.href = '/users/' + me.account.userId + '/inventory';
    function counted(label, href, id) {
      var link = el('a', null, label);
      link.href = href;
      var count = el('span', 'menu-count hidden');
      count.id = id;
      link.appendChild(count);
      return link;
    }
    var profile = el('a', null, 'Profile');
    profile.href = '/users/' + me.account.userId + '/profile';
    var friendsLink = counted('Friends', '/users/friends', 'menu-friends');
    var messagesLink = counted('Messages', '/my/messages', 'menu-messages');
    var chatLink = counted('Chat', '/chat', 'menu-chat');
    var groupsLink = el('a', null, 'Groups');
    groupsLink.href = '/groups';
    var tradesLink = el('a', null, 'Trades');
    tradesLink.href = '/my/trades';
    var settings = el('a', null, 'Settings');
    settings.href = '/my/account';
    var out = el('button', null, 'Log Out');
    out.type = 'button';
    out.addEventListener('click', logOut);
    list.appendChild(home);
    list.appendChild(profile);
    list.appendChild(friendsLink);
    list.appendChild(messagesLink);
    list.appendChild(chatLink);
    list.appendChild(groupsLink);
    list.appendChild(tradesLink);
    list.appendChild(inventory);
    list.appendChild(settings);
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
    node.appendChild(rbxBadge());
    node.appendChild(el('span', null, number(price)));
    return node;
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

  function itemCard(item, signedIn, status) {
    var link = itemPageUrl(item);
    var card = el(link ? 'a' : 'div', 'item-card');
    if (link) card.href = link;
    var thumb = el('span', 'item-card-thumb');
    var img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = itemPictureUrl(item);
    img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
    thumb.appendChild(img);
    card.appendChild(thumb);
    card.appendChild(el('div', 'item-card-name', item.name || 'Item ' + item.id));
    if (item.typeName) card.appendChild(el('div', 'item-card-type', item.typeName));
    if (item.limited) {
      var stock = item.limitedInfo;
      card.appendChild(el('div', 'item-limited', stock && stock.from === 'stock' ? 'Limited · ' + stock.remaining + ' left' : 'Limited'));
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

  function categoryNav(nav, list, current, hrefFor) {
    nav.textContent = '';
    list.forEach(function (entry) {
      var link = el('a', 'catalog-cat' + (entry[0] === current ? ' active' : ''), entry[1]);
      link.href = hrefFor(entry[0]);
      if (entry[0] === current) link.setAttribute('aria-current', 'page');
      nav.appendChild(link);
    });
  }

  function catalogPage() {
    var params = new URLSearchParams(location.search);
    var category = categoryKnown(SHOP_CATEGORIES, params.get('category')) ? params.get('category') : 'hats';
    var keyword = (params.get('q') || '').trim().slice(0, 50);
    var grid = $('catalog-grid');
    var status = $('catalog-status');
    var more = $('catalog-more');
    var cursor = null;
    var label = SHOP_CATEGORIES.filter(function (entry) { return entry[0] === category; })[0][1];
    $('catalog-q').value = keyword;
    $('catalog-heading').textContent = keyword ? label + ': “' + keyword + '”' : label;
    document.title = label + ' - Catalog - rbx2017';
    categoryNav($('catalog-cats'), SHOP_CATEGORIES, category, function (key) { return '/catalog?category=' + key; });
    $('catalog-search').addEventListener('submit', function (event) {
      event.preventDefault();
      var q = $('catalog-q').value.trim();
      location.href = '/catalog?category=' + category + (q ? '&q=' + encodeURIComponent(q) : '');
    });
    loadMe().then(function (me) {
      var signedIn = Boolean(me && me.account);
      function load() {
        status.textContent = keyword ? 'Searching…' : 'Loading…';
        status.className = 'catalog-status';
        more.classList.add('hidden');
        var query = new URLSearchParams({ category: category });
        if (keyword) query.set('keyword', keyword);
        if (cursor) query.set('cursor', cursor);
        fetch('/api/catalog?' + query, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (response) {
          return response.json().catch(function () { return null; }).then(function (data) { return { ok: response.ok, data: data || {} }; });
        }, function () { return { ok: false, data: { error: "Couldn't reach the site." } }; }).then(function (result) {
          if (!result.ok) { status.textContent = result.data.error || 'The catalog did not answer.'; status.className = 'catalog-status error'; return; }
          (result.data.items || []).forEach(function (item) { grid.appendChild(itemCard(item, signedIn, status)); });
          cursor = result.data.nextCursor || null;
          more.classList.toggle('hidden', !cursor);
          status.textContent = grid.children.length ? (signedIn ? '' : 'Log in to buy items.') : (keyword ? 'Nothing found.' : 'Nothing here right now.');
        });
      }
      more.addEventListener('click', load);
      load();
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
        var gone = el('div', 'empty-state', result.data.error || 'This item could not be found.');
        root.appendChild(gone);
        return;
      }
      var item = result.data;
      document.title = item.name + ' - rbx2017';
      var page = el('div', 'item-page');
      var picture = el('div', 'item-picture');
      var img = el('img');
      img.alt = item.name;
      img.src = itemPictureUrl({ kind: 'asset', id: item.id });
      picture.appendChild(img);
      page.appendChild(picture);
      var info = el('div', 'item-info');
      info.appendChild(el('h1', 'item-title', item.name));
      var by = el('p', 'item-by');
      by.appendChild(document.createTextNode('By '));
      by.appendChild(el('strong', null, item.creator));
      if (item.typeName) by.appendChild(document.createTextNode(' · ' + item.typeName));
      info.appendChild(by);
      var box = el('div', 'item-buy');
      box.appendChild(el('div', 'item-buy-label', item.limited ? 'Limited' : 'Price'));
      box.appendChild(priceNode(item.price));
      var status = el('p', 'catalog-status');
      var balanceNote = null;
      if (item.limited) {
        limitedBox(box, item, me, status);
      } else if (item.owned) {
        box.appendChild(el('div', 'item-owned big', 'You own this item'));
      } else if (!me || !me.account) {
        var login = el('a', 'btn btn-primary btn-sm', 'Log in to buy');
        login.href = '/login?next=' + encodeURIComponent(location.pathname);
        box.appendChild(login);
      } else if (item.price !== null) {
        var button = el('button', 'btn btn-green', item.price === 0 ? 'Get' : 'Buy');
        button.type = 'button';
        button.addEventListener('click', function () {
          button.disabled = true;
          buyFlow({ kind: 'asset', id: item.id, price: item.price, name: item.name }, status).then(function (bought) {
            button.disabled = false;
            if (!bought) return;
            button.replaceWith(el('div', 'item-owned big', 'You own this item'));
            if (balanceNote) balanceNote.remove();
          });
        });
        box.appendChild(button);
      }
      if (me && me.account && item.balance !== null && (!item.owned || item.limited)) balanceNote = box.appendChild(el('p', 'item-note', 'You have R$ ' + number(item.balance) + '.'));
      box.appendChild(status);
      info.appendChild(box);
      if (item.description) info.appendChild(el('p', 'item-description', item.description));
      if (item.updated) {
        var date = new Date(item.updated);
        if (!isNaN(date)) info.appendChild(el('p', 'item-note', 'Updated ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })));
      }
      page.appendChild(info);
      root.appendChild(page);
    });
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

  function settingsPage() {
    var root = $('settings-root');
    loadMe().then(function (me) {
      if (!me || !me.account) {
        location.href = '/login?next=' + encodeURIComponent('/my/account');
        return;
      }
      root.textContent = '';
      var account = el('div', 'settings-section');
      account.appendChild(el('h2', null, 'Account'));
      account.appendChild(el('p', null, 'Username: ' + me.account.name));
      var inv = el('a', null, 'Your inventory');
      inv.href = '/users/' + me.account.userId + '/inventory';
      account.appendChild(inv);
      root.appendChild(account);
      membershipSection(root);

      var section = el('div', 'settings-section');
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
        function show(text, good) { message.textContent = text; message.className = good ? 'form-good' : 'form-error'; }
        if (!current.value || !next.value) return show('Type your current and new password.');
        if (next.value.length < MIN_PASSWORD) return show('Pick a new password of at least ' + MIN_PASSWORD + ' characters.');
        if (next.value !== again.value) return show('The new passwords don’t match.');
        save.disabled = true;
        post('password', { current: current.value, password: next.value }).then(function (result) {
          save.disabled = false;
          if (!result.ok) return show(result.data.error || 'That did not work.');
          current.value = next.value = again.value = '';
          show('Password changed. You were signed out everywhere else.', true);
        });
      });
      section.appendChild(form);
      root.appendChild(section);
    });
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
    [['menu-friends', next.friendRequests], ['menu-messages', next.messages], ['menu-chat', next.chat]].forEach(function (pair) {
      var node = $(pair[0]);
      if (node) { node.textContent = String(pair[1] || 0); node.classList.toggle('hidden', !pair[1]); }
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
