'use strict';

// Games: the list (filters, sorting, picking several for one change) and a
// page per game (#games/<id>/<tab>): overview, servers, converter report,
// log, settings and file.

// --- state of a game ----------------------------------------------------------------------

function gameState(place) {
  const servers = place.servers || [];
  const live = servers.filter((server) => server.state === 'running');
  if (!place.enabled) return servers.length ? { kind: 'busy', text: 'Turning off' } : { kind: 'off', text: 'Offline' };
  if (!data.runner.running) return { kind: 'busy', text: 'Waiting', title: 'The always-on server is not running.' };
  if (live.length) return { kind: 'live', text: 'Live' };
  const broken = servers.find((server) => server.state === 'error');
  if (broken) return { kind: 'error', text: 'Error', title: broken.lastError || '' };
  if (servers.some((server) => server.state === 'restarting')) return { kind: 'busy', text: 'Restarting' };
  if (servers.length || place.keepRunning) return { kind: 'busy', text: 'Starting' };
  return { kind: 'ready', text: 'Ready', title: 'Online. A server starts when someone joins.' };
}
const playersIn = (place) => (place.servers || []).reduce((sum, server) => sum + (Array.isArray(server.players) ? server.players.length : 0), 0);
const engineOf = (place) => place.engine || '2017';
const reportOf = (placeId) => (data.overview && data.overview.convertReports[placeId]) || null;

// What is wrong with a game, for the Problems filter and its row.
function troubleOf(place) {
  const out = [];
  if ((place.servers || []).some((server) => server.state === 'error')) out.push('server error');
  const report = reportOf(place.placeId);
  if (report && report.loads === false) out.push("doesn't load");
  else if (report && report.errors) out.push(plural(report.errors, 'converter error'));
  return out;
}

function thumb(place, big) {
  const box = h('div', { class: `thumb${big ? ' big' : ''}` });
  if (place.thumbnail) box.append(h('img', { alt: '', loading: 'lazy', src: `/api/thumbnails/${place.placeId}?v=${place.thumbnail}` }));
  else box.textContent = (place.name || '?').trim().charAt(0).toUpperCase();
  return box;
}

function onlineSwitch(place) {
  return h('input', {
    type: 'checkbox', class: 'switch', checked: place.enabled, title: place.enabled ? 'Online' : 'Offline',
    'aria-label': `${place.name} online`,
    onclick: (event) => event.stopPropagation(),
    onchange: (event) => {
      const on = event.target.checked;
      act(() => change('POST', `/api/places/${place.placeId}`, JSON.stringify({ enabled: on })), on ? `Putting ${place.name} online` : `Taking ${place.name} offline`, on ? `${place.name} is online` : `${place.name} is offline`);
    },
  });
}

// "5 players on 2 servers", "Empty"
function liveLine(place) {
  const servers = (place.servers || []).filter((server) => server.state === 'running').length;
  if (!servers) return '';
  const players = playersIn(place);
  if (!players) return servers > 1 ? `${servers} servers, empty` : 'Empty';
  return `${plural(players, 'player')}${servers > 1 ? ` on ${servers} servers` : ''}`;
}

const engineTag = (id) => h('span', { class: `tag e${id}`, text: engineLabel(id) });

// --- the list ---------------------------------------------------------------------------------

const games = {
  text: '',
  state: 'all',
  engine: '',
  sort: 'busy',
  selected: new Set(),
  order: [],      // place IDs as sorted when the view opened, so a switched game stays put
};

function gameMatches(place) {
  const text = games.text.trim().toLowerCase();
  if (text && !place.name.toLowerCase().includes(text) && !place.placeId.includes(text)
    && !(place.creator && place.creator.name.toLowerCase().includes(text))) return false;
  if (games.engine && engineOf(place) !== games.engine) return false;
  if (games.state === 'online') return place.enabled;
  if (games.state === 'offline') return !place.enabled;
  if (games.state === 'playing') return playersIn(place) > 0;
  if (games.state === 'problems') return troubleOf(place).length > 0;
  return true;
}

function sortGames() {
  const by = {
    busy: (a, b) => (b.enabled - a.enabled) || (playersIn(b) - playersIn(a)) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    changed: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    id: (a, b) => Number(a.placeId) - Number(b.placeId),
  }[games.sort] || (() => 0);
  games.order = data.places.slice().sort(by).map((place) => place.placeId);
}

function gameRow(place) {
  const state = gameState(place);
  const creator = place.creator ? place.creator.name : null;
  const open = () => { location.hash = `games/${place.placeId}`; };
  const live = liveLine(place);
  const trouble = troubleOf(place);
  const report = reportOf(place.placeId);
  const pick = h('input', {
    type: 'checkbox', checked: games.selected.has(place.placeId), 'aria-label': `Select ${place.name}`,
    onclick: (event) => event.stopPropagation(),
    onchange: (event) => { if (event.target.checked) games.selected.add(place.placeId); else games.selected.delete(place.placeId); renderGames(); },
  });
  return h('tr', {
    class: `${place.enabled ? '' : 'off'} ${games.selected.has(place.placeId) ? 'picked' : ''}`.trim(),
    dataset: { id: place.placeId },
    tabIndex: 0,
    onclick: open,
    onkeydown: (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); open(); } },
  },
  h('td', { class: 'pick' }, pick),
  h('td', {}, h('div', { class: 'game-cell' }, thumb(place),
    h('div', { class: 'game-text' },
      h('div', { class: 'game-name' }, h('span', { text: place.name }), place.avatarType === 'R15' && h('span', { class: 'tag', text: 'R15' })),
      h('div', { class: 'sub' }, h('span', { class: 'mono', text: place.placeId }), creator && h('span', { text: creator }))))),
  h('td', { class: 'hide-sm' }, engineTag(engineOf(place))),
  h('td', {}, h('span', { class: `state ${state.kind}`, text: state.text, title: state.title || null }),
    live && h('div', { class: 'state-sub', text: live }),
    trouble.length > 0 && h('div', { class: 'state-sub bad', text: trouble.join(', '), title: report && report.convertedAt ? `Converted ${when(report.convertedAt)}` : null })),
  h('td', { class: 'num hide-sm' }, playersIn(place) || ''),
  h('td', { class: 'right' }, onlineSwitch(place)));
}

