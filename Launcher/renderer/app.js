'use strict';

const api = window.launcher;
const $ = (id) => document.getElementById(id);
let state = null;
let formsFilled = false;
let playersTimer = null;
let view = 'home';
let lastGames = [];
let detailGame = null;

// --- helpers --------------------------------------------------------------------

// Electron wraps errors from the main process; show only the message.
function message(error) {
  return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function appendLog(area, line, time) {
  const el = $(`log-${area}`);
  if (!el) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += `${time}  ${line}\n`;
  const lines = el.textContent.split('\n');
  if (lines.length > 400) el.textContent = lines.slice(-400).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname.toLowerCase(); } catch (error) { return ''; }
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (error) { /* storage blocked */ }
  return null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- cover art --------------------------------------------------------------------

// Generated cover for a game: colors from its name (Lumber Tycoon gets
// forest colors), studs, a blocky horizon and the name in big letters.
function coverColors(name) {
  if (/lumber/i.test(name)) return ['#3f8f3a', '#1f5a2a', '#7a5228'];
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return [`hsl(${hue}, 62%, 48%)`, `hsl(${(hue + 40) % 360}, 58%, 30%)`, `hsl(${(hue + 200) % 360}, 40%, 30%)`];
}

function cover(game) {
  const [a, b, c] = coverColors(game.name);
  const node = el('div', 'cover');
  node.style.background = `linear-gradient(160deg, ${a} 0%, ${b} 62%, ${c} 100%)`;
  node.append(el('div', 'cover-title', game.name));
  // A host's own thumbnail replaces the generated art once it has loaded.
  if (game.thumbnail && game.placeId) {
    api.gameThumbnail({ centralUrl: $('play-server').value.trim(), placeId: game.placeId, version: game.thumbnail }).then((dataUrl) => {
      if (!dataUrl) return;
      const img = el('img', 'cover-img');
      img.alt = '';
      img.src = dataUrl;
      node.prepend(img);
      node.classList.add('has-image');
    });
  }
  return node;
}

function gameTile(game, options = {}) {
  const tile = el('button', 'game-tile nav-target');
  tile.append(cover(game));
  if (options.badge) tile.append(el('span', `tile-badge${options.live ? ' live' : ''}`, options.badge));
  if (options.caption) tile.append(el('div', 'caption', options.caption));
  tile.addEventListener('click', () => openDetail(game));
  return tile;
}

function placeholder(text, big, onClick) {
  const tile = el('button', `game-tile placeholder${onClick ? ' nav-target' : ' dim'}`);
  if (big) tile.append(el('b', '', big));
  tile.append(document.createTextNode(text));
  if (onClick) tile.addEventListener('click', onClick);
  else tile.tabIndex = -1;
  return tile;
}

// --- views and navigation -----------------------------------------------------------

let VIEWS = ['home', 'games', 'host', 'web', 'setup'];

// A player install (no server files) cannot host or run the web server:
// those tabs go away.
let capabilitiesApplied = false;
function applyCapabilities() {
  capabilitiesApplied = true;
  if (state.canHost) return;
  VIEWS = VIEWS.filter((name) => name !== 'host' && name !== 'web');
  for (const name of ['host', 'web']) {
    const link = document.querySelector(`.tab-link[data-view="${name}"]`);
    if (link) link.classList.add('hidden');
  }
  // Converting places is for hosts (the server's /manage page converts uploads).
  $('convert-panel').classList.add('hidden');
}

// Without roblox-logo.png (it is not in the git repository) the header shows text.
const logo = document.querySelector('.logo');
const logoFallback = () => logo.replaceWith(el('div', 'logo-text', 'ROBLOX'));
logo.addEventListener('error', logoFallback);
if (logo.complete && logo.naturalWidth === 0) logoFallback();

function showView(name, focusContent) {
  view = name;
  document.querySelectorAll('.tab-link').forEach((link) => link.classList.toggle('active', link.dataset.view === name));
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${name}`));
  if (name === 'setup') refreshChecks();
  if (name === 'host') loadHostThumbnail();
  if (name === 'games' || name === 'home') findGames(true);
  if (focusContent) {
    const first = firstFocusable(`#view-${name}`);
    if (first) focusEl(first);
  }
}

