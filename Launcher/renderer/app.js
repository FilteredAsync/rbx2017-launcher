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
let lastGames = []; // the server's games, each with its servers (main.js play:games)
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
  // A new error, not the same one again from a refresh.
  if (kind === 'error' && text && (node.textContent !== text || !node.classList.contains('error'))) sfx.play('error');
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

// Players in a game, all its servers together: the server's count (its
// always-on server checks every server), or who it says is in that game.
function playersIn(game) {
  if (!game) return 0;
  if (Number.isFinite(game.playing)) return game.playing;
  return onlinePlayers.filter((player) => String(player.placeId) === String(game.placeId)).length;
}

// A game in the list can be played when a server runs or one can start.
function isPlayable(game) {
  return Boolean(game && lastGames.includes(game) && ((game.servers || []).length > 0 || game.canStart));
}

const PERSON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="4.5"/><path d="M3 22c0-5 4-8 9-8s9 3 9 8z"/></svg>';

function gameTile(game, options = {}) {
  const tile = el('button', 'game-tile nav-target');
  tile.append(cover(game));
  if (Number.isFinite(options.players)) {
    const ccu = el('span', `tile-ccu${options.players > 0 ? ' live' : ''}`);
    ccu.innerHTML = PERSON_ICON;
    ccu.append(document.createTextNode(String(options.players)));
    ccu.title = `${options.players} playing`;
    tile.append(ccu);
  }
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
  if (screen && screen !== name) sfx.play('screen');
  screen = name;
  $('screen-start').classList.toggle('hidden', name !== 'start');
  $('screen-account').classList.toggle('hidden', name !== 'account');
  $('shell').classList.toggle('hidden', name !== 'shell');
  document.body.classList.toggle('on-start', name === 'start');
  document.body.classList.toggle('on-account', name === 'account');
  document.body.classList.toggle('on-avatar', name === 'shell' && view === 'avatar');
  if (name === 'start') focusEl($('start-press'));
  if (name === 'shell') {
    setTimeout(() => { popNews(); whatsNewAfterUpdate(); }, 400);
    setTimeout(offerTailscaleRemoval, 3000);
  }
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
      focusEl(state.needsTailscale ? $('join-code') : $('files-download'));
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
  // Managing the server is for its admins (set on its Manage games page).
  $('play-manage').classList.toggle('hidden', !(me && me.account.admin));
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
let SETTINGS = ['account', 'network', 'storage', 'menu', 'host', 'server', 'setup', 'about'];

// A player install (no server files) cannot host or run the web server.
let capabilitiesApplied = false;
function applyCapabilities() {
  capabilitiesApplied = true;
  // Release builds have their server built in: nothing to type or change.
  if (state.fixedServer) {
    for (const id of ['server-panel', 'files-server-field', 'acct-server-row']) $(id).classList.add('hidden');
    $('files-lead').textContent = 'Download the game files (about 75 MB) to play.';
  }
  if (state.canHost) return;
  SETTINGS = SETTINGS.filter((name) => name !== 'host' && name !== 'server');
  for (const name of ['host', 'server']) {
    const link = document.querySelector(`.set-link[data-panel="${name}"]`);
    if (link) link.classList.add('hidden');
  }
  // Converting places is for hosts (the server's /manage page converts uploads).
  $('convert-panel').classList.add('hidden');
  // Players join their host's network with a join code (only a server on a
  // Tailscale address needs one; one reached over the internet does not).
  if (state.needsTailscale) $('join-panel').classList.remove('hidden');
}

function showView(name, focusContent) {
  if (screen === 'shell' && view !== name) sfx.play(name === 'settings' ? 'menu' : 'screen');
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
  if (name === 'storage') {
    showAssetCache();
    showStorage();
  }
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
  if (!$('tailscale-overlay').classList.contains('hidden')) return focusables('#tailscale-overlay');
  if (!$('news-overlay').classList.contains('hidden')) return focusables('#news-overlay');
  if (!$('profile-overlay').classList.contains('hidden')) return focusables('#profile-overlay');
  if (!$('overlay').classList.contains('hidden')) return focusables('#overlay');
  if (screen === 'start') return [$('start-press')];
  if (screen === 'account') return focusables('#screen-account');
  return [...focusables('#tabs'), $('user-chip'), ...focusables(`#view-${view}`), $('settings-hint')];
}

// Spatial navigation: the nearest focusable control in the pressed direction.
function move(dx, dy) {
  if (loading) return;
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
  if (best) {
    focusEl(best);
    sfx.play('move');
  }
}

// Every button press clicks (unless something more specific plays for it).
document.addEventListener('click', (event) => {
  if (event.target.closest('button, summary, .nav-target')) sfx.press();
}, true);

function goBack() {
  if (loading) return;
  if (!$('tailscale-overlay').classList.contains('hidden')) { closeTailscalePrompt(); return; }
  if (!$('news-overlay').classList.contains('hidden')) { closeWhatsNew(); return; }
  if (!$('profile-overlay').classList.contains('hidden')) { closeProfile(); return; }
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
  if (loading) return;
  if (screen !== 'shell') return;
  const next = VIEWS[(VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length];
  showView(next);
  focusEl(document.querySelector(`.tab-link[data-view="${next}"]`));
}

function openSettings() {
  if (loading) return;
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
  // The loading screen has one button (Cancel); nothing behind it moves.
  if (loading) {
    if (event.key === 'Enter' || event.key === ' ') return;
    event.preventDefault();
    return;
  }
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
      const active = document.activeElement;
      if (x && !y && active && active.type === 'range') nudgeSlider(active, x);
      else move(y ? 0 : x, y);
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

// Music volume 0-100 (0 is off). Launchers before 1.10 stored only on/off.
function musicVolume() {
  const stored = Number(storage('musicVolume'));
  if (storage('musicVolume') !== null && Number.isFinite(stored)) return Math.max(0, Math.min(100, stored));
  return storage('music') === 'off' ? 0 : 45;
}
function setMusicVolume(value) {
  const volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  storage('musicVolume', String(volume));
  if (volume > 0) storage('musicVolumeLast', String(volume));
  updateMusic();
}
const musicWanted = () => musicVolume() > 0;

function updateMusic() {
  const available = Boolean(state && state.hasMusic);
  const clientRunning = Boolean(state && state.play.active);
  window.backgroundPaused = clientRunning; // no animation while the game runs
  const volume = musicVolume();
  music.volume = volume / 100;
  showVolume('music', volume);
  $('music-hint').textContent = available ? 'M or Y mutes the music.' : 'No menu music yet: it comes from your server.';
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

// M / Y: mute, or back to the last volume.
function toggleMusic() {
  setMusicVolume(musicWanted() ? 0 : Number(storage('musicVolume') === '0' && storage('musicVolumeLast')) || 45);
}

function showVolume(which, value) {
  const slider = $(`volume-${which}`);
  if (document.activeElement !== slider || Number(slider.value) !== value) slider.value = String(value);
  slider.style.setProperty('--fill', `${value}%`);
  $(`volume-${which}-value`).textContent = value ? `${value}%` : 'Off';
}

$('volume-music').addEventListener('input', (event) => setMusicVolume(event.target.value));
let soundPreview = null;
$('volume-sounds').addEventListener('input', (event) => {
  sfx.volume = Number(event.target.value);
  showVolume('sounds', sfx.volume);
  // Hear the new level (once the slider settles).
  clearTimeout(soundPreview);
  soundPreview = setTimeout(() => sfx.play('move'), 120);
});
showVolume('sounds', sfx.volume);

// Left/right on a focused slider (keys, d-pad or stick) changes it.
function nudgeSlider(slider, direction) {
  const step = Number(slider.step) || 1;
  slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), Number(slider.value) + step * direction)));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

const BACKGROUNDS = [['classic', 'Classic'], ['neon', 'Neon grid'], ['sunset', 'Sunset']];
function updateBackgroundButton() {
  const entry = BACKGROUNDS.find(([key]) => key === window.backgroundMode) || BACKGROUNDS[0];
  $('toggle-background').textContent = `Background: ${entry[1]}`;
}

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
  const list = recentList().filter((entry) => !(entry.placeId ? String(entry.placeId) === String(game.placeId) : entry.name === game.name));
  list.unshift({ name: game.name, placeId: game.placeId, creator: game.creator || '', thumbnail: game.thumbnail || null, when: Date.now() });
  storage('recent', JSON.stringify(list.slice(0, 6)));
}

