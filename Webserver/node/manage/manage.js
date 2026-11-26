'use strict';

// Server management page (/manage). Its API is in lib/routes.js, lib/studio.js,
// lib/admin.js and lib/manageapi.js. Nothing shows until the server accepts
// the host key or a manage token: the launcher's Manage games button opens
// /manage#token=...
//
// This file holds what every view shares: requests, dialogs, the router, the
// data the views read and polling. The views are in dash.js, games.js,
// assets.js, people.js (players and reports) and system.js (announcements and
// the server); each registers itself in `views`.

const $ = (id) => document.getElementById(id);

// What the server said last. Views read it; loaders below fill it.
const data = {
  places: [],                 // /api/places
  runner: { running: false },
  engines: [],                // Roblox versions a game can use (lib/engines.js)
  overview: null,             // /api/manage/overview
  missing: [],                // /api/assets/missing
  search: null,               // /api/manage/asset-search
  reports: [],                // /api/reports
  accounts: [],               // /api/studio/accounts
  serverInfo: null,           // /api/server/status
};

const views = {};             // name -> { show(args), render(), leave() -> Promise<bool> }
let view = null;
let viewArgs = [];
let busy = false;             // a change is being sent; polling waits

// --- small helpers ---------------------------------------------------------------------

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function svg(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) if (value !== undefined && value !== null) node.setAttribute(key, value);
  for (const child of children.flat()) if (child) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const btn = (text, className, onclick, extra) => h('button', Object.assign({ type: 'button', class: `btn ${className || ''}`.trim(), text, onclick }, extra || {}));
const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || `${word}s`)}`;
const link = (text, hash, className) => h('a', { href: `#${hash}`, class: className || null, text });

function size(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
}
function when(iso) {
  const time = typeof iso === 'number' ? iso : Date.parse(String(iso || '').replace(' ', 'T'));
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function ago(iso) {
  const time = Date.parse(String(iso || '').replace(' ', 'T'));
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 45 ? `${days} d ago` : when(iso);
}
const placeById = (id) => data.places.find((place) => place.placeId === String(id)) || null;
const engineLabel = (id) => { const engine = data.engines.find((item) => item.id === id); return engine ? engine.label : id; };

// Redraws a container only when what it shows changed, so focus, open
// <details> and hover survive polling.
function paint(container, signature, build) {
  if (container.dataset.sig === signature) return false;
  container.dataset.sig = signature;
  container.replaceChildren(...[].concat(build()).filter(Boolean));
  return true;
}

// --- key / token -------------------------------------------------------------------------

function stored(name) { try { return localStorage.getItem(name) || ''; } catch (error) { return ''; } }
function store(name, value) {
  try { if (value) localStorage.setItem(name, value); else localStorage.removeItem(name); } catch (error) { /* private window */ }
}
const storedKey = () => stored('hostKey');
const storedToken = () => stored('manageToken');

// A token from the launcher (#token=...) is kept and taken out of the address.
function takeTokenFromAddress() {
  const match = /(?:^#|&)token=([0-9a-f]{64})/.exec(location.hash);
  if (!match) return false;
  store('manageToken', match[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
takeTokenFromAddress();

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (storedKey()) headers['X-Host-Key'] = storedKey();
  if (storedToken()) headers['X-Manage-Token'] = storedToken();
  return headers;
}

// GET -> parsed JSON, or throws with the server's message.
async function getJson(url) {
  const response = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 403) unlock();
  if (!response.ok) throw new Error(result.error || `The server answered HTTP ${response.status}.`);
  return result;
}

// Sends a change -> parsed JSON, or throws with the server's message.
async function change(method, url, body, contentType) {
  const response = await fetch(url, { method, headers: authHeaders({ 'Content-Type': contentType || 'application/json' }), body });
  const result = await response.json().catch(() => ({}));
  if (response.status === 403) unlock();
  if (!response.ok) throw new Error(result.error || `The server answered HTTP ${response.status}.`);
  return result;
}

// Uploads a file with progress -> parsed JSON, or throws.
function uploadFile(url, file, progress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    for (const [name, value] of Object.entries(authHeaders({ 'Content-Type': 'application/octet-stream' }))) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => { if (progress && event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100)); };
    // Sent: the server works on it now (progress may never have said 100).
    request.upload.onload = () => { if (progress) progress(100); };
    request.onload = () => {
      let result = {};
      try { result = JSON.parse(request.responseText || '{}'); } catch (error) { result = {}; }
      if (request.status === 403) unlock();
      if (request.status >= 200 && request.status < 300) resolve(result);
      else reject(new Error(result.error || `The server answered HTTP ${request.status}.`));
    };
    request.onerror = () => reject(new Error('The upload failed. Is the server still reachable?'));
    request.send(file);
  });
}