function focusables(scope) {
  return [...document.querySelectorAll(`${scope} button, ${scope} input, ${scope} select, ${scope} summary`)]
    .filter((node) => !node.disabled && node.tabIndex !== -1 && node.offsetParent !== null);
}

function firstFocusable(scope) {
  return focusables(scope)[0] || null;
}

function focusEl(node) {
  if (!node) return;
  document.querySelectorAll('.focused').forEach((other) => other.classList.remove('focused'));
  if (node.classList.contains('game-tile') || node.classList.contains('avatar-panel') || node.classList.contains('more')) node.classList.add('focused');
  node.focus({ preventScroll: false });
  node.scrollIntoView({ block: 'nearest' });
}

// Spatial navigation: the nearest focusable control in the pressed direction,
// among the tab bar and the open view (or the details card when it is open).
function move(dx, dy) {
  const overlayOpen = !$('overlay').classList.contains('hidden');
  const pool = overlayOpen ? focusables('#overlay') : [...focusables('#tabs'), ...focusables(`#view-${view}`), $('settings-hint')];
  const current = document.activeElement && pool.includes(document.activeElement) ? document.activeElement : null;
  if (!current) { focusEl(pool.find((node) => node.classList.contains('tab-link') && node.classList.contains('active')) || pool[0]); return; }
  // Left/right in the tab bar switches tabs right away, like a console.
  if (current.classList.contains('tab-link') && dx) {
    const index = VIEWS.indexOf(current.dataset.view);
    const next = VIEWS[(index + dx + VIEWS.length) % VIEWS.length];
    showView(next);
    focusEl(document.querySelector(`.tab-link[data-view="${next}"]`));
    return;
  }
  const box = current.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const node of pool) {
    if (node === current) continue;
    const b = node.getBoundingClientRect();
    const x = (dx > 0 ? b.left : dx < 0 ? b.right : b.left + b.width / 2) - (dx > 0 ? box.right : dx < 0 ? box.left : cx);
    const y = (dy > 0 ? b.top : dy < 0 ? b.bottom : b.top + b.height / 2) - (dy > 0 ? box.bottom : dy < 0 ? box.top : cy);
    const along = dx ? x * dx : y * dy;
    if (along < -2) continue;
    const across = dx ? Math.abs((b.top + b.height / 2) - cy) : Math.abs((b.left + b.width / 2) - cx);
    const score = Math.max(0, along) + across * 1.6;
    if (score < bestScore) { bestScore = score; best = node; }
  }
  if (best) focusEl(best);
}

function goBack() {
  if (!$('overlay').classList.contains('hidden')) { closeDetail(); return; }
  const active = document.activeElement;
  if (active && active.closest('.view')) {
    focusEl(document.querySelector(`.tab-link[data-view="${view}"]`));
    return;
  }
  if (view !== 'home') {
    showView('home');
    focusEl(document.querySelector('.tab-link[data-view="home"]'));
  }
}

function select() {
  const node = document.activeElement;
  if (!node || node === document.body || node.tagName === 'INPUT') return;
  node.click();
}