function renderGames() {
  if (data.places.some((place) => !games.order.includes(place.placeId))) sortGames();
  const rank = (place) => games.order.indexOf(place.placeId);
  const shown = data.places.filter(gameMatches).sort((a, b) => rank(a) - rank(b));
  for (const id of [...games.selected]) if (!placeById(id)) games.selected.delete(id);

  // Filter counts
  for (const button of document.querySelectorAll('#games-state button')) {
    button.classList.toggle('active', button.dataset.filter === games.state);
    const saved = games.state;
    games.state = button.dataset.filter;
    const count = data.places.filter(gameMatches).length;
    games.state = saved;
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = button.dataset.filter === 'all' ? '' : count || '';
  }
  const engineSelect = $('games-engine');
  const engineIds = [...new Set(data.engines.map((engine) => engine.id).concat(data.places.map(engineOf)))].sort();
  paint(engineSelect, JSON.stringify(engineIds), () => [h('option', { value: '', text: 'Any version' }), ...engineIds.map((id) => h('option', { value: id, text: engineLabel(id) }))]);
  engineSelect.value = games.engine;

  const rows = $('games-rows');
  const wanted = shown.map((place) => {
    const signature = JSON.stringify([place, data.runner.running, games.selected.has(place.placeId), reportOf(place.placeId)]);
    const old = rows.querySelector(`tr[data-id="${place.placeId}"]`);
    if (old && (old.dataset.sig === signature || old.contains(document.activeElement))) return old;
    const row = gameRow(place);
    row.dataset.sig = signature;
    return row;
  });
  if (!wanted.length) {
    const empty = data.places.length ? 'no-match' : 'no-games';
    if (rows.dataset.empty !== empty) {
      rows.dataset.empty = empty;
      rows.replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colSpan: 6 }, data.places.length ? 'No game matches.'
        : h('div', { class: 'empty-start' }, h('div', { text: 'No games yet.' }), btn('Upload one', 'primary', openUpload)))));
    }
  } else {
    delete rows.dataset.empty;
    rows.replaceChildren(...wanted);
  }
  const all = $('games-all');
  const shownIds = shown.map((place) => place.placeId);
  all.checked = shownIds.length > 0 && shownIds.every((id) => games.selected.has(id));
  all.indeterminate = !all.checked && shownIds.some((id) => games.selected.has(id));

  const live = data.places.reduce((sum, place) => sum + (place.servers || []).filter((server) => server.state === 'running').length, 0);
  const players = data.places.reduce((sum, place) => sum + playersIn(place), 0);
  $('games-sub').textContent = data.placesError || (data.places.length
    ? `${plural(data.places.filter((place) => place.enabled).length, 'game')} online, ${plural(live, 'server')}, ${plural(players, 'player')}`
    : '');
  const banner = $('runner-banner');
  banner.replaceChildren();
  if (!data.runner.running) banner.append("The always-on server isn't running, so games can't start. Run startServer.bat on the server PC.");
  for (const problem of data.runner.problems || []) banner.append(h('div', { text: problem }));
  banner.hidden = data.runner.running && !(data.runner.problems || []).length;
  renderBulk();
}

// --- changing several games at once -----------------------------------------------------------

function renderBulk() {
  const picked = [...games.selected].map(placeById).filter(Boolean);
  const bar = $('games-bulk');
  bar.hidden = picked.length === 0;
  if (!picked.length) return;
  const signature = JSON.stringify([picked.map((place) => place.placeId), data.engines.map((engine) => engine.id)]);
  // The games as they are when a button is clicked (the bar outlives polling).
  const now = () => [...games.selected].map(placeById).filter(Boolean);
  paint(bar, signature, () => {
    const version = h('select', { 'aria-label': 'Roblox version' }, h('option', { value: '', text: 'Roblox version…' }),
      data.engines.map((engine) => h('option', { value: engine.id, text: engine.installed ? engine.label : `${engine.label} (not on this server)` })));
    version.addEventListener('change', () => { if (version.value) bulkEngine(now(), version.value).finally(() => { version.value = ''; }); });
    return [
      h('b', { text: `${picked.length} selected` }),
      btn('Online', 'small', () => bulkEnable(now(), true)),
      btn('Offline', 'small', () => bulkEnable(now(), false)),
      btn('Restart', 'small', () => bulkRestart(now())),
      version,
      btn('Convert again', 'small', () => bulkReconvert(now())),
      h('span', { class: 'grow' }),
      btn('Clear', 'small quiet', () => { games.selected.clear(); renderGames(); }),
    ];
  });
}

async function bulkEnable(picked, on) {
  const todo = picked.filter((place) => place.enabled !== on);
  if (!todo.length) { toast(on ? 'They are all online.' : 'They are all offline.'); return; }
  const players = todo.reduce((sum, place) => sum + playersIn(place), 0);
  if (!on && players && !await ask(`Take ${plural(todo.length, 'game')} offline?`, `${plural(players, 'player')} are saved and sent back to the launcher.`, 'Take offline', true)) return;
  actEach(todo, (place) => change('POST', `/api/places/${place.placeId}`, JSON.stringify({ enabled: on })),
    (i, n) => `${on ? 'Putting online' : 'Taking offline'} ${i} of ${n}`, (n) => `${plural(n, 'game')} ${on ? 'online' : 'offline'}`);
}

async function bulkRestart(picked) {
  const todo = picked.filter((place) => (place.servers || []).length);
  if (!todo.length) { toast('None of them has a server running.'); return; }
  if (!await ask(`Restart ${plural(todo.length, 'game')}?`, 'Players are saved first.', 'Restart')) return;
  actEach(todo, (place) => change('POST', `/api/places/${place.placeId}/restart`, '{}'), (i, n) => `Restarting ${i} of ${n}`, (n) => `${plural(n, 'game')} restarting`);
}

async function bulkEngine(picked, engine) {
  const todo = picked.filter((place) => engineOf(place) !== engine);
  if (!todo.length) { toast(`They all use ${engineLabel(engine)}.`); return; }
  if (!await ask(`Switch ${plural(todo.length, 'game')} to ${engineLabel(engine)}?`, 'New servers use it. Running ones keep the old version until they restart.', 'Switch')) return;
  await actEach(todo, (place) => change('POST', `/api/places/${place.placeId}`, JSON.stringify({ engine })), (i, n) => `Switching ${i} of ${n}`, (n) => `${plural(n, 'game')} on ${engineLabel(engine)}`);
}

async function bulkReconvert(picked) {
  if (!await ask(`Convert ${plural(picked.length, 'game')} again?`, 'Each gets a new version from its stored file. Running servers restart, and old files are kept.', 'Convert')) return;
  actEach(picked, (place) => change('POST', `/api/places/${place.placeId}/reconvert`, '{}'), (i, n) => `Converting ${i} of ${n}`, (n) => `${plural(n, 'game')} converted`);
}

// --- one game ---------------------------------------------------------------------------------

const TABS = ['overview', 'servers', 'report', 'log', 'settings', 'files'];
const game = {
  id: null,
  tab: 'overview',
  dirty: false,          // the Settings tab has unsaved changes
  report: { placeId: null, value: undefined, loading: false },
  log: { placeId: null, lines: null, errorsOnly: false, text: '' },
  years: { placeId: null, value: null },
  reportFilter: 'all',
  reportText: '',
};