// The game list's entry for a remembered or linked game (by place ID).
function onlineMatch(entry) {
  if (!entry) return null;
  return (entry.placeId ? lastGames.find((game) => String(game.placeId) === String(entry.placeId)) : null)
    || lastGames.find((game) => game.name === entry.name) || null;
}

let onlinePlayers = [];

function renderHome() {
  renderFriendsStrip();
  const rows = [
    ...(state && state.fixedServer ? [] : [['Server', serverAddress() ? hostOf(serverAddress()) : 'Not set']]),
    ['Players in games', String(onlinePlayers.length)],
    ...(me && friendData ? [['Friends online', `${friendData.friends.filter((friend) => presenceOf(friend) !== 'offline').length} of ${friendData.friends.length}`]] : []),
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
    const count = playersIn(game);
    if (game) grid.append(gameTile(game, { badge: count ? `${count} PLAYING` : null, live: count > 0 }));
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
  if ($('overlay').classList.contains('hidden')) sfx.play('overlay');
  detailGame = onlineMatch(game) || game;
  const listed = lastGames.includes(detailGame);
  const servers = listed && Array.isArray(detailGame.servers) ? detailGame.servers : [];
  const playable = isPlayable(detailGame);
  const busy = Boolean(state && state.play.active);
  const box = $('detail-cover');
  box.textContent = '';
  box.append(cover(detailGame));
  $('detail-name').textContent = detailGame.name;
  renderDetailMeta(detailGame, listed);
  const desc = $('detail-desc');
  desc.textContent = detailGame.description || '';
  desc.classList.remove('open');
  $('detail-more').classList.add('hidden');
  $('detail-more').textContent = 'More';
  $('detail-note').textContent = playable ? (busy ? 'Roblox is already open.' : '') : 'Offline right now.';
  $('detail-as').textContent = me ? `Playing as ${me.account.name}` : 'Playing as a guest';
  $('detail-play').disabled = !playable || busy;
  renderServerList(servers, playable && !busy);
  closePrivateForms();
  loadPrivate(detailGame);
  // Starts a server now if none runs, so it's ready (or nearly) by Play.
  if (playable && !busy && detailGame.placeId) api.warmGame(detailGame.placeId);
  $('overlay').classList.remove('hidden');
  // "More" only when the description is longer than its few lines.
  requestAnimationFrame(() => $('detail-more').classList.toggle('hidden', desc.scrollHeight <= desc.clientHeight + 2));
  focusEl($('detail-play').disabled ? $('detail-back') : $('detail-play'));
}

// "By ..." and, when anyone is in it, how many are playing.
function renderDetailMeta(game, listed) {
  const meta = $('detail-meta');
  meta.textContent = '';
  if (game.creator) meta.append(el('span', '', `By ${game.creator}`));
  const count = listed ? playersIn(game) : 0;
  if (count > 0) meta.append(el('span', 'detail-live', `${count} playing`));
}

$('detail-more').addEventListener('click', () => {
  const open = $('detail-desc').classList.toggle('open');
  $('detail-more').textContent = open ? 'Less' : 'More';
});

// Public servers, listed when there is more than one to pick from (Play
// already picks one); each shows who is in it and has its own Join.
function renderServerList(servers, canJoin) {
  const list = $('detail-servers');
  list.textContent = '';
  $('detail-servers-box').classList.toggle('hidden', servers.length < 2);
  servers.forEach((server, index) => {
    const row = el('div', 'server-row');
    const full = Boolean(server.maxPlayers && server.playing >= server.maxPlayers);
    const text = el('div', 'server-text');
    text.append(el('b', '', `Server ${index + 1}`), el('span', 'server-count', `${server.playing}${server.maxPlayers ? `/${server.maxPlayers}` : ''}`));
    if (server.players && server.players.length) text.append(el('div', 'server-players', server.players.join(', ')));
    const join = el('button', 'ghost', full ? 'Full' : 'Join');
    join.disabled = full || !canJoin;
    join.addEventListener('click', () => startPlay(detailGame, { gameId: server.id, address: server.address }));
    row.append(text, join);
    list.append(row);
  });
}

// --- private servers (in the game's details) ---

// The game list refreshes in the background, so games are matched by place ID.
const shownGame = (game) => Boolean(detailGame && game && String(detailGame.placeId) === String(game.placeId));

async function loadPrivate(game, keepStatus) {
  const current = game ? onlineMatch(game) : null;
  const show = Boolean(me && current && !current.legacy && current.canStart);
  $('detail-private-box').classList.toggle('hidden', !show);
  if (!keepStatus) setStatus('private-status', '');
  if (!show) return;
  try {
    const data = await api.privateServers(current.placeId);
    if (!shownGame(current)) return;
    renderPrivate(current, Array.isArray(data.servers) ? data.servers : []);
  } catch (error) {
    if (shownGame(current)) setStatus('private-status', message(error), 'error');
  }
}

function renderPrivate(game, servers) {
  const list = $('detail-private');
  list.textContent = '';
  for (const server of servers) {
    const row = el('div', 'server-row');
    const text = el('div', 'server-text');
    text.append(el('b', '', server.name), el('span', 'server-count', server.mine ? 'Yours' : `${server.owner.name}'s`));
    if (server.playing) text.append(el('span', 'server-count live', `${server.playing} playing`));
    if (server.players && server.players.length) text.append(el('div', 'server-players', server.players.join(', ')));
    if (server.mine) text.append(el('div', 'server-players', `Code ${server.code}`));
    const join = el('button', 'ghost', 'Join');
    join.disabled = Boolean(state && state.play.active);
    join.addEventListener('click', () => startPlay(game, { privateId: server.id }));
    row.append(text, join);
    if (server.mine) {
      const copy = el('button', 'ghost', 'Copy code');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(server.code).then(
          () => setStatus('private-status', `Copied ${server.code}`, 'good'),
          () => setStatus('private-status', `The code is ${server.code}`));
      });
      const remove = el('button', 'ghost', 'Delete');
      remove.addEventListener('click', () => privateAction(game, server, 'delete'));
      row.append(copy, remove);
    }
    list.append(row);
  }
}

