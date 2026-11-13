'use strict';

// The launcher window, laid out like the 2016-2017 Xbox One app:
//   start screen ("press A") -> sign in / sign up / play as a guest -> tabs
//   Home · Avatar · Games · Players · Settings
// Accounts live on the web server (the same ones Roblox Studio uses); the
// main process keeps the session (account.js). Guests join as "Guest_1234"
// with the guest look, like 2016's guests.

const api = window.launcher;
const $ = (id) => document.getElementById(id);
let state = null;
let formsFilled = false;
let hostPlayersTimer = null;
let view = 'home';
let screen = 'start';
let lastGames = [];
let detailGame = null;
let me = null; // { account: { name, userId, admin }, offline } when signed in
let guest = false;
let settingsPanel = 'account';

// --- helpers --------------------------------------------------------------------

// Electron wraps errors from the main process; show only the message.
function message(error) {
  return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function setStatus(id, text, kind) {
  const node = $(id);
  if (!node) return;
  node.textContent = text || '';
  node.className = `${node.classList.contains('account-note') ? 'account-note' : 'status'}${kind ? ` ${kind}` : ''}`;
}

function appendLog(area, line, time) {
  const node = $(`log-${area}`);
  if (!node) return;
  const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
  node.textContent += `${time}  ${line}\n`;
  const lines = node.textContent.split('\n');
  if (lines.length > 400) node.textContent = lines.slice(-400).join('\n');
  if (atBottom) node.scrollTop = node.scrollHeight;
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

function serverAddress() {
  return (state && state.clientConfig && state.clientConfig.centralUrl) || $('play-server').value.trim() || '';
}

// The ROBLOX logo (the 2015-2017 one, as on the Xbox One app) is Roblox's
// art, so it is not in the git repository or the public download: a launcher
// without it asks its server for it (account.js keeps a copy in config/),
// and shows the word if neither has it.
document.querySelectorAll('.logo-img').forEach((logo) => {
  const file = logo.getAttribute('src');
  let triedServer = false;
  const fallback = () => {
    if (!triedServer) {
      triedServer = true;
      logo.src = `launcher-net://server/download/${file}`;
      return;
    }
    const text = el('div', `${logo.className.replace('logo-img', '')} logo-text`.trim(), 'ROBLOX');
    logo.replaceWith(text);
  };
  logo.addEventListener('error', fallback);
  if (logo.complete && logo.naturalWidth === 0) fallback();
});

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
    api.gameThumbnail({ centralUrl: serverAddress(), placeId: game.placeId, version: game.thumbnail }).then((dataUrl) => {
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

// --- screens ---------------------------------------------------------------------------

function showScreen(name) {
  screen = name;
  $('screen-start').classList.toggle('hidden', name !== 'start');
  $('screen-account').classList.toggle('hidden', name !== 'account');
  $('shell').classList.toggle('hidden', name !== 'shell');
  document.body.classList.toggle('on-start', name === 'start');
  document.body.classList.toggle('on-account', name === 'account');
  document.body.classList.toggle('on-avatar', name === 'shell' && view === 'avatar');
  if (name === 'start') focusEl($('start-press'));
  if (name === 'shell') setTimeout(popNews, 400);
  if (name === 'account') {
    $('acct-server').textContent = serverAddress() ? `Server: ${serverAddress()}` : 'No server set yet';
    focusEl($('acct-name').value ? $('acct-pass') : $('acct-name'));
  }
}

// Leaving the start screen: straight in when already signed in.
let entering = false;
async function enter() {
  if (entering) return;
  entering = true;
  try {
    if (state && state.needsFiles) {
      // First run after the small Setup.exe: get the game files first.
      enterShell();
      showView('settings');
      showSettings('network');
      showFilesPanel(false);
      focusEl($('join-code'));
      return;
    }
    $('start-press').querySelector('span').textContent = 'Signing in…';
    const current = await api.currentAccount().catch(() => null);
    if (current && current.account) {
      await signedIn(current);
      return;
    }
    showScreen('account');
  } finally {
    $('start-press').querySelector('span').textContent = 'Press to start';
    entering = false;
  }
}
$('start-press').addEventListener('click', enter);

function enterShell() {
  showScreen('shell');
  if (view === 'home') renderHome();
  findGames(true);
  focusEl(firstFocusable('#view-home') || document.querySelector('.tab-link.active'));
}

// --- sign in -----------------------------------------------------------------------------

let accountMode = 'signin';
function setAccountMode(mode) {
  accountMode = mode;
  document.querySelectorAll('.switch-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('acct-pass2-wrap').classList.toggle('hidden', mode !== 'signup');
  $('acct-go').textContent = mode === 'signup' ? 'Sign up' : 'Sign in';
  $('acct-pass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  setStatus('acct-note', mode === 'signup'
    ? 'Pick a name (3-20 letters, digits or _) and a password of at least 6 characters. Use your Roblox name to start with your Roblox avatar.'
    : 'Your account works in every game on this server and in Roblox Studio.');
}
document.querySelectorAll('.switch-tab').forEach((tab) => tab.addEventListener('click', () => setAccountMode(tab.dataset.mode)));
setAccountMode('signin');

async function submitAccount() {
  const name = $('acct-name').value.trim();
  const password = $('acct-pass').value;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) { setStatus('acct-note', 'Usernames are 3 to 20 letters, digits or underscores.', 'error'); return; }
  if (!password) { setStatus('acct-note', 'Type your password.', 'error'); return; }
  if (accountMode === 'signup') {
    if (password.length < 6) { setStatus('acct-note', 'Pick a password of at least 6 characters.', 'error'); return; }
    if (password !== $('acct-pass2').value) { setStatus('acct-note', 'The two passwords are different.', 'error'); return; }
  }
  if (!serverAddress()) { setStatus('acct-note', 'Set your server address first (Change server).', 'error'); return; }
  $('acct-go').disabled = true;
  setStatus('acct-note', accountMode === 'signup' ? 'Creating your account…' : 'Signing in…');
  try {
    const result = await api.signIn({ name, password, mode: accountMode });
    $('acct-pass').value = '';
    $('acct-pass2').value = '';
    await signedIn({ account: result.account, offline: false }, result.created);
  } catch (error) {
    setStatus('acct-note', message(error), 'error');
  } finally {
    $('acct-go').disabled = false;
  }
}
$('acct-go').addEventListener('click', submitAccount);
for (const id of ['acct-name', 'acct-pass', 'acct-pass2']) {
  $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitAccount(); } });
}
$('acct-guest').addEventListener('click', () => playAsGuest());
$('acct-server-change').addEventListener('click', () => {
  enterShell();
  showView('settings');
  showSettings('network');
  focusEl($('play-server'));
});

async function signedIn(current, created) {
  me = current;
  guest = false;
  storage('lastName', current.account.name);
  updateIdentity();
  enterShell();
  friendData = null;
  refreshOnlinePlayers(true);
  const data = await editor.loadAccount(current.account);
  if (created) setStatus('play-status', `Welcome, ${current.account.name}!`, 'good');
  refreshPictures(Boolean(data && !data.hasImage), false);
}

async function playAsGuest() {
  me = null;
  guest = true;
  updateIdentity();
  enterShell();
  const data = await editor.showGuest();
  refreshPictures(Boolean(data && !data.hasImage), true);
}

async function signOut() {
  await api.signOut().catch(() => {});
  me = null;
  guest = false;
  friendData = null;
  updateFriendsBadge();
  editor.clear();
  $('avatar-img').classList.add('hidden');
  $('avatar-silhouette').classList.remove('hidden');
  $('chip-img').classList.add('hidden');
  updateIdentity();
  setAccountMode('signin');
  showScreen('account');
}

function updateIdentity() {
  const name = me ? me.account.name : 'Guest';
  $('chip-name').textContent = name;
  $('chip-sub').textContent = me ? (me.offline ? 'offline' : (me.account.admin ? 'admin' : '')) : 'guest';
  $('home-username').textContent = name.toUpperCase();
  $('avatar-caption').textContent = me ? 'Edit avatar' : 'Guest look';
  $('account-line').textContent = me ? `Signed in as ${me.account.name}` : (guest ? 'Playing as a guest' : 'Not signed in');
  $('account-lead').textContent = me
    ? `Your games, avatar and Studio use this account on ${serverAddress()}.${me.account.admin ? ' You are an admin: you can edit every game in Studio.' : ''}`
    : 'Guests join as "Guest" with a number and the guest look. Sign up to pick your own name, dress your avatar and use Roblox Studio.';
  $('account-signin').classList.toggle('hidden', Boolean(me));
  $('account-signout').classList.toggle('hidden', !me);
}

$('account-signin').addEventListener('click', () => { setAccountMode('signin'); showScreen('account'); });
$('avatar-signin').addEventListener('click', () => { setAccountMode('signup'); showScreen('account'); });
$('account-signout').addEventListener('click', signOut);
$('user-chip').addEventListener('click', () => { showView('settings', false); showSettings('account'); });

// Pictures of the avatar for Home and the top bar; sent to the server when
// it has none (or the avatar changed), where games' menus and other players'
// launchers show them.
let pictureUrls = [];
async function refreshPictures(upload, asGuest) {
  const shots = await editor.pictures().catch(() => null);
  if (!shots) return;
  pictureUrls.forEach((url) => URL.revokeObjectURL(url));
  pictureUrls = [URL.createObjectURL(shots.full), URL.createObjectURL(shots.head)];
  $('avatar-img').src = pictureUrls[0];
  $('avatar-img').classList.remove('hidden');
  $('avatar-silhouette').classList.add('hidden');
  $('chip-img').src = pictureUrls[1];
  $('chip-img').classList.remove('hidden');
  if (upload) {
    const bytes = new Uint8Array(await shots.full.arrayBuffer());
    api.uploadAvatarImage(bytes, Boolean(asGuest)).catch(() => {});
  }
}

const editor = window.AvatarEditor.create({
  api,
  onSaved: () => refreshPictures(true, false),
});

// --- views and navigation -----------------------------------------------------------

let VIEWS = ['home', 'avatar', 'games', 'players', 'settings'];
let SETTINGS = ['account', 'network', 'menu', 'host', 'server', 'setup', 'about'];

// A player install (no server files) cannot host or run the web server.
let capabilitiesApplied = false;
function applyCapabilities() {
  capabilitiesApplied = true;
  if (state.canHost) return;
  SETTINGS = SETTINGS.filter((name) => name !== 'host' && name !== 'server');
  for (const name of ['host', 'server']) {
    const link = document.querySelector(`.set-link[data-panel="${name}"]`);
    if (link) link.classList.add('hidden');
  }
  // Converting places is for hosts (the server's /manage page converts uploads).
  $('convert-panel').classList.add('hidden');
  // Players join their host's network with a join code.
  $('join-panel').classList.remove('hidden');
}

function showView(name, focusContent) {
  view = name;
  document.querySelectorAll('.tab-link').forEach((link) => link.classList.toggle('active', link.dataset.view === name));
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${name}`));
  document.body.classList.toggle('on-avatar', name === 'avatar');
  if (name === 'avatar') editor.activate();
  if (name === 'players') refreshOnlinePlayers();
  if (name === 'settings') showSettings(settingsPanel);
  if (name === 'games' || name === 'home') findGames(true);
  if (name === 'home') renderHome();
  if (focusContent) {
    const first = firstFocusable(`#view-${name}`);
    if (first) focusEl(first);
  }
}