function renderGame(full) {
  const place = placeById(game.id);
  if (!place) {
    $('game-head').replaceChildren(h('div', { class: 'empty', text: data.places.length ? 'This game is gone.' : 'Loading' }));
    return;
  }
  const state = gameState(place);
  const meta = h('div', { class: 'meta' }, engineTag(engineOf(place)), h('span', { text: `Place ${place.placeId}` }), h('span', { text: `Version ${place.version}` }),
    place.creator && h('span', { text: `By ${place.creator.name}` }));
  paint($('game-head'), JSON.stringify([place.name, place.placeId, place.version, place.thumbnail, place.enabled, state, liveLine(place), engineOf(place), place.creator]), () => [
    h('button', { type: 'button', class: 'thumb-edit', title: 'Change the icon', onclick: () => pick('thumb-file', place) }, thumb(place, true)),
    h('div', { class: 'head-text' }, h('h1', { text: place.name }), meta,
      h('div', { class: 'online' },
        h('label', { class: 'inline check' }, onlineSwitch(place), h('span', { text: place.enabled ? 'Online' : 'Offline' })),
        state.kind !== 'off' && h('span', { class: `state ${state.kind}`, text: state.text, title: state.title || null }),
        liveLine(place) && h('span', { class: 'muted', text: liveLine(place) }))),
  ]);
  for (const tab of document.querySelectorAll('#game-tabs a')) {
    tab.href = `#games/${place.placeId}/${tab.dataset.tab}`;
    tab.classList.toggle('active', tab.dataset.tab === game.tab);
    const counts = { report: (() => { const report = reportOf(place.placeId); return report ? (report.errors || '') : ''; })(), servers: (place.servers || []).length || '' };
    let badge = tab.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); tab.append(badge); }
    badge.textContent = counts[tab.dataset.tab] || '';
    badge.classList.toggle('bad', tab.dataset.tab === 'report');
  }
  for (const pane of document.querySelectorAll('section[data-view="game"] .pane')) pane.hidden = pane.dataset.pane !== game.tab;
  if (game.tab === 'overview') paintOverview(place);
  if (game.tab === 'servers') $('pane-servers').replaceChildren(...serversPane(place));
  if (game.tab === 'report') paintReport(place);
  if (game.tab === 'log') paintLog(place);
  if (game.tab === 'files') {
    $('pane-files').replaceChildren(...filePane(place));
    if (versionsKey !== `${place.placeId}:${place.version}`) loadVersions(place);
  }
  if (game.tab === 'settings' && (full || !$('pane-settings').firstChild || $('pane-settings').dataset.id !== place.placeId)) {
    $('pane-settings').replaceChildren(settingsForm(place));
    $('pane-settings').dataset.id = place.placeId;
  }
}

// Overview: the facts, and what needs a look.
function paintOverview(place) {
  const report = reportOf(place.placeId);
  const missing = data.missing.filter((asset) => !asset.replaced && (asset.usedBy || []).some((use) => use.placeId === place.placeId));
  const reports = data.reports.filter((item) => item.placeId === place.placeId && item.status === 'open');
  const errors = data.overview ? data.overview.errors.filter((line) => line.placeId === place.placeId).slice(0, 4) : [];
  const years = game.years.placeId === place.placeId && game.years.value ? game.years.value.years : [engineOf(place)];
  const signature = JSON.stringify([place, report, missing.map((asset) => asset.id), reports.map((item) => item.id), errors, years, data.runner.running]);
  paint($('pane-overview'), signature, () => {
    const fact = (label, value) => [h('dt', { text: label }), h('dd', {}, value)];
    const card = (title, body, action) => h('div', { class: 'card tile-card' }, h('div', { class: 'tile-head' }, h('h3', { text: title }), action || null), body);
    const servers = (place.servers || []).filter((server) => server.state === 'running').length;
    const reportBody = !report ? h('p', { class: 'muted', text: 'No report yet.' })
      : h('div', { class: 'checks' },
        h('span', { class: `check-chip ${report.loads === false ? 'bad' : 'good'}`, text: report.loads === false ? "Doesn't load" : 'Loads' }),
        h('span', { class: `check-chip ${report.errors ? 'bad' : ''}`, text: plural(report.errors, 'error') }),
        h('span', { class: `check-chip ${report.warnings ? 'warn' : ''}`, text: plural(report.warnings, 'warning') }),
        report.convertedAt && h('span', { class: 'muted', text: `Converted ${ago(report.convertedAt)}` }));
    return [
      h('div', { class: 'overview-grid' },
        h('dl', { class: 'card facts' },
          fact('Roblox version', engineLabel(engineOf(place))),
          fact('Client years', years.map(engineLabel).join(', ')),
          fact('Avatars', place.avatarType === 'R15' ? 'R15' : 'R6'),
          fact('Players', `${playersIn(place)} now, ${place.maxPlayers} per server`),
          fact('Servers', servers ? `${servers} running` : 'None running'),
          fact('Added', when(place.createdAt)),
          fact('Changed', when(place.updatedAt))),
        h('div', { class: 'overview-side' },
          card('Converter', reportBody, link('Report', `games/${place.placeId}/report`, 'more')),
          card('Missing assets', missing.length
            ? h('ul', { class: 'mini-list' }, missing.slice(0, 4).map((asset) => h('li', {}, h('span', { text: asset.name || asset.id }), h('small', { text: asset.type || '' }))))
            : h('p', { class: 'muted', text: 'None asked for.' }), missing.length ? link(`All ${missing.length}`, `assets/missing/${place.placeId}`, 'more') : null),
          card('Reports', reports.length
            ? h('ul', { class: 'mini-list' }, reports.slice(0, 3).map((item) => h('li', {}, h('span', { text: item.reportedName || 'The game' }), h('small', { text: item.reason || '' }))))
            : h('p', { class: 'muted', text: 'No open reports.' }), reports.length ? link('Open', `reports/game/${place.placeId}`, 'more') : null))),
      errors.length ? card('Recent errors', h('div', { class: 'log-lines' }, errors.map((line) => h('div', { class: 'log-line bad' }, h('span', { class: 'at', text: line.at.slice(11, 16) }), h('span', { text: line.text })))),
        link('Log', `games/${place.placeId}/log`, 'more')) : null,
    ];
  });
}

// Report: the converter's checks and issues.
async function loadReport(place) {
  if (game.report.loading) return;
  game.report.loading = true;
  try {
    const result = await getJson(`/api/manage/games/${place.placeId}/report`);
    game.report = { placeId: place.placeId, value: result.report, loading: false };
  } catch (error) {
    game.report = { placeId: place.placeId, value: undefined, error: error.message, loading: false };
  }
  if (game.id === place.placeId && game.tab === 'report') paintReport(place);
}