async function privateAction(game, server, verb) {
  if (verb === 'delete' && !window.confirm(`Delete "${server.name}"? Anyone in it goes back to the launcher.`)) return;
  try {
    await api.privateServerAction({ id: server.id, verb });
    setStatus('private-status', verb === 'delete' ? `Deleted ${server.name}` : 'Done', 'good');
  } catch (error) {
    setStatus('private-status', message(error), 'error');
  }
  loadPrivate(game, true);
}

$('private-create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const game = detailGame;
  if (!game || !me) return;
  try {
    const result = await api.createPrivateServer({ placeId: game.placeId, name: $('private-name').value.trim() || `${me.account.name}'s server` });
    closePrivateForms();
    sfx.play('success');
    setStatus('private-status', `Made ${result.server.name}. Friends can join; anyone else needs code ${result.server.code}.`, 'good');
  } catch (error) {
    setStatus('private-status', message(error), 'error');
  }
  loadPrivate(game, true);
});

$('private-redeem').addEventListener('submit', async (event) => {
  event.preventDefault();
  const game = detailGame;
  const code = $('private-code').value.trim();
  if (!game || !me || !code) return;
  try {
    const result = await api.redeemPrivateCode(code);
    closePrivateForms();
    const server = result.server;
    setStatus('private-status', String(server.placeId) === String(game.placeId)
      ? `Added ${server.name}`
      : `That code is for ${server.name} in ${server.gameName}. It's listed there now.`, 'good');
  } catch (error) {
    setStatus('private-status', message(error), 'error');
  }
  loadPrivate(game, true);
});

// New / Enter code each open one small form; only one shows at a time.
function closePrivateForms() {
  for (const id of ['private-create', 'private-redeem']) $(id).classList.add('hidden');
  $('private-name').value = '';
  $('private-code').value = '';
}
function openPrivateForm(id, input) {
  const wasOpen = !$(id).classList.contains('hidden');
  closePrivateForms();
  setStatus('private-status', '');
  if (wasOpen) return;
  $(id).classList.remove('hidden');
  focusEl($(input));
}
$('private-new').addEventListener('click', () => openPrivateForm('private-create', 'private-name'));
$('private-enter').addEventListener('click', () => openPrivateForm('private-redeem', 'private-code'));
for (const cancel of document.querySelectorAll('.private-form [data-cancel]')) cancel.addEventListener('click', closePrivateForms);

function closeDetail() {
  $('overlay').classList.add('hidden');
  const first = firstFocusable(`#view-${view}`);
  if (first) focusEl(first);
}

$('detail-back').addEventListener('click', closeDetail);
// --- loading screen ---------------------------------------------------------------------
// From Play until the game's own window takes over (the launcher loses focus
// to it), like Roblox's: the game, its creator and what is happening.

// Set while Play waits, so a game files update shows its progress here.
let playStarting = false;
let loading = null; // { game, cancelled, started }

function setLoadingStatus(text, kind) {
  const status = $('loading-status');
  if (kind === 'error' && !status.classList.contains('error')) sfx.play('error');
  status.textContent = text;
  status.className = `loading-status${kind ? ` ${kind}` : ''}`;
}