function switchTab(step) {
  const next = VIEWS[(VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length];
  showView(next);
  focusEl(document.querySelector(`.tab-link[data-view="${next}"]`));
}

document.querySelectorAll('.tab-link').forEach((link) => link.addEventListener('click', () => showView(link.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((node) => node.addEventListener('click', () => showView(node.dataset.goto, true)));
$('settings-hint').addEventListener('click', () => showView('setup', true));
document.addEventListener('mouseover', (event) => {
  const tile = event.target.closest && event.target.closest('.game-tile.nav-target, .avatar-panel, .more');
  if (tile) focusEl(tile);
});

document.addEventListener('keydown', (event) => {
  const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT');
  if (event.key === 'Escape') { event.preventDefault(); goBack(); return; }
  if (event.key === 'PageUp') { switchTab(-1); return; }
  if (event.key === 'PageDown') { switchTab(1); return; }
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (dirs[event.key] && !(typing && dirs[event.key][0])) {
    if (typing && event.target.tagName === 'SELECT') return;
    event.preventDefault();
    move(...dirs[event.key]);
    return;
  }
  if (typing) return;
  if (event.key === 'm' || event.key === 'M') toggleMusic();
});

// Controller (Xbox layout): stick/d-pad move, A select, B back, X settings,
// Y music, LB/RB switch tabs.
const pad = { pressed: {}, nextRepeat: 0, held: false };
function pollGamepad(time) {
  const gamepad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
  if (gamepad) {
    const button = (i) => Boolean(gamepad.buttons[i] && gamepad.buttons[i].pressed);
    const edge = (i, action) => {
      const now = button(i);
      if (now && !pad.pressed[i]) action();
      pad.pressed[i] = now;
    };
    edge(0, select);
    edge(1, goBack);
    edge(2, () => showView('setup', true));
    edge(3, toggleMusic);
    edge(4, () => switchTab(-1));
    edge(5, () => switchTab(1));
    const x = (button(15) ? 1 : 0) - (button(14) ? 1 : 0) || (Math.abs(gamepad.axes[0]) > 0.6 ? Math.sign(gamepad.axes[0]) : 0);
    const y = (button(13) ? 1 : 0) - (button(12) ? 1 : 0) || (Math.abs(gamepad.axes[1]) > 0.6 ? Math.sign(gamepad.axes[1]) : 0);
    if ((x || y) && time >= pad.nextRepeat) {
      move(y ? 0 : x, y);
      pad.nextRepeat = time + (pad.held ? 150 : 380);
      pad.held = true;
    } else if (!x && !y) {
      pad.held = false;
      pad.nextRepeat = 0;
    }
  }
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);

// --- music and background ------------------------------------------------------------

const music = $('music');
music.volume = 0.45;
const musicWanted = () => storage('music') !== 'off';

function updateMusic() {
  const available = Boolean(state && state.hasMusic);
  const clientRunning = Boolean(state && state.play.active);
  window.backgroundPaused = clientRunning; // no animation while the game runs
  $('toggle-music').textContent = `Music: ${musicWanted() ? 'On' : 'Off'}`;
  $('music-hint').textContent = available ? '' : 'Put an MP3 at config\\menu-music.mp3 to play menu music.';
  if (!available) return;
  if (!music.src) music.src = 'launcher-media://menu-music';
  if (musicWanted() && !clientRunning) music.play().catch(() => {});
  else music.pause();
}

function toggleMusic() {
  storage('music', musicWanted() ? 'off' : 'on');
  updateMusic();
}

function updateBackgroundButton() {
  $('toggle-background').textContent = `Background: ${window.backgroundMode === 'sunset' ? 'Sunset' : 'Neon grid'}`;
}

$('toggle-music').addEventListener('click', toggleMusic);
$('toggle-background').addEventListener('click', () => {
  window.backgroundMode = window.backgroundMode === 'sunset' ? 'neon' : 'sunset';
  storage('background', window.backgroundMode);
  updateBackgroundButton();
});

function tick() {
  $('top-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tick();
setInterval(tick, 10000);

// --- avatar ------------------------------------------------------------------------

let avatarFor = null;
let avatarTimer = null;
function loadAvatar() {
  const name = $('play-username').value.trim();
  $('home-username').textContent = name ? name.toUpperCase() : 'GUEST';
  if (name === avatarFor) return;
  clearTimeout(avatarTimer);
  avatarTimer = setTimeout(async () => {
    avatarFor = name;
    const image = name ? await api.avatar(name) : null;
    if (avatarFor !== name) return;
    $('avatar-img').classList.toggle('hidden', !image);
    $('avatar-silhouette').classList.toggle('hidden', Boolean(image));
    if (image) $('avatar-img').src = image;
  }, 600);
}

// --- home ---------------------------------------------------------------------------

function recentList() {
  try { return JSON.parse(storage('recent') || '[]'); } catch (error) { return []; }
}

function rememberPlayed(game) {
  const list = recentList().filter((entry) => !(entry.name === game.name && entry.address === game.address));
  list.unshift({ name: game.name, placeId: game.placeId, address: game.address, thumbnail: game.thumbnail || null, when: Date.now() });
  storage('recent', JSON.stringify(list.slice(0, 6)));
}

// An online game matching a remembered one (game IDs change every restart).
function onlineMatch(entry) {
  return lastGames.find((game) => game.name === entry.name && game.address === entry.address)
    || lastGames.find((game) => game.name === entry.name) || null;
}

function renderHome() {
  // Status column
  const rows = [
    ['Games online', String(lastGames.length)],
    ['Hosting', state && state.host.active ? state.host.publicAddress : 'No'],
    ['Web server', state && state.web.running ? 'Running' : 'Stopped'],
    ['Tailscale', state && state.web.tailscaleUrl ? hostOf(state.web.tailscaleUrl) : 'Not connected'],
  ];
  const status = $('home-status');
  status.textContent = '';
  for (const [label, value] of rows) {
    const row = el('div', 'status-row', label);
    row.append(el('b', '', value));
    status.append(row);
  }

  // Recently played: one big tile, two small ones.
  const recent = $('recent-grid');
  const focusedBefore = document.activeElement;
  const keepFocus = focusedBefore && focusedBefore.closest && focusedBefore.closest('#view-home');
  recent.textContent = '';
  const played = recentList();
  for (let i = 0; i < 3; i++) {
    const entry = played[i];
    if (!entry) {
      recent.append(i === 0 ? placeholder('Games you join show up here.', '▶', () => showView('games', true)) : placeholder(''));
      continue;
    }
    const online = onlineMatch(entry);
    recent.append(gameTile(online || entry, { badge: online ? 'ONLINE' : 'OFFLINE', live: Boolean(online) }));
  }

  // Online games: up to six.
  const grid = $('online-grid');
  grid.textContent = '';
  for (let i = 0; i < 6; i++) {
    const game = lastGames[i];
    if (game) grid.append(gameTile(game, { badge: `UP ${formatUptime(game.upSeconds).toUpperCase()}` }));
    else if (i === lastGames.length && state && state.canHost) grid.append(placeholder('Host a game', '+', () => showView('host', true)));
    else if (i === lastGames.length) grid.append(placeholder(lastGames.length ? 'More games show up here.' : 'No games online yet.', '·'));
    else grid.append(placeholder(''));
  }
  if (keepFocus && !document.activeElement.closest('#view-home')) {
    const first = firstFocusable('#view-home');
    if (first && document.activeElement === document.body) focusEl(first);
  }
}

// --- game details ----------------------------------------------------------------------

function openDetail(game) {
  detailGame = onlineMatch(game) || (game.id ? game : null) || game;
  const playable = Boolean(detailGame.id && lastGames.includes(detailGame));
  const box = $('detail-cover');
  box.textContent = '';
  box.append(cover(detailGame));
  $('detail-name').textContent = detailGame.name;
  $('detail-meta').textContent = playable
    ? `Place ${detailGame.placeId} · up ${formatUptime(detailGame.upSeconds)}\nServer ${detailGame.address}`
    : `Place ${detailGame.placeId || '?'} · ${detailGame.address || ''}`;
  $('detail-meta').style.whiteSpace = 'pre-line';
  $('detail-desc').textContent = detailGame.description || '';
  $('detail-note').textContent = playable ? (state && state.play.active ? 'The client is already running.' : '') : 'This game is not online right now.';
  $('detail-play').disabled = !playable || Boolean(state && state.play.active);
  $('overlay').classList.remove('hidden');
  focusEl($('detail-play').disabled ? $('detail-back') : $('detail-play'));
}

function closeDetail() {
  $('overlay').classList.add('hidden');
  const first = firstFocusable(`#view-${view}`);
  if (first) focusEl(first);
}

$('detail-back').addEventListener('click', closeDetail);
$('detail-play').addEventListener('click', async () => {
  if (!detailGame) return;
  $('detail-play').disabled = true;
  $('detail-note').textContent = 'Starting the client…';
  try {
    await api.join({ centralUrl: $('play-server').value.trim(), username: $('play-username').value.trim(), game: detailGame });
    rememberPlayed(detailGame);
    $('detail-note').textContent = 'Have fun!';
    setTimeout(() => { closeDetail(); renderHome(); }, 900);
  } catch (error) {
    $('detail-note').textContent = message(error);
    $('detail-play').disabled = false;
  }
});

// --- state -----------------------------------------------------------------------------

async function refreshState() {
  state = await api.state();
  if (!capabilitiesApplied) applyCapabilities();
  if (!formsFilled) fillForms();
  $('presence-dot').className = `presence-dot${state.web.tailscaleUrl ? ' on' : ''}`;

  // Games / play
  $('play-close').classList.toggle('hidden', !state.play.active);
  if (state.play.active) setStatus('play-status', 'The client is running.', 'good');
  else if ($('play-status').textContent === 'The client is running.') setStatus('play-status', 'The client closed.');

  // Host
  $('host-start').classList.toggle('hidden', state.host.active);
  $('host-stop').classList.toggle('hidden', !state.host.active);
  $('host-live').classList.toggle('hidden', !state.host.active);
  document.querySelectorAll('#view-host input, #view-host select').forEach((node) => { node.disabled = state.host.active; });
  if (state.host.active) {
    $('host-address').textContent = state.host.publicAddress;
    setStatus('host-status', `Hosting (game ${state.host.gameId}).`, 'good');
    if (!playersTimer) { refreshPlayers(); playersTimer = setInterval(refreshPlayers, 8000); }
  } else {
    if (playersTimer) { clearInterval(playersTimer); playersTimer = null; }
    if ($('host-status').classList.contains('good')) setStatus('host-status', 'Not hosting.');
  }

  // Server
  $('web-pill').textContent = state.web.running ? (state.web.managed ? 'Running' : 'Running (started outside the launcher)') : 'Stopped';
  $('web-pill').className = `pill${state.web.running ? ' on' : ''}`;
  $('web-start').disabled = state.web.running;
  $('web-stop').disabled = !state.web.running;
  $('web-tailscale').textContent = state.web.tailscaleUrl || 'Tailscale not connected';
  $('web-copy').disabled = !state.web.tailscaleUrl;
  updateHostKeyField();
  updateMusic();
  if (view === 'home' && $('overlay').classList.contains('hidden')) renderHome();
}

function fillForms() {
  formsFilled = true;
  const client = state.clientConfig || {};
  $('play-server').value = client.centralUrl || 'http://127.0.0.1';
  $('play-username').value = client.username || '';
  const host = state.hostConfig || {};
  $('host-name').value = host.gameName || '';
  $('host-place').value = host.placeId || '1818';
  $('host-port').value = host.gamePort || 53640;
  const tailscale = /^tailscale:/i.test(host.publicAddress || '') || !host.publicAddress;
  $('host-reach').value = tailscale ? 'tailscale' : 'custom';
  $('host-custom').value = tailscale ? '' : host.publicAddress;
  $('host-central').value = host.centralUrl || 'http://127.0.0.1';
  $('host-key').value = host.hostKey || '';
  updateReach();
  loadAvatar();
}

function updateReach() {
  $('host-custom-wrap').classList.toggle('hidden', $('host-reach').value !== 'custom');
}

function updateHostKeyField() {
  const host = hostOf($('host-central').value);
  const own = state && state.web.tailscaleUrl ? hostOf(state.web.tailscaleUrl) : '';
  const local = host === '' || host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === own;
  $('host-key-wrap').classList.toggle('hidden', local);
}

$('host-reach').addEventListener('change', updateReach);
$('host-central').addEventListener('input', updateHostKeyField);
$('play-username').addEventListener('input', loadAvatar);

// --- games ------------------------------------------------------------------------------

let findingGames = false;
async function findGames(quiet) {
  if (findingGames) return;
  findingGames = true;
  if (!quiet) setStatus('play-status', 'Looking for games…');
  $('play-refresh').disabled = true;
  try {
    lastGames = await api.games($('play-server').value.trim());
    setStatus('play-status', lastGames.length ? `${lastGames.length} game${lastGames.length === 1 ? '' : 's'} online.` : 'No games are online right now.');
  } catch (error) {
    lastGames = [];
    setStatus('play-status', message(error), 'error');
  } finally {
    findingGames = false;
    $('play-refresh').disabled = false;
    renderAllGames();
    if (view === 'home') renderHome();
  }
}

function renderAllGames() {
  const list = $('all-games');
  list.textContent = '';
  for (const game of lastGames) {
    list.append(gameTile(game, { caption: `Place ${game.placeId} · up ${formatUptime(game.upSeconds)}` }));
  }
  if (lastGames.length === 0) list.append(placeholder('No games online. Host one, or ask your host to start theirs.', '·'));
}

$('play-refresh').addEventListener('click', () => findGames(false));
// The server's management page (upload games, turn them on or off...).
$('play-manage').addEventListener('click', async () => {
  try {
    await api.openManage($('play-server').value.trim());
  } catch (error) {
    setStatus('play-status', message(error), 'error');
  }
});
$('web-manage').addEventListener('click', () => api.openManage('http://127.0.0.1').catch(() => {}));
$('play-close').addEventListener('click', () => api.stopClient());

// --- host --------------------------------------------------------------------------------

async function refreshPlayers() {
  const names = await api.players();
  $('host-players').textContent = names === null ? 'server busy…' : (names.length ? names.join(', ') : 'nobody yet');
}

$('host-start').addEventListener('click', async () => {
  const port = Number($('host-port').value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    setStatus('host-status', 'The game port must be a number from 1024 to 65535.', 'error');
    return;
  }
  const custom = $('host-custom').value.trim();
  if ($('host-reach').value === 'custom' && !/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/.test(custom)) {
    setStatus('host-status', 'The public game address must look like host:port.', 'error');
    return;
  }
  const config = {
    gameName: $('host-name').value.trim() || 'My game',
    placeId: $('host-place').value.trim() || '1818',
    gamePort: port,
    publicAddress: $('host-reach').value === 'tailscale' ? `tailscale:${port}` : custom,
    centralUrl: $('host-central').value.trim() || 'http://127.0.0.1',
  };
  if (!$('host-key-wrap').classList.contains('hidden')) config.hostKey = $('host-key').value.trim();
  $('host-start').disabled = true;
  setStatus('host-status', 'Starting the game server… (about 10 seconds)');
  try {
    await api.startHosting(config);
  } catch (error) {
    setStatus('host-status', message(error), 'error');
  } finally {
    $('host-start').disabled = false;
    refreshState();
    findGames(true);
  }
});

$('host-stop').addEventListener('click', async () => {
  $('host-stop').disabled = true;
  setStatus('host-status', 'Stopping…');
  await api.stopHosting();
  $('host-stop').disabled = false;
  setStatus('host-status', 'Not hosting.');
  refreshState();
  findGames(true);
});

// Game thumbnail: kept on the web server for the place ID in the form.
function thumbOptions(action) {
  return {
    action,
    centralUrl: $('host-central').value.trim() || 'http://127.0.0.1',
    placeId: $('host-place').value.trim(),
    hostKey: $('host-key').value.trim(),
  };
}

function showThumbnail(dataUrl) {
  const box = $('thumb-preview');
  box.textContent = dataUrl ? '' : 'No thumbnail';
  if (dataUrl) {
    const img = el('img');
    img.alt = '';
    img.src = dataUrl;
    box.append(img);
  }
  $('thumb-remove').classList.toggle('hidden', !dataUrl);
}

let thumbTimer = null;
function loadHostThumbnail() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    if (!/^\d{1,15}$/.test($('host-place').value.trim())) {
      showThumbnail(null);
      return;
    }
    try {
      showThumbnail((await api.hostThumbnail(thumbOptions('get'))).dataUrl);
    } catch (error) {
      showThumbnail(null);
    }
  }, 300);
}

$('thumb-pick').addEventListener('click', async () => {
  setStatus('thumb-status', 'Uploading…');
  try {
    const result = await api.hostThumbnail(thumbOptions('pick'));
    if (result.canceled) {
      setStatus('thumb-status', '');
      return;
    }
    showThumbnail(result.dataUrl);
    setStatus('thumb-status', 'Saved. Players see it on their next refresh.', 'good');
    findGames(true);
  } catch (error) {
    setStatus('thumb-status', message(error), 'error');
  }
});

$('thumb-remove').addEventListener('click', async () => {
  setStatus('thumb-status', 'Removing…');
  try {
    await api.hostThumbnail(thumbOptions('remove'));
    showThumbnail(null);
    setStatus('thumb-status', 'Removed.');
    findGames(true);
  } catch (error) {
    setStatus('thumb-status', message(error), 'error');
  }
});

$('host-place').addEventListener('input', loadHostThumbnail);
$('host-central').addEventListener('change', loadHostThumbnail);

// --- server ------------------------------------------------------------------------------

$('web-start').addEventListener('click', async () => { $('web-start').disabled = true; await api.startWeb(); refreshState(); findGames(true); });
$('web-stop').addEventListener('click', async () => { $('web-stop').disabled = true; await api.stopWeb(); refreshState(); });
$('web-copy').addEventListener('click', async () => {
  if (!state.web.tailscaleUrl) return;
  await api.copy(state.web.tailscaleUrl);
  $('web-copy').textContent = 'Copied';
  setTimeout(() => { $('web-copy').textContent = 'Copy'; }, 1500);
});

// --- setup --------------------------------------------------------------------------------

const ACTION_LABELS = {
  hosts: 'Add hosts entries (admin)',
  firewall: 'Open firewall for Tailscale (admin)',
  'tailscale-download': 'Get Tailscale',
};

async function refreshChecks() {
  const list = $('setup-checks');
  list.textContent = 'Checking…';
  const results = await api.checks();
  list.textContent = '';
  for (const check of results) {
    const row = el('div', 'check');
    row.append(el('div', `check-mark ${check.ok ? 'ok' : 'no'}`, check.ok ? '✓' : '!'));
    const text = el('div', 'check-text');
    text.append(el('div', '', check.label), el('div', 'check-detail', check.detail));
    row.append(text);
    if (check.action) {
      const button = el('button', 'ghost small', ACTION_LABELS[check.action] || 'Fix');
      button.addEventListener('click', async () => {
        await api.runSetup(check.action);
        button.textContent = 'Started — check again when done';
      });
      row.append(button);
    }
    list.append(row);
  }
}

// Place converter.
let convertedPlace = null;
$('convert-pick').addEventListener('click', async () => {
  const status = $('convert-status');
  const report = $('convert-report');
  const placeId = $('convert-place-id').value.trim();
  if (placeId !== '' && !/^\d{1,15}$/.test(placeId)) {
    status.textContent = 'The place ID is a number, like 13822889.';
    return;
  }
  status.textContent = 'Converting…';
  const result = await api.convertPlace({ robloxPlaceId: placeId });
  if (result.canceled) {
    status.textContent = '';
    return;
  }
  report.classList.remove('hidden');
  if (!result.ok) {
    convertedPlace = null;
    $('convert-install').classList.add('hidden');
    status.textContent = 'Could not convert';
    report.textContent = result.error;
    return;
  }
  convertedPlace = result.output;
  status.textContent = `Saved ${result.output.split(/[\\/]/).pop()}`;
  report.textContent = [...(result.universeId ? [`Universe ${result.universeId}`] : []), ...result.summary, '', `Saved to ${result.output}`].join('\n');
  $('convert-install').classList.remove('hidden');
});
$('convert-install').addEventListener('click', async () => {
  if (!convertedPlace) return;
  const result = await api.installPlace(convertedPlace);
  if (result.ok) {
    $('convert-status').textContent = `Now hosted${result.backup ? ` (old place kept as ${result.backup})` : ''}. Restart hosting to load it.`;
    $('convert-install').classList.add('hidden');
  } else if (!result.canceled) {
    $('convert-status').textContent = result.error || 'Could not make it the hosted place.';
  }
});

$('setup-refresh').addEventListener('click', refreshChecks);
$('open-root').addEventListener('click', () => api.openFolder('root'));
$('open-config').addEventListener('click', () => api.openFolder('config'));
$('open-logs').addEventListener('click', () => api.openFolder('logs'));

// --- start ----------------------------------------------------------------------------------

api.onLog(({ area, line, time }) => appendLog(area, line, time));
api.onStatusChanged(() => refreshState());

updateBackgroundButton();
refreshState().then(() => {
  renderHome();
  findGames(true);
  focusEl(firstFocusable('#view-home'));
});
setInterval(refreshState, 5000);
setInterval(() => { if (view === 'home' || view === 'games') findGames(true); }, 15000);