function paintReport(place) {
  const pane = $('pane-report');
  if (game.report.placeId !== place.placeId) {
    pane.dataset.sig = '';
    pane.replaceChildren(h('p', { class: 'empty', text: 'Loading' }));
    loadReport(place);
    return;
  }
  const report = game.report.value;
  paint(pane, JSON.stringify([report, game.report.error, game.reportFilter, game.reportText]), () => {
    if (game.report.error) return h('p', { class: 'empty', text: game.report.error });
    if (!report) {
      return h('div', { class: 'empty-start padded' }, h('div', { text: 'No report yet.' }),
        btn('Convert again', '', () => reconvert(place)));
    }
    const checks = report.checks || {};
    const issues = report.issues || [];
    const count = (severity) => issues.filter((issue) => issue.severity === severity).length;
    const text = game.reportText.trim().toLowerCase();
    const shown = issues.filter((issue) => (game.reportFilter === 'all' || issue.severity === game.reportFilter)
      && (!text || `${issue.kind} ${issue.path} ${issue.message}`.toLowerCase().includes(text)));
    const order = { error: 0, warning: 1, info: 2 };
    shown.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    const seg = h('div', { class: 'seg small' }, [['all', 'All', issues.length], ['error', 'Errors', count('error')], ['warning', 'Warnings', count('warning')], ['info', 'Info', count('info')]]
      .map(([key, label, n]) => h('button', { type: 'button', class: game.reportFilter === key ? 'active' : '', onclick: () => { game.reportFilter = key; paintReport(place); } }, label, h('span', { class: 'n', text: n || '' }))));
    const search = h('input', { type: 'search', class: 'search', placeholder: 'Find', value: game.reportText, 'aria-label': 'Find an issue' });
    search.addEventListener('input', () => { game.reportText = search.value; paintReport(place); search.focus(); });
    return [
      h('div', { class: 'card report-top' },
        h('div', { class: 'checks' },
          h('span', { class: `check-chip ${checks.loads === false ? 'bad' : checks.loads ? 'good' : ''}`, text: checks.loads === false ? "Doesn't load" : checks.loads ? 'Loads' : 'Not loaded yet' }),
          checks.scripts !== undefined && h('span', { class: 'check-chip', text: plural(Number(checks.scripts) || 0, 'script') }),
          h('span', { class: `check-chip ${checks.scriptsFailed ? 'bad' : ''}`, text: `${Number(checks.scriptsFailed) || 0} don't compile` }),
          h('span', { class: `check-chip ${checks.runErrors ? 'bad' : ''}`, text: plural(Number(checks.runErrors) || 0, 'run error') })),
        h('div', { class: 'muted small' }, `Converted ${when(report.convertedAt)}`, report.converterVersion ? `, converter ${report.converterVersion}` : '', report.engine ? ` for ${engineLabel(report.engine)}` : ''),
        btn('Convert again', 'small', () => reconvert(place))),
      h('div', { class: 'toolbar' }, seg, h('span', { class: 'grow' }), search),
      shown.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table issues' },
          h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Kind' }), h('th', { text: 'Where' }), h('th', { text: 'What' }))),
          h('tbody', {}, shown.slice(0, 1000).map((issue) => h('tr', {},
            h('td', {}, h('span', { class: `sev ${issue.severity}`, title: issue.severity })),
            h('td', { class: 'sub', text: issue.kind || '' }),
            h('td', { class: 'mono path', text: issue.path || '–' }),
            h('td', { text: issue.message || '' }))))))
        : h('p', { class: 'empty', text: issues.length ? 'Nothing matches.' : 'No issues.' }),
    ];
  });
}

async function reconvert(place) {
  if (!await ask(`Convert ${place.name} again?`, 'It picks up converter fixes made since the upload. Running servers restart on the new version, and the old file is kept.', 'Convert')) return;
  await act(() => change('POST', `/api/places/${place.placeId}/reconvert`, '{}'), `Converting ${place.name}`, 'Converted');
  game.report.placeId = null;
  loadOverview();
}

// Log: the always-on server's lines about this game.
async function loadGameLog(place) {
  try {
    const result = await getJson(`/api/manage/games/${place.placeId}/log?lines=600`);
    game.log.placeId = place.placeId;
    game.log.lines = result.lines || [];
  } catch (error) {
    game.log.placeId = place.placeId;
    game.log.lines = [error.message];
  }
  if (game.id === place.placeId && game.tab === 'log') paintLog(place);
}

const ERROR_WORDS = /\b(error|errors|failed|failure|crash(?:ed)?|could not|couldn't|not responding|timed out|refused|stopped by itself|exit code)\b/i;
function paintLog(place) {
  const pane = $('pane-log');
  if (!pane.firstChild) {
    const errorsOnly = h('input', { type: 'checkbox', id: 'log-errors' });
    errorsOnly.addEventListener('change', () => { game.log.errorsOnly = errorsOnly.checked; paintLog(placeById(game.id)); });
    const search = h('input', { type: 'search', class: 'search', placeholder: 'Find', 'aria-label': 'Find in the log' });
    search.addEventListener('input', () => { game.log.text = search.value; paintLog(placeById(game.id)); });
    pane.append(
      h('div', { class: 'toolbar' }, h('label', { class: 'inline check' }, errorsOnly, 'Errors only'), h('span', { class: 'grow' }), search,
        btn('Copy', 'small', async () => {
          try { await navigator.clipboard.writeText($('game-log').innerText); toast('Log copied', 'good'); } catch (error) { toast("Couldn't copy. Select the text and copy it.", 'error'); }
        })),
      h('div', { class: 'log rich', id: 'game-log' }));
  }
  if (game.log.placeId !== place.placeId) {
    game.log.lines = null;
    $('game-log').textContent = 'Loading';
    loadGameLog(place);
    return;
  }
  const out = $('game-log');
  const text = game.log.text.trim().toLowerCase();
  const lines = (game.log.lines || []).filter((line) => (!game.log.errorsOnly || (ERROR_WORDS.test(line) && !/script timeout \d+ s/.test(line))) && (!text || line.toLowerCase().includes(text)));
  const signature = JSON.stringify([lines.length, lines[lines.length - 1], text, game.log.errorsOnly]);
  if (out.dataset.sig === signature) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && out.contains(selection.anchorNode)) return;
  const follow = !out.dataset.sig || out.scrollHeight - out.scrollTop - out.clientHeight < 30;
  out.dataset.sig = signature;
  out.replaceChildren(...(lines.length ? lines.map((line) => {
    const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(.*)$/.exec(line);
    const bad = ERROR_WORDS.test(line) && !/script timeout \d+ s/.test(line);
    return h('div', { class: `log-line${bad ? ' bad' : ''}` }, match ? [h('span', { class: 'at', text: match[1].slice(5, 16) }), h('span', { text: match[2] })] : line);
  }) : [h('div', { class: 'muted', text: game.log.lines && game.log.lines.length ? 'Nothing matches.' : 'Nothing logged for this game yet.' })]));
  if (follow) out.scrollTop = out.scrollHeight;
}