function setLoadingBar(fraction) {
  $('loading-bar').classList.toggle('hidden', fraction === null);
  if (fraction !== null) $('loading-bar-fill').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function showLoading(game) {
  loading = { game, cancelled: false, started: false, failed: false };
  $('loading-screen').classList.remove('failed');
  $('loading-log').classList.add('hidden');
  $('loading-backdrop').textContent = '';
  $('loading-backdrop').append(cover(game));
  $('loading-cover').textContent = '';
  $('loading-cover').append(cover(game));
  $('loading-name').textContent = game.name || 'Game';
  $('loading-by').textContent = game.creator ? `By ${game.creator}` : '';
  setLoadingStatus('Getting ready…');
  setLoadingBar(null);
  $('loading-cancel').textContent = 'Cancel';
  $('loading-screen').classList.remove('hidden');
  focusEl($('loading-cancel'));
}

function hideLoading() {
  loading = null;
  $('loading-screen').classList.add('hidden');
}

$('loading-cancel').addEventListener('click', () => {
  if (!loading) return hideLoading();
  if (!loading.started) loading.cancelled = true; // stops the client as soon as it starts
  api.stopClient(); // and stops waiting for a server
  hideLoading();
});

// While the server starts a game server for this join.
api.onPlayProgress((info) => {
  if (loading && !loading.started && info && info.text) setLoadingStatus(info.text);
});

// Roblox closed soon after starting, or could not start (main.js
// 'play-failed'): the loading screen stays (or comes back) with the reason.
let lastPlayGame = null;
api.onPlayFailed((info) => {
  if (!loading) showLoading(lastPlayGame || (info && info.game) || { name: 'Roblox' });
  loading.started = true;
  loading.failed = true;
  $('loading-screen').classList.add('failed');
  setLoadingBar(null);
  setLoadingStatus((info && info.text) || 'Roblox closed right after starting.', 'error');
  $('loading-log').classList.remove('hidden');
  $('loading-cancel').textContent = 'Close';
  focusEl($('loading-cancel'));
});

$('loading-log').addEventListener('click', () => api.openLauncherLog());

// The game fills the launcher's window (main.js embedClient); nothing of the
// launcher shows until it closes.
api.onPlayEmbed(({ state: embed }) => {
  const inside = embed === 'embedded';
  document.body.classList.toggle('in-game', inside);
  if (!inside) return;
  if (loading && !loading.failed) hideLoading();
  music.pause();
});

// A clicked friend notification (main.js checkFriendNews).
api.onOpenView((name) => {
  if (screen !== 'shell') return;
  closeProfile();
  showView(name, true);
  if (name === 'players') refreshOnlinePlayers(true);
});

// The game window takes the focus once it is up.
window.addEventListener('blur', () => {
  if (loading && loading.started && !loading.failed) setTimeout(() => { if (loading && loading.started && !loading.failed) hideLoading(); }, 400);
});

// Play: any server of the game with room (the server starts one if none
// has). Older servers cannot pick: then the first listed server.
$('detail-play').addEventListener('click', () => {
  const game = detailGame ? onlineMatch(detailGame) || detailGame : null;
  if (!game) return;
  const first = (game.servers || [])[0];
  if (!game.legacy) startPlay(game, { placeId: game.placeId });
  else if (first) startPlay(game, { gameId: first.id, address: first.address });
});

// request: { placeId } | { gameId, address } | { privateId } (main.js play:join)
async function startPlay(game, request) {
  if (!game || loading) return;
  $('detail-play').disabled = true;
  $('detail-note').textContent = '';
  closeDetail();
  showLoading(game);
  lastPlayGame = game;
  const mine = loading;
  playStarting = true;
  try {
    setLoadingStatus(request.privateId ? 'Joining the private server…' : 'Finding a server…');
    const joined = await api.join({ request, game: { name: game.name, placeId: game.placeId }, guest: !me, embed: true });
    playStarting = false;
    rememberPlayed(game);
    renderHome();
    if (mine.cancelled) {
      api.stopClient();
      return;
    }
    if (loading !== mine) return;
    mine.started = true;
    setLoadingBar(null);
    setLoadingStatus(joined.guest ? `Starting Roblox as ${joined.name}…` : 'Starting Roblox…');
    $('loading-cancel').textContent = 'Close the game';
    // If the window never takes the focus (another window in front), stop waiting.
    setTimeout(() => { if (loading === mine && !mine.failed) hideLoading(); }, 25000);
  } catch (error) {
    playStarting = false;
    if (/sign in/i.test(message(error)) && me) {
      // The session ran out on the server.
      me = null;
      updateIdentity();
    }
    if (loading !== mine) return;
    hideLoading();
    openDetail(game);
    $('detail-note').textContent = message(error);
  } finally {
    $('detail-play').disabled = false;
  }
}

// --- state -----------------------------------------------------------------------------

async function refreshState() {
  state = await api.state();
  if (!capabilitiesApplied) applyCapabilities();
  showUpdate(state.update);
  if (!formsFilled) fillForms();
  $('presence-dot').className = `presence-dot${state.web.tailscaleUrl ? ' on' : ''}`;
  $('start-foot').textContent = `Launcher ${state.version}${serverAddress() && !state.fixedServer ? ` · ${serverAddress()}` : ''}`;

  // Games / play
  // The client closed (or failed) before its window took over.
  if (loading && loading.started && !loading.failed && !state.play.active) hideLoading();
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
    setStatus('play-status', lastGames.length ? '' : 'No games are online right now.');
  } catch (error) {
    lastGames = [];
    setStatus('play-status', message(error), 'error');
  } finally {
    findingGames = false;
    $('play-refresh').disabled = false;
    refreshOnlinePlayers(true);
    renderAllGames();
    if (screen === 'shell' && view === 'home') renderHome();
    // Open details: the fresh copy of the game and its servers.
    const current = !$('overlay').classList.contains('hidden') && detailGame ? onlineMatch(detailGame) : null;
    if (current) {
      detailGame = current;
      renderDetailMeta(current, true);
      if (!$('detail-servers-box').contains(document.activeElement)) {
        renderServerList(current.servers || [], isPlayable(current) && !(state && state.play.active));
      }
    }
  }
}

function renderAllGames() {
  const list = $('all-games');
  list.textContent = '';
  for (const game of lastGames) {
    list.append(gameTile(game, { players: playersIn(game), caption: game.creator ? `By ${game.creator}` : '' }));
  }
  if (lastGames.length === 0) list.append(placeholder('No games online. Host one, or ask your host to turn one on.', '·'));
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
      ? `Studio is open. Sign in there as ${me.account.name}.`
      : 'Studio is open. It needs an account, so sign up here first.', 'good');
  } catch (error) {
    setStatus('play-status', message(error), 'error');
  } finally {
    button.disabled = false;
  }
});
api.onStudioProgress((info) => {
  if (info.phase === 'checking') setStatus('play-status', 'Contacting the server…');
  if (info.phase === 'download') setStatus('play-status', `Downloading Studio… ${mbText(info.received)} of ${mbText(info.total)} MB`);
  if (info.phase === 'retry') setStatus('play-status', `The connection dropped. Continuing Studio from ${mbText(info.received)} MB (try ${info.attempt})…`);
  if (info.phase === 'unpack') setStatus('play-status', 'Unpacking Studio…');
});
$('play-close').addEventListener('click', () => api.stopClient());

// --- people: friends, search, profiles --------------------------------------------------------

let refreshingPlayers = false;
let friendData = null; // { friends, incoming, outgoing } for the signed-in account
let peopleResults = null; // the last search: { title, people }

// Also refreshes an open search or Following list and an open profile, so
// what they say about people stays current.
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
  } catch (error) {
    if (!quiet) setStatus('friends-status', message(error), 'error');
  } finally {
    refreshingPlayers = false;
    updateFriendsBadge();
    if (view === 'players' && peopleResults) await reloadPeopleResults();
    if (view === 'players') renderPlayers();
    renderFriendsStrip();
    refreshOpenProfile();
  }
}

// presence: game | studio | online | offline. Servers before 1.8.0 only say
// who is in a game.
function presenceOf(person) {
  if (!person) return 'offline';
  if (person.presence) return person.presence;
  return person.online || person.gameId ? 'game' : 'offline';
}

const PRESENCE_WORDS = { studio: 'In Studio', online: 'Online', offline: 'Offline' };

function updateFriendsBadge() {
  const count = friendData && me ? friendData.incoming.length : 0;
  $('friends-badge').textContent = String(count);
  $('friends-badge').classList.toggle('hidden', count === 0);
}

const SILHOUETTE = '<svg viewBox="0 0 100 120" aria-hidden="true"><rect x="34" y="8" width="32" height="30" rx="4"/><rect x="26" y="42" width="48" height="44" rx="3"/><rect x="12" y="44" width="12" height="38" rx="3"/><rect x="76" y="44" width="12" height="38" rx="3"/><rect x="28" y="88" width="20" height="30" rx="3"/><rect x="52" y="88" width="20" height="30" rx="3"/></svg>';