function showSettings(name) {
  if (!SETTINGS.includes(name)) name = 'account';
  settingsPanel = name;
  document.querySelectorAll('.set-link').forEach((link) => link.classList.toggle('active', link.dataset.panel === name));
  document.querySelectorAll('.set-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `set-${name}`));
  if (name === 'setup') refreshChecks();
  if (name === 'host') loadHostThumbnail();
  if (name === 'about') {
    renderAbout();
    // Opening About checks again (at most once a minute).
    const update = latestUpdate || (state && state.update) || {};
    if (update.state !== 'off' && Date.now() - lastUpdateCheck > 60000) checkForUpdates();
  }
}
document.querySelectorAll('.set-link').forEach((link) => link.addEventListener('click', () => showSettings(link.dataset.panel)));

function focusables(scope) {
  return [...document.querySelectorAll(`${scope} button, ${scope} input, ${scope} select, ${scope} summary`)]
    .filter((node) => !node.disabled && node.tabIndex !== -1 && node.offsetParent !== null);
}

function firstFocusable(scope) {
  return focusables(scope)[0] || null;
}

const TILE_CLASSES = ['game-tile', 'avatar-panel', 'more', 'item-tile', 'card-main'];
function focusEl(node) {
  if (!node) return;
  document.querySelectorAll('.focused').forEach((other) => other.classList.remove('focused'));
  if (TILE_CLASSES.some((name) => node.classList.contains(name))) node.classList.add('focused');
  node.focus({ preventScroll: false });
  node.scrollIntoView({ block: 'nearest' });
}

// What the arrows and the stick move between on the current screen.
function navPool() {
  if (!$('overlay').classList.contains('hidden')) return focusables('#overlay');
  if (screen === 'start') return [$('start-press')];
  if (screen === 'account') return focusables('#screen-account');
  return [...focusables('#tabs'), $('user-chip'), ...focusables(`#view-${view}`), $('settings-hint')];
}

// Spatial navigation: the nearest focusable control in the pressed direction.
function move(dx, dy) {
  const pool = navPool();
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
  if (screen === 'account') { showScreen('start'); return; }
  if (screen !== 'shell') return;
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
  if (screen === 'start') { enter(); return; }
  if (!node || node === document.body || node.tagName === 'INPUT') return;
  node.click();
}

function switchTab(step) {
  if (screen !== 'shell') return;
  const next = VIEWS[(VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length];
  showView(next);
  focusEl(document.querySelector(`.tab-link[data-view="${next}"]`));
}

function openSettings() {
  if (screen !== 'shell') return;
  showView('settings', true);
}

document.querySelectorAll('.tab-link').forEach((link) => link.addEventListener('click', () => showView(link.dataset.view)));
document.querySelectorAll('[data-goto]').forEach((node) => node.addEventListener('click', () => showView(node.dataset.goto, true)));
$('settings-hint').addEventListener('click', openSettings);
document.addEventListener('mouseover', (event) => {
  const tile = event.target.closest && event.target.closest('.game-tile.nav-target, .avatar-panel, .more, .card-main');
  if (tile) focusEl(tile);
});

document.addEventListener('keydown', (event) => {
  const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT');
  if (event.key === 'Escape') { event.preventDefault(); goBack(); return; }
  if (screen === 'start' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); enter(); return; }
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
// Y music, LB/RB switch tabs, LT/RT (or the right stick) turn the avatar.
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
    edge(2, openSettings);
    edge(3, toggleMusic);
    edge(4, () => switchTab(-1));
    edge(5, () => switchTab(1));
    if (screen === 'shell' && view === 'avatar') {
      const turn = (gamepad.buttons[7] ? gamepad.buttons[7].value : 0) - (gamepad.buttons[6] ? gamepad.buttons[6].value : 0)
        + (Math.abs(gamepad.axes[2] || 0) > 0.25 ? gamepad.axes[2] : 0);
      if (Math.abs(turn) > 0.05) editor.rotate(turn * 0.06);
    }
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
  $('music-hint').textContent = available ? 'M or Y turns the music on and off.' : 'No menu music yet: it comes from your server (config\\menu-music.mp3 on the host\'s PC).';
  if (!available) return;
  // A new stamp means the file changed (downloaded again from the server).
  const stamp = String(state.musicStamp || 0);
  if (music.dataset.stamp !== stamp) {
    music.dataset.stamp = stamp;
    music.src = `launcher-media://menu-music/?v=${stamp}`;
  }
  if (musicWanted() && !clientRunning) music.play().catch(() => {});
  else music.pause();
}

function toggleMusic() {
  storage('music', musicWanted() ? 'off' : 'on');
  updateMusic();
}

const BACKGROUNDS = [['classic', 'Classic'], ['neon', 'Neon grid'], ['sunset', 'Sunset']];
function updateBackgroundButton() {
  const entry = BACKGROUNDS.find(([key]) => key === window.backgroundMode) || BACKGROUNDS[0];
  $('toggle-background').textContent = `Background: ${entry[1]}`;
}

$('toggle-music').addEventListener('click', toggleMusic);
$('toggle-background').addEventListener('click', () => {
  const index = BACKGROUNDS.findIndex(([key]) => key === window.backgroundMode);
  window.backgroundMode = BACKGROUNDS[(index + 1) % BACKGROUNDS.length][0];
  storage('background', window.backgroundMode);
  updateBackgroundButton();
});

function tick() {
  $('top-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tick();
setInterval(tick, 10000);

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

let onlinePlayers = [];

function renderHome() {
  const rows = [
    ['Server', serverAddress() ? hostOf(serverAddress()) : 'Not set'],
    ['Games online', String(lastGames.length)],
    ['Players online', String(onlinePlayers.length)],
    ...(me && friendData ? [['Friends playing', `${friendData.friends.filter((friend) => friend.online).length} of ${friendData.friends.length}`]] : []),
  ];
  if (state && state.canHost) {
    rows.push(['Web server', state.web.running ? 'Running' : 'Stopped']);
    rows.push(['Tailscale', state.web.tailscaleUrl ? hostOf(state.web.tailscaleUrl) : 'Not connected']);
  }
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
      if (i === 0 && state && state.needsFiles) recent.append(placeholder('Download the game files first (Settings).', '↓', () => { showView('settings'); showSettings('network'); }));
      else recent.append(i === 0 ? placeholder('Games you join show up here.', '▶', () => showView('games', true)) : placeholder(''));
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
    const count = game ? onlinePlayers.filter((player) => player.gameId === game.id).length : 0;
    if (game) grid.append(gameTile(game, { badge: count ? `${count} PLAYING` : `UP ${formatUptime(game.upSeconds).toUpperCase()}`, live: count > 0 }));
    else if (i === lastGames.length && state && state.canHost) grid.append(placeholder('Host a game', '+', () => { showView('settings'); showSettings('host'); }));
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
    ? `Place ${detailGame.placeId} · up ${formatUptime(detailGame.upSeconds)}`
    : `Place ${detailGame.placeId || '?'}`;
  const inGame = onlinePlayers.filter((player) => player.gameId === detailGame.id).map((player) => player.name);
  $('detail-players').textContent = inGame.length ? `Playing now: ${inGame.join(', ')}` : '';
  $('detail-desc').textContent = detailGame.description || '';
  $('detail-note').textContent = playable ? (state && state.play.active ? 'The client is already running.' : '') : 'This game is not online right now.';
  $('detail-as').textContent = me ? `You'll play as ${me.account.name}.` : 'You\'ll play as a guest. Sign in to use your own name and avatar.';
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
    const joined = await api.join({ game: detailGame, guest: !me });
    rememberPlayed(detailGame);
    $('detail-note').textContent = joined.guest ? `Have fun, ${joined.name}!` : 'Have fun!';
    setTimeout(() => { closeDetail(); renderHome(); }, 1100);
  } catch (error) {
    $('detail-note').textContent = message(error);
    $('detail-play').disabled = false;
    if (/sign in/i.test(message(error)) && me) {
      // The session ran out on the server.
      me = null;
      updateIdentity();
    }
  }
});

// --- state -----------------------------------------------------------------------------

async function refreshState() {
  state = await api.state();
  if (!capabilitiesApplied) applyCapabilities();
  showUpdate(state.update);
  if (!formsFilled) fillForms();
  $('presence-dot').className = `presence-dot${state.web.tailscaleUrl ? ' on' : ''}`;
  $('start-foot').textContent = `Launcher ${state.version}${serverAddress() ? ` · ${serverAddress()}` : ''}`;

  // Games / play
  $('play-close').classList.toggle('hidden', !state.play.active);
  if (state.play.active) setStatus('play-status', 'The client is running.', 'good');
  else if ($('play-status').textContent === 'The client is running.') setStatus('play-status', 'The client closed.');

  // Host
  $('host-start').classList.toggle('hidden', state.host.active);
  $('host-stop').classList.toggle('hidden', !state.host.active);
  $('host-live').classList.toggle('hidden', !state.host.active);
  document.querySelectorAll('#set-host input, #set-host select').forEach((node) => { node.disabled = state.host.active; });
  if (state.host.active) {
    $('host-address').textContent = state.host.publicAddress;
    setStatus('host-status', `Hosting (game ${state.host.gameId}).`, 'good');
    if (!hostPlayersTimer) { refreshHostPlayers(); hostPlayersTimer = setInterval(refreshHostPlayers, 8000); }
  } else {
    if (hostPlayersTimer) { clearInterval(hostPlayersTimer); hostPlayersTimer = null; }
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
  if (screen === 'shell' && view === 'home' && $('overlay').classList.contains('hidden')) renderHome();
}

function fillForms() {
  formsFilled = true;
  const client = state.clientConfig || {};
  $('play-server').value = client.centralUrl || 'http://127.0.0.1';
  $('acct-name').value = storage('lastName') || '';
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

// Network: the server this launcher plays on (accounts belong to it).
$('server-save').addEventListener('click', async () => {
  try {
    const url = await api.setServer($('play-server').value.trim());
    $('play-server').value = url;
    await refreshState();
    setStatus('server-status', 'Saved.', 'good');
    findGames(true);
    if (me) {
      // Another server has its own accounts.
      const current = await api.currentAccount().catch(() => null);
      if (!current) { setStatus('server-status', 'Saved. Sign in to your account on this server.', 'good'); me = null; updateIdentity(); }
    }
  } catch (error) {
    setStatus('server-status', message(error), 'error');
  }
});

// --- games ------------------------------------------------------------------------------

let findingGames = false;
async function findGames(quiet) {
  if (findingGames || !serverAddress()) return;
  findingGames = true;
  if (!quiet) setStatus('play-status', 'Looking for games…');
  $('play-refresh').disabled = true;
  try {
    lastGames = await api.games(serverAddress());
    setStatus('play-status', lastGames.length ? `${lastGames.length} game${lastGames.length === 1 ? '' : 's'} online.` : 'No games are online right now.');
  } catch (error) {
    lastGames = [];
    setStatus('play-status', message(error), 'error');
  } finally {
    findingGames = false;
    $('play-refresh').disabled = false;
    refreshOnlinePlayers(true);
    renderAllGames();
    if (screen === 'shell' && view === 'home') renderHome();
  }
}

function renderAllGames() {
  const list = $('all-games');
  list.textContent = '';
  for (const game of lastGames) {
    const count = onlinePlayers.filter((player) => player.gameId === game.id).length;
    list.append(gameTile(game, { caption: count ? `${count} playing · up ${formatUptime(game.upSeconds)}` : `Up ${formatUptime(game.upSeconds)}` }));
  }
  if (lastGames.length === 0) list.append(placeholder('No games online. Host one, or ask your host to start theirs.', '·'));
}

$('play-refresh').addEventListener('click', () => findGames(false));
// The server's management page (upload games, turn them on or off...).
$('play-manage').addEventListener('click', async () => {
  try {
    await api.openManage(serverAddress());
  } catch (error) {
    setStatus('play-status', message(error), 'error');
  }
});
$('web-manage').addEventListener('click', () => api.openManage('http://127.0.0.1').catch(() => {}));
// Roblox Studio: downloaded from the server the first time, then started.
$('play-studio').addEventListener('click', async () => {
  const button = $('play-studio');
  button.disabled = true;
  setStatus('play-status', 'Starting Studio…');
  try {
    await api.openStudio(serverAddress());
    setStatus('play-status', me
      ? `Studio is open: sign in on its start page as ${me.account.name}.`
      : 'Studio is open: sign in on its start page (Studio needs an account; sign up here first).', 'good');
  } catch (error) {
    setStatus('play-status', message(error), 'error');
  } finally {
    button.disabled = false;
  }
});
api.onStudioProgress((info) => {
  if (info.phase === 'checking') setStatus('play-status', 'Contacting the server…');
  if (info.phase === 'download') setStatus('play-status', `Downloading Studio… ${Math.round(info.received / 1e6)} of ${Math.round(info.total / 1e6)} MB`);
  if (info.phase === 'unpack') setStatus('play-status', 'Unpacking Studio…');
});
$('play-close').addEventListener('click', () => api.stopClient());

// --- friends and players --------------------------------------------------------------------

let refreshingPlayers = false;
let friendData = null; // { friends, incoming, outgoing } for the signed-in account

async function refreshOnlinePlayers(quiet) {
  if (refreshingPlayers || !serverAddress()) return;
  refreshingPlayers = true;
  try {
    const [data, mine] = await Promise.all([
      api.onlinePlayers(),
      me ? api.friends().catch(() => friendData) : Promise.resolve(null),
    ]);
    onlinePlayers = Array.isArray(data.players) ? data.players : [];
    friendData = mine;
    setStatus('players-status', onlinePlayers.length ? `${onlinePlayers.length} in games` : 'nobody right now');
  } catch (error) {
    if (!quiet) setStatus('players-status', message(error), 'error');
  } finally {
    refreshingPlayers = false;
    updateFriendsBadge();
    if (view === 'players') renderPlayers();
  }
}

function updateFriendsBadge() {
  const count = friendData && me ? friendData.incoming.length : 0;
  $('friends-badge').textContent = String(count);
  $('friends-badge').classList.toggle('hidden', count === 0);
}

const SILHOUETTE = '<svg viewBox="0 0 100 120" aria-hidden="true"><rect x="34" y="8" width="32" height="30" rx="4"/><rect x="26" y="42" width="48" height="44" rx="3"/><rect x="12" y="44" width="12" height="38" rx="3"/><rect x="76" y="44" width="12" height="38" rx="3"/><rect x="28" y="88" width="20" height="30" rx="3"/><rect x="52" y="88" width="20" height="30" rx="3"/></svg>';

// A card: picture, name and where they are; clicking it opens their game.
// actions: [[label, verb, className]], buttons under it.
function personCard(person, where, actions = []) {
  const card = el('div', 'player-card');
  const main = el('button', 'card-main nav-target');
  main.dataset.player = person.name;
  if (me && me.account.name.toLowerCase() === person.name.toLowerCase()) card.classList.add('you');
  const gameId = person.gameId || (person.online && person.online.gameId) || null;
  if (gameId) card.classList.add('online');
  const pic = el('div', 'player-pic');
  pic.innerHTML = SILHOUETTE;
  if (person.userId !== null && person.userId !== undefined) {
    const img = el('img');
    img.alt = '';
    img.src = `launcher-net://server/avatar-thumbnail/image?userId=${encodeURIComponent(person.userId)}&width=150&height=150`;
    img.addEventListener('load', () => { pic.textContent = ''; pic.append(img); });
  }
  main.append(pic, el('div', 'player-name', person.name), el('div', 'player-where', where));
  main.addEventListener('click', () => {
    const game = lastGames.find((item) => item.id === gameId);
    if (game) openDetail(game);
  });
  card.append(main);
  if (actions.length) {
    const row = el('div', 'card-actions');
    for (const [label, verb, kind] of actions) {
      const button = el('button', kind || 'ghost', label);
      button.addEventListener('click', () => friendAction(verb, person));
      row.append(button);
    }
    card.append(row);
  }
  return card;
}

async function friendAction(verb, person) {
  if (verb === 'remove' && !window.confirm(`Remove ${person.name} from your friends?`)) return;
  setStatus('friends-status', '');
  try {
    const result = await api.friendAction(verb, { name: person.name });
    friendData = result;
    const texts = {
      request: result.became === 'friends' ? `You and ${result.name} are now friends!` : `Friend request sent to ${result.name}.`,
      accept: `You and ${result.name} are now friends!`,
      decline: `Declined ${result.name}'s request.`,
      cancel: `Took back your request to ${result.name}.`,
      remove: `${result.name} is no longer your friend.`,
    };
    setStatus('friends-status', texts[verb], 'good');
  } catch (error) {
    setStatus('friends-status', message(error), 'error');
  }
  updateFriendsBadge();
  renderPlayers();
}

$('add-friend-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('add-friend-name').value.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) { setStatus('friends-status', 'Type their username (3-20 letters, digits or _).', 'error'); return; }
  $('add-friend-name').value = '';
  friendAction('request', { name });
});
$('friends-signin').addEventListener('click', () => { setAccountMode('signup'); showScreen('account'); });

function renderPlayers() {
  const focusedName = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.player : null;
  $('friends-guest').classList.toggle('hidden', Boolean(me));
  $('friends-area').classList.toggle('hidden', !me);
  const friendIds = new Set(me && friendData ? friendData.friends.map((friend) => friend.userId) : []);
  const pending = new Set(me && friendData ? [...friendData.incoming, ...friendData.outgoing].map((person) => person.userId) : []);

  if (me) {
    const requests = $('request-grid');
    requests.textContent = '';
    const incoming = friendData ? friendData.incoming : [];
    const outgoing = friendData ? friendData.outgoing : [];
    for (const person of incoming) {
      requests.append(personCard(person, 'wants to be your friend', [['Accept', 'accept', 'primary'], ['Decline', 'decline']]));
    }
    for (const person of outgoing) {
      requests.append(personCard(person, 'request sent', [['Take back', 'cancel']]));
    }
    $('requests-title').classList.toggle('hidden', incoming.length + outgoing.length === 0);

    const list = $('friend-grid');
    list.textContent = '';
    const mine = friendData ? friendData.friends : [];
    const playing = mine.filter((friend) => friend.online).length;
    $('friends-title').textContent = mine.length ? `FRIENDS (${playing} of ${mine.length} playing)` : 'FRIENDS';
    for (const friend of mine) {
      list.append(personCard(friend, friend.online ? `in ${friend.online.gameName}` : 'offline', [['Unfriend', 'remove']]));
    }
    if (!mine.length) list.append(el('div', 'empty-note', 'No friends yet. Add someone by name, or from the players below.'));
  }

  const grid = $('player-grid');
  grid.textContent = '';
  if (!onlinePlayers.length) grid.append(el('div', 'empty-note', 'Nobody is in a game right now.'));
  for (const player of onlinePlayers) {
    const self = me && me.account.name.toLowerCase() === player.name.toLowerCase();
    const canAdd = me && !self && player.userId > 0 && !player.guest && !friendIds.has(player.userId) && !pending.has(player.userId);
    const note = friendIds.has(player.userId) ? ' · friend' : (pending.has(player.userId) ? ' · request pending' : '');
    grid.append(personCard(player, `in ${player.gameName}${note}`, canAdd ? [['Add friend', 'request']] : []));
  }
  if (focusedName) {
    const again = [...document.querySelectorAll('#view-players .card-main')].find((node) => node.dataset.player === focusedName);
    if (again) again.focus({ preventScroll: true });
  }
}

// --- host --------------------------------------------------------------------------------

async function refreshHostPlayers() {
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
  'download-files': 'Download game files',
};

// --- game files (installs from the small Setup.exe) ----------------------------------

function showFilesPanel(focus) {
  const panel = $('files-panel');
  panel.classList.remove('hidden');
  if (!$('files-server').value) $('files-server').value = serverAddress();
  if (state && !state.needsFiles) $('files-lead').textContent = 'A newer version of the game files is on your server. Download it to update (your settings stay).';
  if (focus) focusEl($('files-server').value ? $('files-download') : $('files-server'));
}

let downloadingFiles = false;
$('files-download').addEventListener('click', async () => {
  if (downloadingFiles) return;
  const address = $('files-server').value.trim();
  downloadingFiles = true;
  $('files-download').disabled = true;
  $('files-progress').classList.remove('hidden');
  $('files-progress').removeAttribute('value');
  try {
    const result = await api.downloadFiles(address);
    setStatus('files-status', `Ready: game files version ${result.version} installed.`, 'good');
    $('play-server').value = address;
    await api.setServer(address).catch(() => {});
    await refreshState();
    setTimeout(() => {
      $('files-panel').classList.add('hidden');
      $('files-progress').classList.add('hidden');
      // On to signing in.
      setAccountMode('signup');
      showScreen('account');
    }, 1800);
  } catch (error) {
    setStatus('files-status', message(error), 'error');
    $('files-progress').classList.add('hidden');
  } finally {
    downloadingFiles = false;
    $('files-download').disabled = false;
  }
});

// --- join codes (tailscale.js in the main process) --------------------------------------

let joiningNetwork = false;
$('join-go').addEventListener('click', async () => {
  if (joiningNetwork) return;
  const code = $('join-code').value.trim();
  if (!code) {
    setStatus('join-status', 'Paste the join code first.', 'error');
    return;
  }
  joiningNetwork = true;
  $('join-go').disabled = true;
  try {
    const result = await api.joinWithCode({ code, username: me ? me.account.name : (storage('lastName') || '') });
    $('play-server').value = result.server;
    $('files-server').value = result.server;
    $('join-code').value = '';
    setStatus('join-status', result.alreadyConnected ? 'Connected (this PC was already on the network).' : 'Connected to your host\'s network.', 'good');
    await refreshState();
    if (state && state.needsFiles) {
      showFilesPanel(false);
      $('files-download').click(); // carry on with the game files
    } else {
      findGames(true);
    }
  } catch (error) {
    setStatus('join-status', message(error), 'error');
  } finally {
    joiningNetwork = false;
    $('join-go').disabled = false;
  }
});

api.onJoinProgress((info) => {
  const texts = {
    checking: 'Checking…',
    'tailscale-verify': 'Checking that the installer is really from Tailscale…',
    'tailscale-install': 'Installing Tailscale: choose Yes in the Windows prompt…',
    'tailscale-connect': 'Connecting to your host\'s network…',
    'reaching-server': 'Waiting for the server to answer…',
  };
  if (info.phase === 'tailscale-download') {
    setStatus('join-status', info.total ? `Downloading Tailscale… ${Math.round(info.received / 1e6)} of ${Math.round(info.total / 1e6)} MB` : 'Downloading Tailscale…');
  } else if (texts[info.phase]) {
    setStatus('join-status', texts[info.phase]);
  }
});

api.onFilesProgress((info) => {
  const bar = $('files-progress');
  if (info.phase === 'checking') setStatus('files-status', 'Contacting the server…');
  if (info.phase === 'download') {
    bar.max = info.total;
    bar.value = info.received;
    setStatus('files-status', `Downloading… ${Math.round(info.received / 1e6)} of ${Math.round(info.total / 1e6)} MB`);
  }
  if (info.phase === 'unpack') {
    bar.removeAttribute('value');
    setStatus('files-status', 'Unpacking…');
  }
});

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
        if (check.action === 'download-files') {
          showSettings('network');
          showFilesPanel(true);
          return;
        }
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

// --- about and updates ---------------------------------------------------------------------

let latestUpdate = null; // the newest update status from the main process
let lastUpdateCheck = 0;

function renderAbout() {
  if (!state) return;
  $('about-version').textContent = `Version ${state.version}${state.filesVersion ? ` · game files ${state.filesVersion}` : ''}`;
  const update = latestUpdate || state.update || {};
  const checked = lastUpdateCheck ? ` (checked at ${new Date(lastUpdateCheck).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
  const texts = {
    checking: 'Checking for updates…',
    current: `This is the newest version${checked}.`,
    downloading: `Downloading version ${update.version || ''}… ${update.percent || 0}%`,
    ready: `Version ${update.version} is ready: restart the launcher to use it.`,
    error: `Could not check for updates: ${update.message || ''}`,
    off: 'Updates are off for this copy (run from source or the server package).',
  };
  $('about-update').textContent = texts[update.state] || '';
  $('about-check').classList.toggle('hidden', update.state === 'off' || update.state === 'ready');
  $('about-check').disabled = update.state === 'checking' || update.state === 'downloading';
  $('about-restart').classList.toggle('hidden', update.state !== 'ready');
}

async function checkForUpdates() {
  lastUpdateCheck = Date.now();
  try {
    latestUpdate = await api.checkForUpdates();
  } catch (error) {
    latestUpdate = { state: 'error', message: message(error) };
  }
  renderAbout();
}

$('about-check').addEventListener('click', checkForUpdates);
$('about-restart').addEventListener('click', () => $('update-pill').click());

// Launcher updates (from the newest GitHub release).
function showUpdate(status) {
  const pill = $('update-pill');
  pill.classList.toggle('hidden', !status || !['downloading', 'ready'].includes(status.state));
  pill.classList.toggle('ready', Boolean(status && status.state === 'ready'));
  if (status && status.state === 'downloading') pill.textContent = `Downloading update ${status.version || ''}… ${status.percent || 0}%`;
  if (status && status.state === 'ready') pill.textContent = `Restart to update to ${status.version}`;
}
api.onUpdateStatus((status) => {
  latestUpdate = status;
  if (status && status.state === 'current' && !lastUpdateCheck) lastUpdateCheck = Date.now();
  showUpdate(status);
  if (settingsPanel === 'about') renderAbout();
});
$('update-pill').addEventListener('click', async () => {
  if (!$('update-pill').classList.contains('ready')) return;
  try {
    await api.installUpdate();
  } catch (error) {
    $('update-pill').textContent = message(error);
  }
});

// --- notices ---------------------------------------------------------------------------------

let toastTimer = null;
function showToast(text, ms = 9000) {
  const node = $('toast');
  node.textContent = text;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

// --- announcements ---------------------------------------------------------------------------
// From the host (their server's /manage page) and from the project. Checked
// every two minutes; dismissed ones stay hidden on this PC. An important one
// also pops up the first time it is seen past the start and sign-in screens.

const NEWS_DISMISSED = 'newsDismissed';
const NEWS_SEEN = 'newsSeen';

function storedIds(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch (error) { return new Set(); }
}
function storeIds(key, ids) {
  try { localStorage.setItem(key, JSON.stringify([...ids].slice(-200))); } catch (error) { /* storage unavailable */ }
}

function newsTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString();
}

let newsList = [];

function homeFocus() {
  focusEl(firstFocusable('#view-home') || document.querySelector('.tab-link.active'));
}

function renderNews() {
  const box = $('news');
  const dismissed = storedIds(NEWS_DISMISSED);
  const shown = newsList.filter((item) => !dismissed.has(item.id));
  const hadFocus = box.contains(document.activeElement);
  box.textContent = '';
  box.classList.toggle('hidden', shown.length === 0);
  for (const item of shown) {
    const row = document.createElement('div');
    row.className = `news-item${item.level === 'important' ? ' important' : ''}`;
    const body = document.createElement('div');
    body.className = 'news-body';
    if (item.title) {
      const head = document.createElement('div');
      head.className = 'news-head';
      head.textContent = item.title;
      body.append(head);
    }
    const text = document.createElement('div');
    text.className = 'news-text';
    text.textContent = item.text;
    const meta = document.createElement('div');
    meta.className = 'news-meta';
    meta.textContent = [item.source === 'project' ? 'From the RobloxClient project' : 'From your server', newsTime(item.postedAt)].filter(Boolean).join(' · ');
    body.append(text, meta);
    const dismiss = document.createElement('button');
    dismiss.className = 'news-dismiss nav-target';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      const ids = storedIds(NEWS_DISMISSED);
      ids.add(item.id);
      storeIds(NEWS_DISMISSED, ids);
      renderNews();
    });
    row.append(body, dismiss);
    box.append(row);
  }
  if (hadFocus && !box.contains(document.activeElement) && $('view-home').classList.contains('active')) homeFocus();
}

async function loadNews() {
  let result;
  try {
    result = await api.announcements();
  } catch (error) {
    return;
  }
  // Server not reached: keep showing its last ones rather than clearing them.
  const fromServer = result.serverReached ? [] : newsList.filter((item) => item.source === 'server');
  newsList = [...result.announcements, ...fromServer];
  renderNews();
  popNews();
}

function popNews() {
  if (screen !== 'shell') return;
  const seen = storedIds(NEWS_SEEN);
  const fresh = newsList.filter((item) => !seen.has(item.id));
  if (fresh.length === 0) return;
  fresh.forEach((item) => seen.add(item.id));
  storeIds(NEWS_SEEN, seen);
  const dismissed = storedIds(NEWS_DISMISSED);
  const loud = fresh.find((item) => item.level === 'important' && !dismissed.has(item.id));
  if (loud) showToast(`${loud.title ? `${loud.title}: ` : ''}${loud.text}`, 15000);
}

setTimeout(loadNews, 2500);
setInterval(loadNews, 2 * 60 * 1000);

// The host moved the server to another PC; the main process switched over.
api.onServerMoved(async (info) => {
  $('play-server').value = info.to;
  showToast(`Your server moved to ${info.to}. The launcher switched to it; you're still signed in.`, 12000);
  await refreshState();
  findGames(true);
});

// --- start ----------------------------------------------------------------------------------

api.onLog(({ area, line, time }) => appendLog(area, line, time));
api.onStatusChanged(() => refreshState());

updateBackgroundButton();
updateIdentity();
refreshState().then(() => {
  showScreen('start');
});
setInterval(refreshState, 5000);
setInterval(() => {
  if (screen !== 'shell') return;
  if (view === 'home' || view === 'games') findGames(true);
  else if (view === 'players') refreshOnlinePlayers(true);
}, 15000);