function serversPane(place) {
  const servers = place.servers || [];
  const parts = [];
  const restartAll = btn('Restart all', 'small', () => act(() => change('POST', `/api/places/${place.placeId}/restart`, '{}'),
    `Restarting ${place.name}`, 'Restarting. Players were saved first.'));
  restartAll.disabled = !servers.length;
  parts.push(h('div', { class: 'pane-head' }, h('h3', { text: servers.length ? plural(servers.length, 'server') : 'Servers' }), restartAll));

  if (!servers.length) {
    const text = !place.enabled ? 'The game is offline.'
      : !data.runner.running ? 'Waiting for the always-on server.'
        : place.keepRunning ? 'Starting one.' : 'None running. One starts when someone joins.';
    parts.push(h('p', { class: 'empty', text }));
  }
  const cards = h('div', { class: 'srv-grid' });
  for (const server of servers) {
    const players = Array.isArray(server.players) ? server.players : null;
    const short = server.jobId.slice(0, 6);
    const base = `/api/places/${place.placeId}/servers/${server.jobId}`;
    const running = server.state === 'running';
    cards.append(h('div', { class: 'card srv' },
      h('div', { class: 'srv-top' },
        h('code', { text: `#${short}`, title: `Job ${server.jobId}${server.address ? `, ${server.address}` : ''}` }),
        h('span', { class: `state ${running ? 'live' : server.state === 'error' ? 'error' : 'busy'}`, text: running ? 'Running' : server.state.charAt(0).toUpperCase() + server.state.slice(1) }),
        server.privateId && h('span', { class: 'srv-tag', text: `Private: ${server.privateName || 'private server'}` }),
        h('span', { class: 'grow' }),
        btn('Restart', 'small', () => act(() => change('POST', `${base}/restart`, '{}'), `Restarting #${short}`, `#${short} is restarting`)),
        btn('Stop', 'small', async () => {
          if (players && players.length && !await ask(`Stop #${short}?`, `${plural(players.length, 'player')} will be saved and sent back to the launcher.`, 'Stop', true)) return;
          act(() => change('POST', `${base}/stop`, '{}'), `Stopping #${short}`, `#${short} stopped`);
        })),
      server.state === 'error' && h('div', { class: 'srv-error', text: server.lastError || 'It did not start.' }),
      running && (players && players.length
        ? h('div', { class: 'chips' }, players.map((name) => h('a', { class: 'chip', href: `#players/${encodeURIComponent(name)}`, text: name })))
        : h('div', { class: 'muted', text: players ? `Empty${server.idleSince ? ` for ${duration(Date.now() - Date.parse(server.idleSince))}` : ''}` : 'Busy' })),
      running && h('div', { class: 'srv-foot' },
        h('span', { text: `${players ? players.length : '?'} / ${server.maxPlayers || place.maxPlayers} players` }),
        server.memoryMB && h('span', { text: `${server.memoryMB} MB` }),
        server.startedAt && h('span', { text: `Up ${duration(Date.now() - Date.parse(server.startedAt))}` }))));
  }
  if (servers.length) parts.push(cards);

  if (place.teamCreate) {
    const edit = place.cloudEdit;
    const editors = edit && Array.isArray(edit.editors) ? edit.editors : [];
    parts.push(h('h3', { text: 'Team Create' }));
    parts.push(h('p', { class: 'muted', text: !edit ? 'Nobody is editing.' : edit.state !== 'running' ? edit.state : editors.length ? `Editing now: ${editors.join(', ')}` : 'Open, nobody editing.' }));
  }

  const privates = place.privateServers || [];
  if (privates.length) {
    parts.push(h('h3', { text: `Private servers (${privates.length})` }));
    parts.push(h('div', { class: 'card list' }, privates.map((item) => h('div', { class: 'list-row' },
      h('div', { class: 'text' }, h('b', { text: item.name }),
        h('small', { text: `${item.owner}, ${plural(item.members, 'member')}${item.friends ? ', friends can join' : ''}` })),
      btn('Delete', 'small danger', async () => {
        if (!await ask(`Delete "${item.name}"?`, `It belongs to ${item.owner}. Anyone in it is saved and sent back.`, 'Delete', true)) return;
        act(() => change('DELETE', `/api/private-servers/${item.id}`), `Deleting ${item.name}`, `${item.name} deleted`);
      })))));
  }
  return parts;
}

async function loadYears(place) {
  try {
    const result = await getJson(`/api/manage/games/${place.placeId}/client-years`);
    game.years = { placeId: place.placeId, value: result };
  } catch (error) {
    game.years = { placeId: place.placeId, value: null };
  }
  if (game.id !== place.placeId) return;
  if (game.tab === 'overview') paintOverview(place);
  if (game.tab === 'settings' && !game.dirty) renderGame(true);
}

function settingsForm(place) {
  const id = place.placeId;
  const ownedHere = Boolean(place.creator && place.creator.source === 'owner');
  const input = (props) => h('input', props);
  const name = input({ value: place.name, maxLength: 60, required: true });
  const description = h('textarea', { value: place.description || '', maxLength: 1000, rows: 3 });
  const maxPlayers = input({ type: 'number', min: 1, max: 50, value: String(place.maxPlayers) });
  const avatar = h('select', {}, h('option', { value: 'R6', text: 'R6' }), h('option', { value: 'R15', text: 'R15' }));
  avatar.value = place.avatarType === 'R15' ? 'R15' : 'R6';
  const engineChoices = data.engines.length ? data.engines : [{ id: '2017', label: '2017', installed: true }];
  const version = h('select', {}, engineChoices.map((engine) => h('option', {
    value: engine.id, text: engine.installed ? engine.label : `${engine.label} (not on this server)`,
  })));
  version.value = engineOf(place);
  // Client years players may pick on the launcher's game page.
  const savedYears = game.years.placeId === id && game.years.value ? game.years.value.years : [engineOf(place)];
  const yearBoxes = engineChoices.map((engine) => {
    const box = h('input', { type: 'checkbox', value: engine.id, checked: savedYears.includes(engine.id) || engine.id === engineOf(place) });
    return { engine, box, label: h('label', { class: 'inline check year' }, box, engine.label) };
  });
  const syncYears = () => {
    for (const item of yearBoxes) {
      const own = item.engine.id === version.value;
      if (own) item.box.checked = true;
      item.box.disabled = own;
    }
  };
  version.addEventListener('change', syncYears);
  syncYears();
  const keepRunning = input({ type: 'checkbox', class: 'switch', checked: place.keepRunning });
  const allowGear = input({ type: 'checkbox', class: 'switch', checked: place.allowGear });
  const teamCreate = input({ type: 'checkbox', class: 'switch', checked: place.teamCreate });
  const universe = input({ value: place.universeId || '', inputmode: 'numeric', placeholder: 'None' });
  const creator = input({
    maxLength: 60, disabled: ownedHere,
    value: place.creator && !ownedHere ? place.creator.name : '',
    placeholder: ownedHere ? `${place.creator.name} (Studio owner)` : 'From the universe, or type a name',
  });
  const owner = input({ value: place.owner ? place.owner.name : '', placeholder: 'Admins only' });
  const editors = input({ value: (place.editors || []).map((editor) => editor.name).join(', '), placeholder: 'Names, separated by commas' });
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { text: label }), control, hint && h('small', { text: hint }));
  const toggle = (title, hint, control) => h('label', { class: 'switch-row' }, h('div', {}, h('b', { text: title }), h('small', { text: hint })), control);

  game.dirty = false;
  const save = h('button', { type: 'submit', class: 'btn primary', text: 'Save', disabled: true });
  const discard = btn('Discard', '', () => {
    game.dirty = false;
    $('pane-settings').replaceChildren(settingsForm(place));
  }, { hidden: true });
  const note = h('span', { class: 'save-note' });
  const markDirty = () => {
    if (game.dirty) return;
    game.dirty = true;
    save.disabled = false;
    discard.hidden = false;
    note.textContent = 'Unsaved changes';
  };
  const form = h('form', { class: 'settings card', autocomplete: 'off', oninput: markDirty, onchange: markDirty },
    field('Name', name),
    field('Description', description),
    h('div', { class: 'pair' }, field('Players per server', maxPlayers), field('Avatars', avatar, 'Used by servers started after saving.')),
    h('div', { class: 'pair' }, field('Roblox version', version, 'Players get it on their first join. New servers only.'),
      h('div', { class: 'field' }, h('span', { text: 'Client years' }), h('div', { class: 'years' }, yearBoxes.map((item) => item.label)), h('small', { text: 'Years players can pick in the launcher.' }))),
    h('div', { class: 'switches' },
      toggle('Keep a server running', 'Otherwise one starts on join and stops when empty.', keepRunning),
      toggle('Team Create', 'The owner and editors build it together in Studio.', teamCreate),
      toggle('Gear', 'Players bring the gear they equipped. Joins after saving.', allowGear)),
    h('h3', { text: 'Studio access' }),
    h('div', { class: 'pair' }, field('Owner', owner), field('Editors', editors)),
    h('h3', { text: 'Credit' }),
    h('div', { class: 'pair' }, field('Roblox universe ID', universe, 'For its icon and creator.'), field('Creator', creator)),
    h('div', { class: 'save-bar' }, save, discard, note));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      const fields = {
        name: name.value, description: description.value, universeId: universe.value.trim(), teamCreate: teamCreate.checked,
        keepRunning: keepRunning.checked, maxPlayers: Number(maxPlayers.value) || undefined, avatarType: avatar.value,
        allowGear: allowGear.checked, engine: version.value,
      };
      if (!ownedHere) fields.creator = creator.value.trim();
      await change('POST', `/api/places/${id}`, JSON.stringify(fields));
      // Access only when it changed, so an owner whose account is gone doesn't block other saves.
      const names = editors.value.split(',').map((item) => item.trim()).filter(Boolean);
      const before = JSON.stringify([place.owner ? place.owner.name : '', (place.editors || []).map((editor) => editor.name)]);
      if (JSON.stringify([owner.value.trim(), names]) !== before) {
        await change('POST', `/api/places/${id}/access`, JSON.stringify({ owner: owner.value.trim(), editors: names }));
      }
      const years = yearBoxes.filter((item) => item.box.checked).map((item) => item.engine.id);
      if (JSON.stringify(years.slice().sort()) !== JSON.stringify(savedYears.slice().sort())) {
        game.years = { placeId: id, value: await change('POST', `/api/manage/games/${id}/client-years`, JSON.stringify({ years })) };
      }
      game.dirty = false;
      $('pane-settings').dataset.id = '';
    }, `Saving ${name.value}`, 'Saved');
  });
  return form;
}