// The player's picture (the one their launcher drew), or the silhouette.
function personPicture(box, userId, size = 150) {
  box.innerHTML = SILHOUETTE;
  if (userId === null || userId === undefined || Number(userId) <= 0) return;
  const img = el('img');
  img.alt = '';
  img.src = `launcher-net://server/avatar-thumbnail/image?userId=${encodeURIComponent(userId)}&width=${size}&height=${size}`;
  img.addEventListener('load', () => { box.textContent = ''; box.append(img); });
}

// The game someone is playing, from the game list.
function onlineGame(person) {
  const where = person.online || person;
  const gameId = person.gameId || (person.online && person.online.gameId) || null;
  return (gameId ? lastGames.find((game) => (game.servers || []).some((server) => server.id === gameId)) : null)
    || (where.placeId ? lastGames.find((game) => String(game.placeId) === String(where.placeId)) : null) || null;
}

// A card: picture, name and where they are; clicking it opens their profile.
// actions: [[label, verb, className]], buttons under it ('join' joins their game).
function personCard(person, where, actions = []) {
  const card = el('div', `player-card p-${presenceOf(person)}`);
  const main = el('button', 'card-main nav-target');
  main.dataset.player = person.name;
  if (me && me.account.name.toLowerCase() === person.name.toLowerCase()) card.classList.add('you');
  const pic = el('div', 'player-pic');
  personPicture(pic, person.userId);
  main.append(pic, el('div', 'player-name', person.name), el('div', 'player-where', where));
  if (person.admin) main.append(el('span', 'badge-admin', 'ADMIN'));
  main.addEventListener('click', () => openProfile(person));
  card.append(main);
  if (actions.length) {
    const row = el('div', 'card-actions');
    for (const [label, verb, kind] of actions) {
      const button = el('button', kind || 'ghost', label);
      button.addEventListener('click', () => (verb === 'join' ? joinPerson(person) : verb === 'unfollow' ? setFollow(person, false) : friendAction(verb, person)));
      row.append(button);
    }
    card.append(row);
  }
  return card;
}

const FRIEND_TEXTS = {
  request: (r) => (r.became === 'friends' ? `You and ${r.name} are now friends!` : `Friend request sent to ${r.name}.`),
  accept: (r) => `You and ${r.name} are now friends!`,
  decline: (r) => `Declined ${r.name}'s request.`,
  cancel: (r) => `Took back your request to ${r.name}.`,
  remove: (r) => `${r.name} is no longer your friend.`,
};

// -> true when it worked
async function friendAction(verb, person, statusId = 'friends-status') {
  if (verb === 'remove' && !window.confirm(`Remove ${person.name} from your friends?`)) return false;
  setStatus(statusId, '');
  let ok = false;
  try {
    const result = await api.friendAction(verb, { name: person.name });
    friendData = result;
    if (verb === 'accept' || result.became === 'friends') sfx.play('success');
    setStatus(statusId, FRIEND_TEXTS[verb](result), 'good');
    ok = true;
  } catch (error) {
    setStatus(statusId, message(error), 'error');
  }
  updateFriendsBadge();
  renderPlayers();
  renderFriendsStrip();
  if (ok && peopleResults) reloadPeopleResults().then(renderPlayers);
  return ok;
}

// Follow or unfollow -> the updated profile, or null.
async function setFollow(person, on, statusId = 'friends-status') {
  setStatus(statusId, '');
  try {
    const profile = await api.setFollow(person.userId, on);
    setStatus(statusId, on ? `Following ${person.name}` : `Unfollowed ${person.name}`, 'good');
    if (peopleResults) reloadPeopleResults().then(renderPlayers);
    return profile;
  } catch (error) {
    setStatus(statusId, message(error), 'error');
    return null;
  }
}

// Joins the very server someone is in (a private one only if you may).
async function joinPerson(person) {
  // The game list is only kept fresh on Home and Games: get it if their game isn't on it.
  if (!onlineGame(person)) await findGames(true);
  const game = onlineGame(person);
  const gameId = person.gameId || (person.online && person.online.gameId) || null;
  if (!game || !gameId) {
    setStatus('friends-status', `${person.name}'s game is not in the game list right now.`, 'error');
    return;
  }
  closeProfile();
  const server = (game.servers || []).find((entry) => entry.id === gameId);
  startPlay(game, { gameId, address: server ? server.address : undefined });
}

// Where someone is, and how you two relate.
function relation(person) {
  const status = person.friendStatus;
  if (status === 'Friend') return ' · Friend';
  if (status === 'FriendRequestSent') return ' · Request sent';
  if (status === 'FriendRequestReceived') return ' · Wants to be friends';
  return '';
}

function whereText(person) {
  const presence = presenceOf(person);
  if (presence !== 'game') return PRESENCE_WORDS[presence];
  const game = person.online || (person.gameId ? { gameName: person.gameName, privateServer: person.privateServer } : null);
  if (game) return `In ${game.gameName}${game.privateServer ? ' (private)' : ''}`;
  return person.gameName ? `In ${person.gameName}` : 'In a game';
}

// The list in the People tab's results area: a search, everyone, or who you follow.
async function fetchPeople(mode, search) {
  if (mode === 'following') {
    const data = await api.following();
    return { mode, search: '', people: data.following || [], followers: data.followers || [] };
  }
  const data = await api.people(search);
  return { mode: 'search', search, people: data.people || [] };
}

async function reloadPeopleResults() {
  if (!peopleResults) return;
  const shown = peopleResults;
  try {
    const fresh = await fetchPeople(shown.mode, shown.search);
    if (peopleResults === shown) peopleResults = fresh;
  } catch (error) { /* keep the last list; the next refresh tries again */ }
}

async function searchPeople(search, quiet, mode = 'search') {
  const text = String(search || '').trim();
  if (!quiet) setStatus('friends-status', mode === 'following' ? 'Loading…' : text ? `Looking for "${text}"…` : 'Loading everyone…');
  try {
    peopleResults = await fetchPeople(mode, text);
    if (!quiet) setStatus('friends-status', '');
  } catch (error) {
    setStatus('friends-status', message(error), 'error');
    return;
  }
  renderPlayers();
}

$('people-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('people-search').value.trim();
  if (text && !/^[A-Za-z0-9_]{1,20}$/.test(text)) { setStatus('friends-status', 'Names have letters, digits and _ only.', 'error'); return; }
  searchPeople(text);
});
$('people-everyone').addEventListener('click', () => { $('people-search').value = ''; searchPeople(''); });
$('people-following').addEventListener('click', () => { $('people-search').value = ''; searchPeople('', false, 'following'); });
$('friends-signin').addEventListener('click', () => { setAccountMode('signup'); showScreen('account'); });

