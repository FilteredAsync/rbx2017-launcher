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
    var link = 'rbx2017://play/' + game.placeId + '?host=' + encodeURIComponent(GAME_HOST) + (serverId ? '&server=' + serverId : '');
    closeDialog();
    dialog = el('div', 'modal-backdrop');
    var box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'play-title');
    box.appendChild(el('div', 'spinner'));
    var title = el('h2', null, 'Opening the launcher');
    title.id = 'play-title';
    box.appendChild(title);
    box.appendChild(el('p', null, serverId ? 'Joining a server in ' + game.name + '.' : game.name));
    var help = el('p', 'hidden', 'Nothing happened? You need the launcher first.');
    box.appendChild(help);
    var buttons = el('div', 'buttons');
    var get = el('a', 'btn btn-green btn-lg hidden', 'Download the launcher');
    get.href = '/download';
    var close = el('button', 'btn btn-secondary', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeDialog);
    buttons.appendChild(get);
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
    section.appendChild(el('p', 'text-secondary', 'Every pass is free in game.'));
    var grid = el('div', 'pass-grid');
    passes.forEach(function (pass) {
      var card = el('div', 'pass-card');
      card.appendChild(itemIcon(game, pass));
      card.appendChild(el('h4', null, pass.name));
      if (pass.description) card.title = pass.description;
      var price = el('div', 'price', 'Free');
      if (pass.price) price.appendChild(el('span', 'was', 'R$' + number(pass.price)));
      card.appendChild(price);
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

  // ---- start ----
  fillSearch();
  var pages = { home: homePage, games: gamesPage, game: gamePage, download: downloadPage };
  (pages[document.body.dataset.page] || simplePage)();

  // The 404 page's Go back button.
  var back = $('go-back');
  if (back) back.addEventListener('click', function () { if (history.length > 1) history.back(); else location.href = '/'; });
})();