function filePane(place) {
  const fact = (label, value) => [h('dt', { text: label }), h('dd', {}, value)];
  const parts = [
    replaceCard(place),
    h('dl', { class: 'card facts' },
      fact('File', h('code', { text: `Server\\content\\${String(place.file || '?').replace(/\//g, '\\')}` })),
      fact('Size', size(place.fileSize)),
      fact('Version', `${place.version}${place.versionSource ? ` (${place.versionSource})` : ''}`),
      place.uploadedFrom ? fact('Uploaded from', place.uploadedFrom) : [],
      fact('Added', when(place.createdAt)),
      fact('Changed', when(place.updatedAt))),
    versionsList(place),
    h('div', { class: 'btn-row' },
      btn('Convert again', '', () => reconvert(place)),
      btn('Fix zeroed numbers', '', () => pick('restore-file', place), { title: 'Fill IntValues that are 0 from the original place file' }),
      btn('Change icon', '', () => pick('thumb-file', place))),
  ];
  if (restoreResult && restoreResult.placeId === place.placeId) parts.push(restoreCard(restoreResult));
  if (place.notes && place.notes.length) {
    parts.push(h('details', { class: 'notes' }, h('summary', { text: `Conversion notes (${place.notes.length})` }), h('pre', { text: place.notes.join('\n') })));
  }
  parts.push(h('div', { class: 'danger-zone' },
    h('div', {}, h('b', { text: 'Delete this game' }), h('p', { text: `Saves are kept, and place ${place.placeId} is never given to another game.` })),
    btn('Delete', 'danger', async () => {
      if (!await ask(`Delete ${place.name}?`, `The file moves to places\\deleted. Saves and the icon stay, and place ${place.placeId} is never reused.`, 'Delete', true)) return;
      const done = await act(() => change('DELETE', `/api/places/${place.placeId}`), `Deleting ${place.name}`, `${place.name} deleted`);
      if (done) location.hash = 'games';
    })));
  return parts.filter(Boolean);
}

let pendingPlace = null;     // which game the hidden file inputs are for
let restoreResult = null;    // the last "Fix zeroed numbers" answer, shown on that game's File tab
function pick(inputId, place) {
  pendingPlace = place;
  $(inputId).value = '';
  $(inputId).click();
}

// --- replacing a game's file (File tab) ----------------------------------------------------
// Picked or dropped file -> "ready" (asks in place) -> "upload" -> "convert" ->
// "done" or "error". Kept here, not in the page, so polling can redraw the pane.
let replacing = null;        // { placeId, phase, file, percent, convertStarted, result, error }
let versions = { placeId: null, version: null, list: null };
let versionsKey = '';
const PLACE_FILE = /\.rbxlx?$/i;
const uploading = () => Boolean(replacing && (replacing.phase === 'upload' || replacing.phase === 'convert'));

function chooseReplacement(place, file) {
  if (!file) return;
  if (uploading()) { toast('Wait for the current upload to finish.', 'error'); return; }
  replacing = PLACE_FILE.test(file.name)
    ? { placeId: place.placeId, phase: 'ready', file }
    : { placeId: place.placeId, phase: 'error', file: null, error: `${file.name} isn't a place file. Use a .rbxl or .rbxlx.` };
  paintReplace();
}

function clearReplace() {
  if (uploading()) return;
  replacing = null;
  paintReplace();
}

function paintReplace() {
  const place = placeById(game.id);
  const card = $('replace-card');
  if (place && card) card.replaceWith(replaceCard(place));
}

async function startReplace() {
  const job = replacing;
  if (!job || !job.file || busy) return;
  const place = placeById(job.placeId);
  if (!place) return;
  busy = true;
  Object.assign(job, { phase: 'upload', percent: 0, error: null });
  paintReplace();
  try {
    const query = place.universeId ? `?universeId=${encodeURIComponent(place.universeId)}` : '';
    const result = await uploadFile(`/api/places/${place.placeId}/file${query}`, job.file, (percent) => {
      if (percent < 100) job.percent = percent;
      else if (job.phase === 'upload') Object.assign(job, { phase: 'convert', convertStarted: Date.now() });
      paintReplace();
    });
    Object.assign(job, { phase: 'done', result: { version: result.place.version, size: result.place.fileSize, notes: result.notes || [] } });
    if (game.id !== job.placeId || game.tab !== 'files') toast(`${place.name} updated`, 'good');
  } catch (error) {
    Object.assign(job, { phase: 'error', error: error.message });
    if (game.id !== job.placeId || game.tab !== 'files') toast(`${place.name}: ${error.message}`, 'error');
  } finally {
    busy = false;
    game.report.placeId = null;
    await loadPlaces();
  }
}