function renderPlayers() {
  const focusedName = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.player : null;
  $('friends-guest').classList.toggle('hidden', Boolean(me));
  $('friends-area').classList.toggle('hidden', !me);
  $('people-following').classList.toggle('hidden', !me);
  $('people-following').classList.toggle('active', Boolean(peopleResults && peopleResults.mode === 'following'));

  // Search results, everyone, or who you follow.
  $('people-results').classList.toggle('hidden', !peopleResults);
  if (peopleResults) {
    const grid = $('people-grid');
    grid.textContent = '';
    const { mode, search, people } = peopleResults;
    const online = people.filter((person) => presenceOf(person) !== 'offline').length;
    $('people-title').textContent = mode === 'following'
      ? `FOLLOWING (${people.length})`
      : search ? `PLAYERS NAMED "${search.toUpperCase()}" (${people.length})`
        : `EVERYONE (${people.length}${online ? `, ${online} online` : ''})`;
    for (const person of people) {
      const actions = [];
      if (person.online && onlineGame(person) && !person.self) actions.push(['Join', 'join', 'primary']);
      if (mode === 'following') actions.push(['Unfollow', 'unfollow']);
      else if (me && !person.self && person.friendStatus === 'NotFriend') actions.push(['Add friend', 'request']);
      if (me && person.friendStatus === 'FriendRequestReceived') actions.push(['Accept', 'accept', 'primary']);
      grid.append(personCard(person, `${whereText(person)}${relation(person)}`, actions));
    }
    if (!people.length) {
      grid.append(el('div', 'empty-note', mode === 'following' ? "You don't follow anyone yet. Open someone's profile to follow them."
        : search ? `Nobody here is called anything like "${search}".` : 'Nobody has an account here yet.'));
    }
  }

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
    const online = mine.filter((friend) => presenceOf(friend) !== 'offline').length;
    $('friends-title').textContent = mine.length ? `FRIENDS (${online} of ${mine.length} online)` : 'FRIENDS';
    for (const friend of mine) {
      list.append(personCard(friend, whereText(friend), friend.online && onlineGame(friend) ? [['Join', 'join', 'primary']] : []));
    }
    if (!mine.length) list.append(el('div', 'empty-note', 'No friends yet. Find someone above, open their profile and add them.'));
  }
  if (focusedName) {
    const again = [...document.querySelectorAll('#view-players .card-main')].find((node) => node.dataset.player === focusedName);
    if (again) again.focus({ preventScroll: true });
  }
}

// Home: friends, the ones in a game first.
function renderFriendsStrip() {
  const box = $('home-friends');
  const mine = me && friendData ? friendData.friends : [];
  box.classList.toggle('hidden', !me);
  if (!me) return;
  const strip = $('friends-strip');
  strip.textContent = '';
  const online = mine.filter((friend) => presenceOf(friend) !== 'offline').length;
  $('home-friends-note').textContent = mine.length ? `${online} of ${mine.length} online` : '';
  for (const friend of mine.slice(0, 24)) {
    const presence = presenceOf(friend);
    // Rings like Roblox's: blue online, green in a game, orange in Studio.
    const bubble = el('button', `friend-bubble nav-target p-${presence}`);
    const pic = el('div', 'bubble-pic');
    personPicture(pic, friend.userId, 150);
    bubble.append(pic, el('div', 'bubble-name', friend.name));
    if (presence === 'game' || presence === 'studio') bubble.append(el('div', 'bubble-where', presence === 'studio' ? 'Studio' : whereText(friend).replace(/^In /, '')));
    bubble.title = `${friend.name}: ${whereText(friend)}`;
    bubble.addEventListener('click', () => openProfile(friend));
    strip.append(bubble);
  }
  if (!mine.length) {
    const find = el('button', 'friend-bubble nav-target');
    const pic = el('div', 'bubble-pic');
    pic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" style="height:46%;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round"><path d="M12 5v14M5 12h14"/></svg>';
    find.append(pic, el('div', 'bubble-name', 'Find friends'));
    find.addEventListener('click', () => { showView('players', true); searchPeople(''); });
    strip.append(find);
  }
}

// --- profile overlay ---------------------------------------------------------------------------

let profilePerson = null; // the profile shown

function closeProfile() {
  profilePerson = null;
  $('profile-overlay').classList.add('hidden');
  const first = firstFocusable(`#view-${view}`);
  if (first) focusEl(first);
}

function profileButton(label, kind, onClick) {
  const button = el('button', kind, label);
  button.addEventListener('click', onClick);
  return button;
}

// Big numbers with small labels; counts the server does not send are left out.
function renderProfileStats(person) {
  const box = $('profile-stats');
  box.textContent = '';
  for (const [count, one, many] of [[person.friendCount, 'Friend', 'Friends'], [person.followerCount, 'Follower', 'Followers'], [person.followingCount, 'Following', 'Following']]) {
    if (!Number.isFinite(count)) continue;
    const stat = el('div', 'profile-stat');
    stat.append(el('b', '', String(count)), el('span', '', count === 1 ? one : many));
    box.append(stat);
  }
}

// The game they're in, with its picture and Join.
function renderProfileGame(person) {
  const box = $('profile-game');
  box.textContent = '';
  const game = presenceOf(person) === 'game' ? onlineGame(person) : null;
  box.classList.toggle('hidden', !game || person.self);
  if (!game || person.self) return;
  const pic = el('div', 'profile-game-pic');
  pic.append(cover(game));
  const text = el('div', 'profile-game-text');
  text.append(el('span', '', person.online && person.online.privateServer ? 'In a private server' : 'Playing'), el('b', '', game.name));
  const join = el('button', 'play-button small', 'Join');
  join.addEventListener('click', () => joinPerson(person));
  box.append(pic, text, join);
}