// --- toasts and confirmations --------------------------------------------------------------

function toast(text, kind, sticky) {
  const item = h('div', { class: `toast ${kind || ''}`, text, role: kind === 'error' ? 'alert' : 'status' });
  $('toasts').append(item);
  const close = () => { item.classList.add('out'); setTimeout(() => item.remove(), 260); };
  if (kind === 'error') item.addEventListener('click', close);
  if (!sticky) setTimeout(close, kind === 'error' ? 9000 : 3200);
  item.close = close;
  item.say = (next) => { item.textContent = next; };
  return item;
}

function ask(title, body, ok, danger) {
  return new Promise((resolve) => {
    const dialog = $('ask');
    $('ask-title').textContent = title;
    $('ask-body').textContent = body || '';
    $('ask-body').hidden = !body;
    $('ask-ok').textContent = ok || 'OK';
    $('ask-ok').className = `btn ${danger ? 'danger-solid' : 'primary'}`;
    dialog.returnValue = '';
    dialog.onclose = () => resolve(dialog.returnValue === 'ok');
    dialog.showModal();
    $('ask-ok').focus();
  });
}

// Runs a change with a toast, then refreshes.
async function act(work, message, done) {
  if (busy) return null;
  busy = true;
  const note = toast(message, 'busy', true);
  try {
    const result = await work(note);
    note.close();
    toast(done || 'Done', 'good');
    return result;
  } catch (error) {
    note.close();
    toast(error.message, 'error');
    return null;
  } finally {
    busy = false;
    await loadPlaces();
  }
}

// Runs one change per item, one after another -> how many worked.
async function actEach(items, work, message, done) {
  if (busy || !items.length) return 0;
  busy = true;
  const note = toast(message(0, items.length), 'busy', true);
  let worked = 0;
  const failed = [];
  try {
    for (let i = 0; i < items.length; i++) {
      note.say(message(i + 1, items.length));
      try { await work(items[i]); worked++; } catch (error) { failed.push(error.message); }
    }
  } finally {
    note.close();
    busy = false;
  }
  if (failed.length) toast(`${failed.length} of ${items.length} failed: ${failed[0]}`, 'error');
  else toast(done(worked), 'good');
  await loadPlaces();
  return worked;
}

// --- loading -----------------------------------------------------------------------------

async function loadPlaces() {
  try {
    const response = await fetch('/api/places', { headers: authHeaders(), cache: 'no-store' });
    const result = await response.json();
    data.places = result.places || [];
    data.runner = result.runner || { running: false };
    data.engines = result.engines || [];
    data.placesError = null;
  } catch (error) {
    data.placesError = "Can't reach the web server.";
  }
  renderNav();
  redraw('places');
}