function replaceCard(place) {
  const job = replacing && replacing.placeId === place.placeId ? replacing : null;
  const card = h('div', { class: 'card replace', id: 'replace-card' });
  if (!job) {
    card.append(h('label', { class: 'drop' },
      h('input', { type: 'file', accept: '.rbxl,.rbxlx', onchange: (event) => chooseReplacement(place, event.target.files[0]) }),
      h('span', { class: 'drop-main', text: 'Replace the place file' }),
      h('span', { class: 'drop-sub', text: 'Drop a .rbxl or .rbxlx here, or click to choose' })));
    return card;
  }
  const head = (mark, title, sub) => h('div', { class: 'replace-head' }, h('span', { class: 'file-icon', text: mark }),
    h('div', { class: 'text' }, h('b', { text: title }), sub && h('small', { text: sub })));
  const file = job.file;
  const ext = file ? (file.name.split('.').pop() || '').toUpperCase().slice(0, 5) : '';

  if (job.phase === 'ready') {
    const players = playersIn(place);
    const servers = (place.servers || []).length;
    const restart = players ? `${plural(players, 'player')} online: they're saved, then the servers restart.`
      : servers ? 'Its servers restart on the new file.' : '';
    card.append(
      head(ext, file.name, `${size(file.size)}, now ${size(place.fileSize)}, version ${place.version}`),
      h('p', { class: 'replace-note', text: `${restart} The current file goes to Previous versions.`.trim() }),
      h('div', { class: 'btn-row' }, btn('Replace', 'primary', startReplace), btn('Cancel', '', clearReplace)));
  } else if (job.phase === 'upload' || job.phase === 'convert') {
    const converting = job.phase === 'convert';
    card.append(
      head(ext, file.name, size(file.size)),
      h('div', { class: `bar${converting ? ' working' : ''}` }, h('span', { style: converting ? '' : `width: ${job.percent}%` })),
      h('div', { class: 'replace-step', id: 'replace-step', text: replaceStep(job) }));
  } else if (job.phase === 'done') {
    card.classList.add('good');
    const notes = job.result.notes;
    const fresh = versions.placeId === place.placeId && versions.version === place.version && versions.list && versions.list.length;
    const undo = btn('Undo', '', () => restoreVersion(place, versions.list[0], true));
    undo.disabled = !fresh;
    card.append(
      head('✓', `Version ${job.result.version} is live`, file.name),
      notes.length ? h('details', { class: 'notes' }, h('summary', { text: `Conversion notes (${notes.length})` }), h('pre', { text: notes.join('\n') })) : null,
      h('div', { class: 'btn-row' }, btn('Done', 'primary', clearReplace), undo));
  } else {
    card.classList.add('bad');
    card.append(
      head('!', file ? "Couldn't replace the file" : 'Not a place file', job.error),
      h('div', { class: 'btn-row' },
        file && btn('Try again', 'primary', startReplace),
        btn(file ? 'Choose another' : 'Choose a file', '', () => pick('replace-file', place)),
        btn('Cancel', '', clearReplace)));
  }
  return card;
}