function renderProfile(person) {
  $('profile-name').textContent = person.name;
  $('profile-admin').classList.toggle('hidden', !person.admin);
  const presence = presenceOf(person);
  $('profile-where').textContent = whereText(person);
  $('profile-where').className = `profile-where p-${presence}`;
  $('profile-follows-you').classList.toggle('hidden', !person.followsYou);
  renderProfileStats(person);
  renderProfileGame(person);
  $('profile-joined').textContent = person.joinedAt
    ? `Joined ${new Date(person.joinedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` : '';
  const bio = $('profile-bio');
  bio.textContent = person.bio || (person.self ? 'You have no bio yet.' : 'No bio yet.');
  bio.classList.toggle('empty', !person.bio);
  $('profile-bio-form').classList.add('hidden');
  $('profile-report').classList.add('hidden');
  bio.classList.remove('hidden');

  const actions = $('profile-actions');
  actions.textContent = '';
  if (person.self) {
    actions.append(profileButton('Edit bio', 'ghost', () => {
      $('profile-bio-text').value = person.bio || '';
      $('profile-bio-form').classList.remove('hidden');
      bio.classList.add('hidden');
      focusEl($('profile-bio-text'));
    }));
  } else if (me && person.blocked) {
    actions.append(profileButton('Unblock', 'ghost', () => setBlock(person, false)));
  } else if (me) {
    const act = (verb) => async () => {
      if (await friendAction(verb, person, 'profile-status')) openProfile(person, true);
    };
    const status = person.friendStatus;
    if (status === 'Friend') actions.append(profileButton('Unfriend', 'ghost', act('remove')));
    else if (status === 'FriendRequestSent') actions.append(profileButton('Take back request', 'ghost', act('cancel')));
    else if (status === 'FriendRequestReceived') {
      actions.append(profileButton('Accept friend request', 'primary', act('accept')), profileButton('Decline', 'ghost', act('decline')));
    } else actions.append(profileButton('Add friend', 'primary', act('request')));
    if (person.following !== undefined) {
      actions.append(profileButton(person.following ? 'Unfollow' : 'Follow', 'ghost', async () => {
        const updated = await setFollow(person, !person.following, 'profile-status');
        if (updated && profilePerson) renderProfile(Object.assign(updated, { self: false }));
      }));
    }
    const report = profileButton('Report', 'link profile-report-link', () => {
      $('profile-report-name').textContent = person.name;
      $('profile-report-reason').value = '';
      $('profile-report-text').value = '';
      $('profile-report').classList.remove('hidden');
      focusEl($('profile-report-reason'));
    });
    actions.append(report);
    if (person.blocked === false) {
      actions.append(profileButton('Block', 'link profile-block-link', () => {
        if (window.confirm(`Block ${person.name}? You stop being friends, neither of you follows the other, and they can't send you friend requests.`)) setBlock(person, true);
      }));
    }
  }
}

async function setBlock(person, on) {
  setStatus('profile-status', '');
  try {
    const updated = await api.setBlock(person.userId, on);
    setStatus('profile-status', on ? `Blocked ${person.name}` : `Unblocked ${person.name}`, 'good');
    if (profilePerson) renderProfile(Object.assign(updated, { self: false }));
    refreshOnlinePlayers(true);
  } catch (error) {
    setStatus('profile-status', message(error), 'error');
  }
}

async function openProfile(person, keepStatus) {
  if (!person || !(Number(person.userId) > 0)) {
    setStatus('friends-status', `${person ? person.name : 'That player'} is a guest: guests have no profile.`, 'error');
    return;
  }
  profilePerson = person;
  if (!keepStatus) setStatus('profile-status', 'Loading…');
  if ($('profile-overlay').classList.contains('hidden')) {
    sfx.play('overlay');
    personPicture($('profile-pic'), person.userId, 420);
    renderProfile(Object.assign({ bio: '', friendStatus: null }, person, { self: Boolean(me && me.account.userId === person.userId) }));
    $('profile-overlay').classList.remove('hidden');
    focusEl($('profile-back'));
  }
  try {
    const full = await api.profile(person.userId);
    if (profilePerson !== person) return;
    renderProfile(full);
    if (!keepStatus) setStatus('profile-status', '');
    const first = $('profile-actions').querySelector('button');
    if (first && document.activeElement === $('profile-back')) focusEl(first);
  } catch (error) {
    if (profilePerson === person) setStatus('profile-status', message(error), 'error');
  }
}

// Keeps an open profile current (People refreshes every 15 s), unless you're typing in it.
function refreshOpenProfile() {
  if (!profilePerson || $('profile-overlay').classList.contains('hidden')) return;
  if (!$('profile-bio-form').classList.contains('hidden') || !$('profile-report').classList.contains('hidden')) return;
  openProfile(profilePerson, true);
}

$('profile-report-cancel').addEventListener('click', () => $('profile-report').classList.add('hidden'));
$('profile-report').addEventListener('submit', async (event) => {
  event.preventDefault();
  const person = profilePerson;
  const reason = $('profile-report-reason').value;
  if (!person) return;
  if (!reason) { setStatus('profile-status', 'Pick a reason.', 'error'); return; }
  try {
    await api.reportPlayer({ userId: person.userId, reason, text: $('profile-report-text').value.trim() });
    $('profile-report').classList.add('hidden');
    setStatus('profile-status', 'Thanks. The admins will look at it.', 'good');
  } catch (error) {
    setStatus('profile-status', message(error), 'error');
  }
});
$('profile-back').addEventListener('click', closeProfile);
$('profile-bio-cancel').addEventListener('click', () => {
  $('profile-bio-form').classList.add('hidden');
  $('profile-bio').classList.remove('hidden');
});
$('profile-bio-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('profile-status', 'Saving…');
  try {
    const saved = await api.saveBio($('profile-bio-text').value);
    renderProfile(Object.assign({}, saved, { friendCount: undefined }));
    setStatus('profile-status', 'Saved.', 'good');
    if (profilePerson) openProfile(profilePerson, true);
  } catch (error) {
    setStatus('profile-status', message(error), 'error');
  }
});
$('profile-overlay').addEventListener('click', (event) => { if (event.target === $('profile-overlay')) closeProfile(); });

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

// --- game assets kept on this PC (lib/proxycache.js) ---