async function load(key, url, pick) {
  try {
    data[key] = pick(await getJson(url));
    data[`${key}Error`] = null;
  } catch (error) {
    data[`${key}Error`] = error.message;
  }
  renderNav();
  redraw(key);
}
const loadOverview = () => load('overview', '/api/manage/overview', (result) => result);
const loadMissing = () => load('missing', '/api/assets/missing', (result) => result.assets || []);
const loadSearch = () => load('search', '/api/manage/asset-search', (result) => result);
const loadReports = () => load('reports', '/api/reports', (result) => result.reports || []);
const loadAccounts = () => load('accounts', '/api/studio/accounts', (result) => result.accounts || []);
async function loadServer() {
  try {
    const response = await fetch('/api/server/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data.serverInfo = await response.json();
    data.serverInfoError = null;
  } catch (error) {
    data.serverInfoError = `Couldn't read the server's state: ${error.message}`;
  }
  renderNav();
  redraw('serverInfo');
}

// The open view draws again with the new data (it decides what changed).
function redraw(what) {
  const current = views[view];
  if (current && current.render) current.render(what);
}

// --- sidebar --------------------------------------------------------------------------------

function renderNav() {
  const open = (list) => list.filter((item) => !item.replaced).length;
  $('nav-games').textContent = data.places.length || '';
  $('nav-reports').textContent = data.reports.filter((report) => report.status === 'open').length || '';
  const review = data.search ? Object.values(data.search.assets).reduce((sum, entry) => sum + entry.found.filter((item) => item.status === 'pending').length, 0) : 0;
  const missing = open(data.missing);
  $('nav-assets').textContent = review ? `${review} new` : missing || '';
  $('nav-assets').classList.toggle('hot', review > 0);
  const dot = $('nav-server');
  const info = data.serverInfo;
  const waiting = info && info.staged.some((item) => !item.failed);
  const failed = info && info.staged.some((item) => item.failed);
  dot.className = `dot ${!data.runner.running || failed ? 'bad' : waiting ? 'warn' : 'good'}`;
  dot.title = !data.runner.running ? 'Not running' : failed ? 'An update failed' : waiting ? 'Update ready' : 'Running';
  const problems = data.overview ? data.overview.problems.length : 0;
  $('nav-dash').className = `dot ${problems ? 'bad' : ''}`;
  $('nav-dash').title = problems ? plural(problems, 'problem') : '';
}

// --- router -----------------------------------------------------------------------------------

// #dashboard, #games, #games/<id>[/<tab>], #assets[/<tab>], #reports, #players[/<name>], #news, #server
const ALIASES = { announcements: 'news', accounts: 'players' };   // older links
async function route() {
  const [asked, ...args] = location.hash.replace(/^#/, '').split('/').map(decodeURIComponent);
  const name = ALIASES[asked] || asked;
  let next = views[name] ? name : 'dashboard';
  if (next === 'games' && args[0]) next = 'game';
  const leaving = views[view];
  if (leaving && leaving.leave && !await leaving.leave(next, args)) return;
  const changed = next !== view;
  view = next;
  viewArgs = args;
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.dataset.view !== view;
  const navName = view === 'game' ? 'games' : view;
  for (const item of document.querySelectorAll('.nav a')) {
    item.classList.toggle('active', item.dataset.nav === navName);
    // Phones: the nav is a row that scrolls sideways.
    const side = item.closest('.side');
    if (item.dataset.nav === navName && side && side.scrollWidth > side.clientWidth) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  if (changed) window.scrollTo(0, 0);
  views[view].show(args, changed);
}

// --- lock ---------------------------------------------------------------------------------------

let unlocked = false;
let started = false;

function lock(message) {
  unlocked = false;
  document.body.classList.add('locked');
  $('key-state').textContent = message || '';
  if (!message) $('host-key').focus();
}

async function unlock() {
  if (!storedKey() && !storedToken()) return lock('');
  let response;
  try {
    response = await fetch('/api/manage/whoami', { headers: authHeaders(), cache: 'no-store' });
  } catch (error) {
    return lock("Can't reach the web server.");
  }
  if (!response.ok) {
    const hadToken = Boolean(storedToken());
    store('manageToken', '');
    if (storedKey()) return lock("That key wasn't accepted.");
    return lock(hadToken ? 'That link has expired. Open Manage games from the launcher again.' : '');
  }
  const who = await response.json().catch(() => ({}));
  unlocked = true;
  document.body.classList.remove('locked');
  $('who').textContent = who.via === 'account' ? who.name : 'Host key';
  if (started) return loadPlaces();
  started = true;
  await loadPlaces();
  route();
  loadOverview();
  loadServer();
  loadMissing();
  loadSearch();
  loadReports();
  loadAccounts();
  setInterval(() => {
    if (busy || !unlocked || document.hidden) return;
    loadPlaces();
    for (const item of Object.values(views)) if (item.tick) item.tick(view);
  }, 5000);
  setInterval(() => {
    if (busy || !unlocked || document.hidden) return;
    loadOverview();
    loadServer();
    loadReports();
    loadMissing();
    loadSearch();
    if (view === 'players') loadAccounts();
  }, 15000);
  return undefined;
}

function boot() {
  $('brand-host').textContent = location.host;
  $('lock-host').textContent = location.host;
  $('host-key').value = storedKey();
  $('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    store('hostKey', $('host-key').value.trim());
    unlock();
  });
  $('key-forget').addEventListener('click', () => {
    store('hostKey', '');
    store('manageToken', '');
    $('host-key').value = '';
    lock('');
  });
  window.addEventListener('hashchange', () => {
    if (takeTokenFromAddress()) unlock();
    else if (unlocked) route();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!views.game || !views.game.dirty || !views.game.dirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // "/" jumps to the open view's search box.
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
    const box = document.querySelector(`main > section[data-view="${view}"] input[type=search]`);
    if (!box) return;
    event.preventDefault();
    box.focus();
    box.select();
  });
  // A file dropped where nothing takes it would open in the tab and lose the page.
  const fileInput = (target) => target instanceof Element && target.matches('input[type=file]');
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event) || event.defaultPrevented || fileInput(event.target)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  });
  document.addEventListener('drop', (event) => {
    if (hasFiles(event) && !event.defaultPrevented && !fileInput(event.target)) event.preventDefault();
  });
  unlock();
}
const hasFiles = (event) => Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes('Files');

document.addEventListener('DOMContentLoaded', boot);