function replaceStep(job) {
  if (job.phase === 'upload') return `Uploading ${job.percent}%`;
  const seconds = Math.round((Date.now() - job.convertStarted) / 1000);
  return `Converting${seconds >= 2 ? `, ${seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`}` : ''}`;
}
setInterval(() => {
  if (replacing && replacing.phase === 'convert' && $('replace-step')) $('replace-step').textContent = replaceStep(replacing);
}, 1000);

// --- earlier versions of a game's file ----------------------------------------------------------

async function loadVersions(place) {
  const key = `${place.placeId}:${place.version}`;
  if (versionsKey === key) return;
  versionsKey = key;
  let list = [];
  try { list = (await getJson(`/api/places/${place.placeId}/versions`)).versions || []; } catch (error) { /* shown as none */ }
  if (versionsKey !== key) return;
  versions = { placeId: place.placeId, version: place.version, list };
  if (game.id === place.placeId && game.tab === 'files') renderGame(false);
}

function versionsList(place) {
  if (versions.placeId !== place.placeId || !versions.list || !versions.list.length) return null;
  return h('div', { class: 'versions' },
    h('h3', { text: 'Previous versions' }),
    h('div', { class: 'card list' }, versions.list.map((version) => h('div', { class: 'list-row' },
      h('div', { class: 'text' }, h('b', { text: when(version.savedAt) }), h('small', { text: size(version.size) })),
      btn('Restore', 'small', () => restoreVersion(place, version))))));
}

async function restoreVersion(place, version, undo) {
  if (!undo) {
    const players = playersIn(place);
    const restart = players ? ` ${plural(players, 'player')} are saved, then the servers restart.` : '';
    if (!await ask(`Restore the file from ${when(version.savedAt)}?`, `It becomes version ${place.version + 1}, and the current file goes to Previous versions.${restart}`, 'Restore')) return;
  }
  const result = await act(() => change('POST', `/api/places/${place.placeId}/versions/${encodeURIComponent(version.id)}/restore`, '{}'),
    undo ? 'Putting the old file back' : 'Restoring', undo ? 'Undone' : 'Restored');
  if (!result) return;
  if (undo) replacing = null;
  versionsKey = `${place.placeId}:${result.place.version}`;
  versions = { placeId: place.placeId, version: result.place.version, list: result.versions || [] };
  renderGame(false);
}

function restoreCard(result) {
  const shown = result.stillZero.slice(0, 1000).map((entry) => `${entry.path}  (${entry.reason})`);
  if (result.stillZero.length > shown.length) shown.push(`... and ${result.stillZero.length - shown.length} more`);
  return h('div', { class: 'card restore-result' },
    h('b', { text: result.restored.length ? `Restored ${plural(result.restored.length, 'value')} from ${result.file}` : `Nothing to fix from ${result.file}` }),
    result.stillZero.length ? h('details', { class: 'notes', open: result.open, ontoggle: (event) => { result.open = event.target.open; } },
      h('summary', { text: `Still 0 (${result.stillZero.length})` }), h('pre', { text: shown.join('\n') })) : null);
}

// --- upload a game ---------------------------------------------------------------------------

let uploadedId = null;
function openUpload() {
  $('upload-form').reset();
  $('upload-enabled').checked = true;
  $('upload-file-name').textContent = 'Choose a .rbxl or .rbxlx file, or drop it here';
  $('upload-fields').hidden = false;
  $('upload-done').hidden = true;
  $('upload-button').hidden = false;
  $('upload-open-game').hidden = true;
  $('upload-cancel').textContent = 'Cancel';
  $('upload-status').textContent = '';
  $('upload-status').className = 'modal-status';
  $('upload').showModal();
}
function closeUpload() { if (!$('upload-button').disabled) $('upload').close(); }

function setUpGames() {
  $('games-filter').addEventListener('input', () => { games.text = $('games-filter').value; renderGames(); });
  for (const button of document.querySelectorAll('#games-state button')) {
    button.addEventListener('click', () => { games.state = button.dataset.filter; renderGames(); });
  }
  $('games-engine').addEventListener('change', () => { games.engine = $('games-engine').value; renderGames(); });
  $('games-sort').addEventListener('change', () => { games.sort = $('games-sort').value; sortGames(); renderGames(); });
  $('games-all').addEventListener('change', () => {
    const shown = data.places.filter(gameMatches).map((place) => place.placeId);
    for (const id of shown) { if ($('games-all').checked) games.selected.add(id); else games.selected.delete(id); }
    renderGames();
  });

  $('upload-open').addEventListener('click', openUpload);
  $('upload-close').addEventListener('click', closeUpload);
  $('upload-cancel').addEventListener('click', closeUpload);
  $('upload').addEventListener('cancel', (event) => { if ($('upload-button').disabled) event.preventDefault(); });
  $('upload-open-game').addEventListener('click', () => { $('upload').close(); if (uploadedId) location.hash = `games/${uploadedId}`; });

  // A place file dropped anywhere on the Games view opens Upload with it.
  const gamesView = document.querySelector('section[data-view="games"]');
  gamesView.addEventListener('dragover', (event) => {
    if (!hasFiles(event) || $('upload').open) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    gamesView.classList.add('dropping');
  });
  gamesView.addEventListener('dragleave', (event) => {
    if (!gamesView.contains(event.relatedTarget)) gamesView.classList.remove('dropping');
  });
  gamesView.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    gamesView.classList.remove('dropping');
    const file = event.dataTransfer.files[0];
    if (!file || !/\.rbx[lm]x?$/i.test(file.name)) { toast(`${file ? file.name : 'That'} isn't a place file. Use a .rbxl or .rbxlx.`, 'error'); return; }
    openUpload();
    $('upload-file').files = event.dataTransfer.files;
    $('upload-file').dispatchEvent(new Event('change'));
    $('upload-name').focus();
  });

  $('upload-file').addEventListener('change', () => {
    const file = $('upload-file').files[0];
    $('upload-file-name').textContent = file ? `${file.name} (${size(file.size)})` : 'Choose a .rbxl or .rbxlx file, or drop it here';
    if (file && !$('upload-name').value) $('upload-name').value = file.name.replace(/\.rbx[lm]x?$/i, '').slice(0, 60);
  });
  const drop = $('upload-drop');
  drop.addEventListener('dragover', () => drop.classList.add('over'));
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('over'));

  $('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = $('upload-file').files[0];
    const status = $('upload-status');
    const from = $('upload-from').value.trim();
    if (!file) return;
    if (from && !/^\d{1,15}$/.test(from)) {
      status.textContent = 'The Roblox place ID is a number.';
      status.className = 'modal-status error';
      return;
    }
    const query = new URLSearchParams({ name: $('upload-name').value.trim(), description: $('upload-description').value.trim(), enabled: $('upload-enabled').checked ? '1' : '0' });
    if (from) query.set('fromPlace', from);
    $('upload-button').disabled = true;
    $('upload-cancel').disabled = true;
    $('upload-progress').hidden = false;
    status.className = 'modal-status';
    status.textContent = 'Uploading';
    busy = true;
    try {
      const result = await uploadFile(`/api/places?${query}`, file, (percent) => {
        $('upload-progress').value = percent;
        status.textContent = percent < 100 ? `Uploading ${percent}%` : 'Converting';
      });
      uploadedId = result.place.placeId;
      $('upload-fields').hidden = true;
      $('upload-done').hidden = false;
      $('upload-done-line').textContent = `${result.place.name} is place ${result.place.placeId}.`;
      $('upload-notes').textContent = (result.notes || []).join('\n');
      $('upload-notes-box').hidden = !(result.notes || []).length;
      $('upload-button').hidden = true;
      $('upload-open-game').hidden = false;
      $('upload-cancel').textContent = 'Close';
      status.textContent = '';
    } catch (error) {
      status.textContent = error.message;
      status.className = 'modal-status error';
    } finally {
      busy = false;
      $('upload-button').disabled = false;
      $('upload-cancel').disabled = false;
      $('upload-progress').hidden = true;
      $('upload-progress').value = 0;
      loadPlaces();
    }
  });

  // The game page's hidden inputs
  $('replace-file').addEventListener('change', () => { if (pendingPlace) chooseReplacement(pendingPlace, $('replace-file').files[0]); });
  $('restore-file').addEventListener('change', async () => {
    const file = $('restore-file').files[0];
    const place = pendingPlace;
    if (!file || !place) return;
    if (!await ask(`Fix zeroed numbers in ${place.name}?`, `IntValues that are 0 get their numbers from ${file.name}. Nothing else changes. Running servers restart, and the old version is kept.`, 'Fix')) return;
    act(async (note) => {
      const result = await uploadFile(`/api/places/${place.placeId}/restore-values?name=${encodeURIComponent(file.name)}`, file,
        (percent) => note.say(percent < 100 ? `Uploading ${percent}%` : 'Comparing'));
      const missingFirst = (entry) => (entry.reason === 'no counterpart' ? 0 : 1);
      restoreResult = { placeId: place.placeId, file: file.name, restored: result.restored, stillZero: result.stillZero.sort((a, b) => missingFirst(a) - missingFirst(b)) };
    }, `Uploading ${file.name}`, 'Done');
  });
  $('thumb-file').addEventListener('change', () => {
    const file = $('thumb-file').files[0];
    const place = pendingPlace;
    if (!file || !place) return;
    if (file.size > 4 * 1024 * 1024) { toast('Icons can be up to 4 MB.', 'error'); return; }
    act(() => change('POST', `/api/thumbnails/${place.placeId}`, file, 'application/octet-stream'), 'Uploading the icon', 'Icon changed');
  });

  // Drop a file anywhere on the File tab.
  const filesPane = $('pane-files');
  filesPane.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = uploading() ? 'none' : 'copy';
    filesPane.classList.add('dragging');
  });
  filesPane.addEventListener('dragleave', (event) => {
    if (!filesPane.contains(event.relatedTarget)) filesPane.classList.remove('dragging');
  });
  filesPane.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    filesPane.classList.remove('dragging');
    const place = placeById(game.id);
    if (place) chooseReplacement(place, event.dataTransfer.files[0]);
  });
}

views.games = {
  show(args, changed) {
    if (changed) sortGames();
    renderGames();
  },
  render(what) {
    if (['places', 'overview'].includes(what)) renderGames();
  },
};

views.game = {
  show(args) {
    const [id, tab] = args;
    const switched = game.id !== id;
    game.id = id;
    game.tab = TABS.includes(tab) ? tab : 'overview';
    if (switched) {
      $('pane-settings').dataset.id = '';
      $('pane-log').replaceChildren();
      game.log = { placeId: null, lines: null, errorsOnly: false, text: '' };
      game.reportFilter = 'all';
      game.reportText = '';
      const place = placeById(id);
      if (place) loadYears(place);
    }
    renderGame(switched);
  },
  render(what) {
    if (['places', 'overview', 'missing', 'reports'].includes(what)) renderGame(false);
  },
  tick(current) {
    if (current === 'game' && game.tab === 'log' && placeById(game.id)) loadGameLog(placeById(game.id));
  },
  dirty: () => game.dirty,
  // Leaving a game (or its Settings tab) with unsaved settings asks first.
  async leave(next, args) {
    if (!game.dirty) return true;
    if (next === 'game' && args[0] === game.id && (args[1] || 'overview') === 'settings') return true;
    const place = placeById(game.id);
    if (!await ask('Discard your changes?', place ? `${place.name}'s settings aren't saved.` : '', 'Discard', true)) {
      history.replaceState(null, '', `#games/${game.id}/settings`);
      return false;
    }
    game.dirty = false;
    return true;
  },
};

document.addEventListener('DOMContentLoaded', setUpGames);