function megabytes(bytes) {
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1048576))} MB`;
}

async function showAssetCache(note, kind) {
  try {
    const info = await api.assetCache();
    const text = info.limitBytes === 0
      ? 'Turned off ("assetCacheMB": 0 in config\\client.json).'
      : `${info.files} asset${info.files === 1 ? '' : 's'}, ${megabytes(info.bytes)} (up to ${megabytes(info.limitBytes)}; the least used go first).`;
    setStatus('asset-cache-size', note ? `${note} ${text}` : text, kind);
    $('asset-cache-clear').disabled = info.files === 0;
  } catch (error) {
    setStatus('asset-cache-size', message(error), 'error');
  }
}

$('asset-cache-clear').addEventListener('click', async () => {
  $('asset-cache-clear').disabled = true;
  try {
    await api.clearAssetCache();
    showAssetCache('Cleared.', 'good');
  } catch (error) {
    setStatus('asset-cache-size', message(error), 'error');
    $('asset-cache-clear').disabled = false;
  }
});

// --- Settings > Storage: what can be freed (main.js storage:*, cleanup.js) ---

let cleaningStorage = false;

async function showStorage(note, kind) {
  let info;
  try {
    info = await api.storage();
  } catch (error) {
    setStatus('storage-status', message(error), 'error');
    return;
  }
  for (const name of ['logs', 'updates', 'leftovers', 'studio']) {
    const row = $(`storage-${name}`);
    const part = info[name];
    row.classList.toggle('hidden', !part);
    if (!part) continue;
    row.querySelector('.storage-size').textContent = part.files === 0 ? 'None' : megabytes(part.bytes);
    row.querySelector('button').disabled = cleaningStorage || part.files === 0;
  }
  setStatus('storage-status', note || '', kind);
}

document.querySelectorAll('#storage-panel button[data-clean]').forEach((button) => button.addEventListener('click', async () => {
  if (cleaningStorage) return;
  const kind = button.dataset.clean;
  cleaningStorage = true;
  document.querySelectorAll('#storage-panel button[data-clean]').forEach((other) => { other.disabled = true; });
  setStatus('storage-status', kind === 'studio' ? 'Removing Studio…' : 'Deleting…');
  try {
    const result = await api.cleanStorage(kind);
    cleaningStorage = false;
    const kept = result.skipped ? ` ${result.skipped} file${result.skipped === 1 ? ' is' : 's are'} in use and stayed (close the game or Studio and try again).` : '';
    await showStorage(`Freed ${megabytes(result.bytes)}.${kept}`, result.skipped ? null : 'good');
  } catch (error) {
    cleaningStorage = false;
    await showStorage();
    setStatus('storage-status', message(error), 'error');
  }
}));

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

// "3.4" or "85" (MB): small updates still show progress.
function mbText(bytes) {
  return bytes < 1e7 ? (bytes / 1e6).toFixed(1) : String(Math.round(bytes / 1e6));
}

api.onFilesProgress((info) => {
  const bar = $('files-progress');
  if (info.phase === 'checking') setStatus('files-status', 'Contacting the server…');
  if (info.phase === 'download') {
    bar.max = info.total;
    bar.value = info.received;
    setStatus('files-status', `Downloading… ${mbText(info.received)} of ${mbText(info.total)} MB`);
  }
  if (info.phase === 'retry') setStatus('files-status', `The connection dropped. Continuing from ${mbText(info.received)} MB (try ${info.attempt})…`);
  if (info.phase === 'unpack') {
    bar.removeAttribute('value');
    setStatus('files-status', 'Unpacking…');
  }
  if (playStarting && loading) {
    if (info.phase === 'checking') setLoadingStatus('The server has new game files. Updating…');
    if (info.phase === 'download') {
      setLoadingStatus(`Updating the game files… ${mbText(info.received)} of ${mbText(info.total)} MB`);
      setLoadingBar(info.total ? info.received / info.total : null);
    }
    if (info.phase === 'retry') setLoadingStatus(`The connection dropped. Continuing the update from ${mbText(info.received)} MB…`);
    if (info.phase === 'unpack') {
      setLoadingStatus('Installing the game files update…');
      setLoadingBar(null);
    }
    if (info.phase === 'done') setLoadingStatus('Game files updated. Joining the server…');
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
$('open-launcher-log').addEventListener('click', () => api.openLauncherLog());

// --- update log ------------------------------------------------------------------------------
// changelog.json (shipped in the app, newest first): Settings > About > Update
// log shows all of it; after an update, "What's new" shows the new version once.

let changelogEntries = null;
async function loadChangelog() {
  if (!changelogEntries) changelogEntries = await api.changelog().catch(() => []);
  return changelogEntries;
}

function changelogEntry(entry) {
  const box = el('div', 'changelog-entry');
  const head = el('div', 'changelog-head');
  head.append(el('b', '', entry.version));
  if (entry.date) head.append(el('span', '', new Date(`${entry.date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })));
  box.append(head);
  if (entry.title) box.append(el('div', 'changelog-title', entry.title));
  const list = el('ul');
  for (const item of entry.items || []) list.append(el('li', '', item));
  box.append(list);
  return box;
}

// version: that release only ("What's new"), or null for every release.
async function showWhatsNew(version) {
  const all = await loadChangelog();
  const entries = version ? all.filter((entry) => entry.version === version) : all;
  if (!entries.length) return false;
  $('whats-new-title').textContent = version ? `What's new in ${version}` : 'Update log';
  $('whats-new-list').replaceChildren(...entries.map(changelogEntry));
  $('whats-new-list').scrollTop = 0;
  sfx.play('overlay');
  $('news-overlay').classList.remove('hidden');
  focusEl($('whats-new-close'));
  return true;
}

function closeWhatsNew() {
  $('news-overlay').classList.add('hidden');
  const first = firstFocusable(`#view-${view}`);
  if (first) focusEl(first);
}

// Once per version, the first time the menu opens after an update.
async function whatsNewAfterUpdate() {
  if (!state || storage('seenVersion') === state.version) return;
  storage('seenVersion', state.version);
  await showWhatsNew(state.version);
}

// --- Tailscale removal: once the server answers without it ---------------------------------

let tailscaleOffered = false;
async function offerTailscaleRemoval() {
  if (tailscaleOffered || screen !== 'shell') return;
  // After the update log, if that is open.
  if (!$('news-overlay').classList.contains('hidden') || !$('overlay').classList.contains('hidden')) {
    setTimeout(offerTailscaleRemoval, 5000);
    return;
  }
  const result = await api.tailscaleOffer().catch(() => ({ offer: false }));
  if (!result.offer || tailscaleOffered) return;
  tailscaleOffered = true;
  setStatus('ts-status', '');
  sfx.play('overlay');
  $('tailscale-overlay').classList.remove('hidden');
  focusEl($('ts-remove'));
}

function closeTailscalePrompt() {
  $('tailscale-overlay').classList.add('hidden');
  const first = firstFocusable(`#view-${view}`);
  if (first) focusEl(first);
}

$('ts-keep').addEventListener('click', async () => {
  await api.tailscaleKeep().catch(() => {});
  closeTailscalePrompt();
});
$('ts-remove').addEventListener('click', async () => {
  $('ts-remove').disabled = true;
  $('ts-keep').disabled = true;
  setStatus('ts-status', 'Follow the Windows prompts to finish.');
  try {
    const result = await api.tailscaleUninstall();
    if (result.removed) {
      setStatus('ts-status', 'Tailscale removed.', 'good');
      setTimeout(closeTailscalePrompt, 1500);
    } else {
      setStatus('ts-status', 'Tailscale is still installed. Remove it in Windows Settings > Apps.', 'error');
    }
  } catch (error) {
    setStatus('ts-status', message(error), 'error');
  } finally {
    $('ts-remove').disabled = false;
    $('ts-keep').disabled = false;
  }
});

$('about-changelog').addEventListener('click', () => showWhatsNew(null));
$('whats-new-close').addEventListener('click', closeWhatsNew);
$('news-overlay').addEventListener('click', (event) => { if (event.target === $('news-overlay')) closeWhatsNew(); });

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
  sfx.play('popup');
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
  if (state && !state.needsTailscale) $('join-panel').classList.add('hidden');
  findGames(true);
  setTimeout(offerTailscaleRemoval, 4000);
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
