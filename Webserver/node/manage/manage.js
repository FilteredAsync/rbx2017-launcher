'use strict';

// Server management page (/manage). The API is in lib/routes.js, lib/studio.js
// and lib/admin.js. Nothing shows until the server accepts the host key or a
// manage token: the launcher's Manage games button opens /manage#token=...

const $ = (id) => document.getElementById(id);
const JOIN_CODE_NAME = 'Server management'; // the "n" of join codes, unchanged from the old page
const VIEWS = ['games', 'reports', 'announcements', 'accounts', 'assets', 'server', 'join'];

let places = [];
let runner = { running: false };
let serverInfo = null;
let missing = [];
let busy = false;            // a change is being sent; polling waits
let view = 'games';
let openId = null;           // the game in the drawer
let drawerTab = 'servers';
let pendingPlace = null;     // which game the hidden file inputs are for
let restoreResult = null;    // the last "Fix zeroed numbers" answer, shown on that game's File tab
let pendingAsset = null;
let assetFilter = 'Audio';
let logName = 'server';
let reportList = [];
let reportFilter = 'open';
let reportsShown = '';       // what the report list shows, so polling leaves it alone
const openChats = new Set(); // reports whose chat is unfolded

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
const btn = (text, className, onclick, extra) => h('button', Object.assign({ type: 'button', class: `btn ${className || ''}`.trim(), text, onclick }, extra || {}));
const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || `${word}s`)}`;

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
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    await refresh();
  }
}

// --- views ----------------------------------------------------------------------------------

function route() {
  const [name, arg] = location.hash.replace(/^#/, '').split('/');
  view = VIEWS.includes(name) ? name : 'games';
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.dataset.view !== view;
  for (const link of document.querySelectorAll('.nav a')) link.classList.toggle('active', link.dataset.nav === view);
  if (view === 'games' && arg) showDrawer(arg);
  else hideDrawer();
  if (view === 'reports') loadReports();
  if (view === 'accounts') loadAccounts();
  if (view === 'assets') loadMissing();
  if (view === 'announcements') loadNews();
  if (view === 'server') { loadServer(); if (!$('srv-log').textContent) loadLog(); }
}

// --- games ----------------------------------------------------------------------------------

function gameState(place) {
  const servers = place.servers || [];
  const live = servers.filter((server) => server.state === 'running');
  if (!place.enabled) return servers.length ? { kind: 'busy', text: 'Turning off' } : { kind: 'off', text: 'Offline' };
  if (!runner.running) return { kind: 'busy', text: 'Waiting', title: 'The always-on server is not running.' };
  if (live.length) return { kind: 'live', text: 'Live' };
  const broken = servers.find((server) => server.state === 'error');
  if (broken) return { kind: 'error', text: 'Error', title: broken.lastError || '' };
  if (servers.some((server) => server.state === 'restarting')) return { kind: 'busy', text: 'Restarting' };
  if (servers.length || place.keepRunning) return { kind: 'busy', text: 'Starting' };
  return { kind: 'ready', text: 'Ready', title: 'Online. A server starts when someone joins.' };
}
const playersIn = (place) => (place.servers || []).reduce((sum, server) => sum + (Array.isArray(server.players) ? server.players.length : 0), 0);

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

function gameRow(place) {
  const state = gameState(place);
  const players = playersIn(place);
  const servers = (place.servers || []).filter((server) => server.state === 'running').length;
  const creator = place.creator ? place.creator.name : null;
  return h('tr', {
    class: `${place.enabled ? '' : 'off'} ${openId === place.placeId ? 'selected' : ''}`.trim(),
    dataset: { id: place.placeId },
    onclick: () => { location.hash = `games/${place.placeId}`; },
  },
  h('td', {}, h('div', { class: 'game-cell' }, thumb(place),
    h('div', {}, h('div', { class: 'game-name', text: place.name }), h('div', { class: 'sub' }, h('span', { class: 'mono', text: place.placeId }), creator && h('span', { text: creator }))))),
  h('td', {}, h('span', { class: `state ${state.kind}`, text: state.text, title: state.title || null })),
  h('td', { class: 'num hide-sm', text: servers ? String(players) : '–' }),
  h('td', { class: 'num hide-sm', text: servers ? String(servers) : '–' }),
  h('td', { class: 'hide-sm', text: place.avatarType === 'R15' ? 'R15' : 'R6' }),
  h('td', { class: 'right' }, onlineSwitch(place)));
}

function renderGames() {
  const filter = $('games-filter').value.trim().toLowerCase();
  const shown = places.filter((place) => !filter || place.name.toLowerCase().includes(filter) || place.placeId.includes(filter));
  const rows = $('games-rows');
  // Rows only change when their game did, so focus and hover survive polling.
  const wanted = shown.map((place) => {
    const signature = JSON.stringify([place, runner.running, openId === place.placeId]);
    const old = rows.querySelector(`tr[data-id="${place.placeId}"]`);
    if (old && old.dataset.sig === signature && !old.contains(document.activeElement)) return old;
    if (old && old.contains(document.activeElement)) return old;
    const row = gameRow(place);
    row.dataset.sig = signature;
    return row;
  });
  if (wanted.length === 0) {
    rows.replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colSpan: 6, text: places.length ? 'No game matches.' : 'No games yet.' })));
  } else {
    rows.replaceChildren(...wanted);
  }
  const live = places.reduce((sum, place) => sum + (place.servers || []).filter((server) => server.state === 'running').length, 0);
  const players = places.reduce((sum, place) => sum + playersIn(place), 0);
  $('games-sub').textContent = places.length
    ? `${plural(places.filter((place) => place.enabled).length, 'game')} online, ${plural(live, 'server')} running, ${plural(players, 'player')}`
    : '';
  $('nav-games').textContent = places.length || '';
  const banner = $('runner-banner');
  banner.replaceChildren();
  if (!runner.running) banner.append("The always-on server isn't running, so games can't start. Run startServer.bat on the server PC.");
  for (const problem of runner.problems || []) banner.append(h('div', { text: problem }));
  banner.hidden = runner.running && !(runner.problems || []).length;
}
$('games-filter').addEventListener('input', renderGames);

// --- one game ---------------------------------------------------------------------------------

function showDrawer(id) {
  const switched = openId !== id;
  openId = id;
  if (switched) drawerTab = 'servers';
  renderDrawer(switched);
  renderGames();
}
function hideDrawer() {
  if (openId === null) return;
  openId = null;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').hidden = true;
  renderGames();
}
function closeDrawer() { if (openId !== null) location.hash = 'games'; }
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openId !== null && !document.querySelector('dialog[open]')) closeDrawer();
});
for (const tab of document.querySelectorAll('#drawer-tabs button')) {
  tab.addEventListener('click', () => { drawerTab = tab.dataset.tab; renderDrawer(false); });
}

// full: also rebuild the settings form (otherwise typing there is left alone).
function renderDrawer(full) {
  const place = places.find((item) => item.placeId === openId);
  const drawer = $('drawer');
  if (!place) {
    if (places.length && openId !== null) closeDrawer();
    return;
  }
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('scrim').hidden = false;

  const state = gameState(place);
  const meta = h('div', { class: 'meta' }, h('span', { text: `Place ${place.placeId}` }), h('span', { text: `Version ${place.version}` }),
    place.creator && h('span', { text: `By ${place.creator.name}` }));
  $('drawer-head').replaceChildren(
    h('button', { type: 'button', class: 'thumb-edit', title: 'Change the icon', onclick: () => pick('thumb-file', place) }, thumb(place, true)),
    h('div', { class: 'head-text' }, h('h2', { text: place.name }), meta,
      h('div', { class: 'online' },
        h('label', { class: 'inline check' }, onlineSwitch(place), h('span', { text: place.enabled ? 'Online' : 'Offline' })),
        state.kind !== 'off' && h('span', { class: `state ${state.kind}`, text: state.text, title: state.title || null }))),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: closeDrawer }));

  for (const tab of document.querySelectorAll('#drawer-tabs button')) {
    tab.classList.toggle('active', tab.dataset.tab === drawerTab);
    tab.setAttribute('aria-selected', String(tab.dataset.tab === drawerTab));
  }
  for (const pane of document.querySelectorAll('.drawer .pane')) pane.hidden = pane.dataset.pane !== drawerTab;
  $('pane-servers').replaceChildren(...serversPane(place));
  $('pane-files').replaceChildren(...filePane(place));
  if (drawerTab === 'files' && versionsKey !== `${place.placeId}:${place.version}`) loadVersions(place);
  if (full || !$('pane-settings').firstChild || $('pane-settings').dataset.id !== place.placeId) {
    $('pane-settings').replaceChildren(settingsForm(place));
    $('pane-settings').dataset.id = place.placeId;
  }
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
      : !runner.running ? 'Waiting for the always-on server.'
        : place.keepRunning ? 'Starting one.' : 'None running. One starts when someone joins.';
    parts.push(h('p', { class: 'empty', text }));
  }
  for (const server of servers) {
    const players = Array.isArray(server.players) ? server.players : null;
    const short = server.jobId.slice(0, 6);
    const base = `/api/places/${place.placeId}/servers/${server.jobId}`;
    const running = server.state === 'running';
    const card = h('div', { class: 'card srv' },
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
        ? h('div', { class: 'chips' }, players.map((name) => h('span', { class: 'chip', text: name })))
        : h('div', { class: 'muted', text: players ? `Empty${server.idleSince ? ` for ${duration(Date.now() - Date.parse(server.idleSince))}` : ''}` : 'Busy' })),
      running && h('div', { class: 'srv-foot' },
        h('span', { text: `${players ? players.length : '?'} / ${server.maxPlayers || place.maxPlayers} players` }),
        server.memoryMB && h('span', { text: `${server.memoryMB} MB` }),
        server.startedAt && h('span', { text: `Up ${duration(Date.now() - Date.parse(server.startedAt))}` })));
    parts.push(card);
  }

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

function settingsForm(place) {
  const id = place.placeId;
  const ownedHere = Boolean(place.creator && place.creator.source === 'owner');
  const input = (props) => h('input', props);
  const name = input({ value: place.name, maxLength: 60, required: true });
  const description = h('textarea', { value: place.description || '', maxLength: 1000, rows: 3 });
  const maxPlayers = input({ type: 'number', min: 1, max: 50, value: String(place.maxPlayers) });
  const avatar = h('select', {}, h('option', { value: 'R6', text: 'R6' }), h('option', { value: 'R15', text: 'R15' }));
  avatar.value = place.avatarType === 'R15' ? 'R15' : 'R6';
  const keepRunning = input({ type: 'checkbox', class: 'switch', checked: place.keepRunning });
  const teamCreate = input({ type: 'checkbox', class: 'switch', checked: place.teamCreate });
  const universe = input({ value: place.universeId || '', inputmode: 'numeric', placeholder: 'None' });
  const creator = input({
    maxLength: 60, disabled: ownedHere,
    value: place.creator && !ownedHere ? place.creator.name : '',
    placeholder: ownedHere ? `${place.creator.name} (Studio owner)` : 'From the universe, or type a name',
  });
  const owner = input({ value: place.owner ? place.owner.name : '', placeholder: 'Admins only' });
  const editors = input({ value: place.editors.map((editor) => editor.name).join(', '), placeholder: 'Names, separated by commas' });
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { text: label }), control, hint && h('small', { text: hint }));
  const toggle = (title, hint, control) => h('label', { class: 'switch-row' }, h('div', {}, h('b', { text: title }), h('small', { text: hint })), control);

  const save = h('button', { type: 'submit', class: 'btn primary', text: 'Save' });
  const form = h('form', { class: 'settings', autocomplete: 'off' },
    field('Name', name),
    field('Description', description),
    h('div', { class: 'pair' }, field('Players per server', maxPlayers), field('Avatars', avatar, 'Used by servers started after saving.')),
    h('div', { class: 'switches' },
      toggle('Keep a server running', 'Otherwise one starts on join and stops when empty.', keepRunning),
      toggle('Team Create', 'The owner and editors build it together in Studio.', teamCreate)),
    h('h3', { text: 'Studio access' }),
    h('div', { class: 'pair' }, field('Owner', owner), field('Editors', editors)),
    h('h3', { text: 'Credit' }),
    h('div', { class: 'pair' }, field('Roblox universe ID', universe, 'For its icon and creator.'), field('Creator', creator)),
    h('div', { class: 'save-bar' }, save, btn('Reset', '', () => $('pane-settings').replaceChildren(settingsForm(place)))));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      const fields = {
        name: name.value, description: description.value, universeId: universe.value.trim(), teamCreate: teamCreate.checked,
        keepRunning: keepRunning.checked, maxPlayers: Number(maxPlayers.value) || undefined, avatarType: avatar.value,
      };
      if (!ownedHere) fields.creator = creator.value.trim();
      await change('POST', `/api/places/${id}`, JSON.stringify(fields));
      const names = editors.value.split(',').map((item) => item.trim()).filter(Boolean);
      await change('POST', `/api/places/${id}/access`, JSON.stringify({ owner: owner.value.trim(), editors: names }));
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
      btn('Convert again', '', async () => {
        if (!await ask(`Convert ${place.name} again?`, 'It picks up converter fixes made since the upload. Running servers restart on the new version, and the old file is kept.', 'Convert')) return;
        act(() => change('POST', `/api/places/${place.placeId}/reconvert`, '{}'), `Converting ${place.name}`, 'Converted');
      }),
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
      if (done) closeDrawer();
    })));
  // versionsList is null when there are no earlier versions (replaceChildren would print it).
  return parts.filter(Boolean);
}

function pick(inputId, place) {
  pendingPlace = place;
  $(inputId).value = '';
  $(inputId).click();
}

// --- replacing a game's file (Files tab) ----------------------------------------------------
// Picked or dropped file -> "ready" (asks in place) -> "upload" -> "convert" ->
// "done" or "error". Kept here, not in the page, so polling can redraw the pane.
let replacing = null;        // { placeId, phase, file, percent, convertStarted, result, error }
let versions = { placeId: null, version: null, list: null }; // the open game's earlier files, as of its version
let versionsKey = '';        // "<placeId>:<version>" last asked for
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
  const place = places.find((item) => item.placeId === openId);
  const card = $('replace-card');
  if (place && card) card.replaceWith(replaceCard(place));
}

async function startReplace() {
  const job = replacing;
  if (!job || !job.file || busy) return;
  const place = places.find((item) => item.placeId === job.placeId);
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
    if (openId !== job.placeId || drawerTab !== 'files') toast(`${place.name} updated`, 'good');
  } catch (error) {
    Object.assign(job, { phase: 'error', error: error.message });
    if (openId !== job.placeId || drawerTab !== 'files') toast(`${place.name}: ${error.message}`, 'error');
  } finally {
    busy = false;
    await refresh();
  }
}

// The replace card at the top of the Files tab.
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
      head(ext, file.name, `${size(file.size)} · now ${size(place.fileSize)}, version ${place.version}`),
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
    // Undo puts back the newest earlier file: only once that list is the one after this upload.
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
  return `Converting${seconds >= 2 ? ` · ${seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`}` : ''}`;
}
setInterval(() => {
  if (replacing && replacing.phase === 'convert' && $('replace-step')) $('replace-step').textContent = replaceStep(replacing);
}, 1000);

// The Choose buttons (error card) use the hidden input.
$('replace-file').addEventListener('change', () => {
  if (pendingPlace) chooseReplacement(pendingPlace, $('replace-file').files[0]);
});

// Drop a file anywhere on the Files tab.
const filesPane = $('pane-files');
const hasFiles = (event) => Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes('Files');
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
  const place = places.find((item) => item.placeId === openId);
  if (place) chooseReplacement(place, event.dataTransfer.files[0]);
});

// --- earlier versions of a game's file ----------------------------------------------------------

// Fetched when the Files tab shows a game, and again whenever its version changes.
async function loadVersions(place) {
  const key = `${place.placeId}:${place.version}`;
  if (versionsKey === key) return;
  versionsKey = key;
  let list = [];
  try {
    const response = await fetch(`/api/places/${place.placeId}/versions`, { headers: authHeaders(), cache: 'no-store' });
    const result = await response.json();
    if (response.ok) list = result.versions || [];
  } catch (error) { /* shown as no earlier versions */ }
  if (versionsKey !== key) return; // another game or version since
  versions = { placeId: place.placeId, version: place.version, list };
  if (openId === place.placeId && drawerTab === 'files') renderDrawer(false);
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
  renderDrawer(false);
}

$('restore-file').addEventListener('change', async () => {
  const file = $('restore-file').files[0];
  const place = pendingPlace;
  if (!file || !place) return;
  if (!await ask(`Fix zeroed numbers in ${place.name}?`, `IntValues that are 0 get their numbers from ${file.name}. Nothing else changes. Running servers restart, and the old version is kept.`, 'Fix')) return;
  act(async (note) => {
    const result = await uploadFile(`/api/places/${place.placeId}/restore-values?name=${encodeURIComponent(file.name)}`, file,
      (percent) => note.say(percent < 100 ? `Uploading ${percent}%` : 'Comparing'));
    // Objects with no counterpart first: those are worth a look.
    const missingFirst = (entry) => (entry.reason === 'no counterpart' ? 0 : 1);
    restoreResult = { placeId: place.placeId, file: file.name, restored: result.restored, stillZero: result.stillZero.sort((a, b) => missingFirst(a) - missingFirst(b)) };
  }, `Uploading ${file.name}`, 'Done');
});

// What "Fix zeroed numbers" did; the objects still at 0 fold out.
function restoreCard(result) {
  const shown = result.stillZero.slice(0, 1000).map((entry) => `${entry.path}  (${entry.reason})`);
  if (result.stillZero.length > shown.length) shown.push(`... and ${result.stillZero.length - shown.length} more`);
  return h('div', { class: 'card restore-result' },
    h('b', { text: result.restored.length ? `Restored ${plural(result.restored.length, 'value')} from ${result.file}` : `Nothing to fix from ${result.file}` }),
    result.stillZero.length ? h('details', { class: 'notes', open: result.open, ontoggle: (event) => { result.open = event.target.open; } },
      h('summary', { text: `Still 0 (${result.stillZero.length})` }), h('pre', { text: shown.join('\n') })) : null);
}

$('thumb-file').addEventListener('change', () => {
  const file = $('thumb-file').files[0];
  const place = pendingPlace;
  if (!file || !place) return;
  if (file.size > 4 * 1024 * 1024) { toast('Icons can be up to 4 MB.', 'error'); return; }
  act(() => change('POST', `/api/thumbnails/${place.placeId}`, file, 'application/octet-stream'), 'Uploading the icon', 'Icon changed');
});

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
$('upload-open').addEventListener('click', openUpload);
$('upload-close').addEventListener('click', closeUpload);
$('upload-cancel').addEventListener('click', closeUpload);
$('upload').addEventListener('cancel', (event) => { if ($('upload-button').disabled) event.preventDefault(); });
$('upload-open-game').addEventListener('click', () => { $('upload').close(); if (uploadedId) location.hash = `games/${uploadedId}`; });

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
    refresh();
  }
});

// --- polling ---------------------------------------------------------------------------------

async function refresh() {
  try {
    const response = await fetch('/api/places', { headers: authHeaders(), cache: 'no-store' });
    const data = await response.json();
    places = data.places || [];
    runner = data.runner || { running: false };
    if (!$('join-server').value && data.server && data.server.tailscaleUrl) $('join-server').value = data.server.tailscaleUrl;
    renderGames();
    if (openId !== null) renderDrawer(false);
    renderServerDot();
  } catch (error) {
    $('games-sub').textContent = "Can't reach the web server.";
  }
}

// --- reports --------------------------------------------------------------------------------

async function loadReports() {
  try {
    const response = await fetch('/api/reports', { headers: authHeaders(), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    reportList = result.reports || [];
    renderReports();
  } catch (error) {
    reportsShown = '';
    $('report-list').replaceChildren(h('p', { class: 'empty', text: error.message }));
  }
}

const reportMatches = (report, filter) => !filter || report.status === filter;

function reportCard(report) {
  const open = report.status === 'open';
  const who = report.reportedId === null || report.reportedId === undefined ? 'The game' : (report.reportedName || `User ${report.reportedId}`);
  const game = report.gameName || (report.placeId ? `Place ${report.placeId}` : null);
  const messages = report.messages || [];
  return h('div', { class: `card report-item${open ? '' : ' resolved'}` },
    h('div', { class: 'body' },
      h('div', { class: 'head' }, h('span', { class: 'who', text: who }), report.reason ? h('span', { class: 'reason', text: report.reason }) : null),
      report.text ? h('div', { class: 'text', text: report.text }) : null,
      h('div', { class: 'meta' },
        h('span', { text: report.reporterName ? `Reported by ${report.reporterName}` : 'Reporter unknown' }),
        game ? h('span', { text: game, title: report.jobId ? `Server ${report.jobId}` : null }) : null,
        report.source === 'launcher' ? h('span', { text: 'From the launcher' }) : null,
        h('span', { text: when(report.at) }),
        open ? null : h('span', { text: `Resolved${report.resolvedBy ? ` by ${report.resolvedBy}` : ''}` })),
      messages.length ? h('details', {
        class: 'notes', open: openChats.has(report.id),
        ontoggle: (event) => { if (event.target.open) openChats.add(report.id); else openChats.delete(report.id); },
      }, h('summary', { text: `Chat (${messages.length})` }), h('pre', { text: messages.join('\n') })) : null),
    h('div', { class: 'actions' },
      open ? btn('Resolve', 'small', () => act(async () => {
        await change('POST', `/api/reports/${report.id}/resolve`, '{}');
        await loadReports();
      }, 'Resolving', 'Resolved')) : null,
      btn('Delete', 'small danger', async () => {
        if (!await ask('Delete this report?', '', 'Delete', true)) return;
        act(async () => {
          await change('DELETE', `/api/reports/${report.id}`);
          await loadReports();
        }, 'Deleting', 'Deleted');
      })));
}

function renderReports() {
  $('nav-reports').textContent = reportList.filter((report) => report.status === 'open').length || '';
  for (const button of document.querySelectorAll('#reports-filter button')) {
    button.classList.toggle('active', button.dataset.filter === reportFilter);
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = reportList.filter((report) => reportMatches(report, button.dataset.filter)).length || '';
  }
  // Rebuilt only when something changed, so an open chat or a focused button survives polling.
  const signature = JSON.stringify([reportList, reportFilter]);
  if (signature === reportsShown) return;
  reportsShown = signature;
  const shown = reportList.filter((report) => reportMatches(report, reportFilter));
  if (!shown.length) {
    $('report-list').replaceChildren(h('p', { class: 'empty', text: reportFilter === 'open' ? 'No open reports.' : 'No reports here.' }));
    return;
  }
  $('report-list').replaceChildren(...shown.map(reportCard));
}

for (const button of document.querySelectorAll('#reports-filter button')) {
  button.addEventListener('click', () => { reportFilter = button.dataset.filter; renderReports(); });
}

// --- announcements --------------------------------------------------------------------------

async function loadNews() {
  try {
    const response = await fetch('/api/announcements', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderNews(result.announcements || []);
  } catch (error) {
    $('news-list').replaceChildren(h('p', { class: 'empty', text: error.message }));
  }
}

function renderNews(list) {
  $('nav-news').textContent = list.length || '';
  if (!list.length) {
    $('news-list').replaceChildren(h('p', { class: 'empty', text: 'Nothing posted right now.' }));
    return;
  }
  $('news-list').replaceChildren(...list.map((item) => h('div', { class: `card news-item${item.level === 'important' ? ' important' : ''}` },
    h('div', { class: 'body' },
      item.title && h('div', { class: 'head', text: item.title }),
      h('div', { class: 'text', text: item.text }),
      h('div', { class: 'meta' }, h('span', { text: `Posted ${when(item.postedAt)}` }),
        h('span', { text: item.expiresAt ? `Until ${when(item.expiresAt)}` : 'Until removed' }),
        item.level === 'important' && h('span', { class: 'pop', text: 'Pops up' }))),
    btn('Remove', 'small', async () => {
      if (!await ask('Remove this announcement?', 'It disappears from every launcher.', 'Remove', true)) return;
      try {
        await change('DELETE', `/api/announcements/${encodeURIComponent(item.id)}`);
        toast('Removed', 'good');
      } catch (error) {
        toast(error.message, 'error');
      }
      loadNews();
    }))));
}

$('news-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await change('POST', '/api/announcements', JSON.stringify({
      title: $('news-title').value,
      text: $('news-text').value,
      level: $('news-important').checked ? 'important' : 'info',
      expiresHours: Number($('news-expires').value),
    }));
    $('news-title').value = '';
    $('news-text').value = '';
    $('news-important').checked = false;
    toast('Posted. Launchers pick it up within a few minutes.', 'good');
    loadNews();
  } catch (error) {
    toast(error.message, 'error');
  }
});

// --- Studio accounts ---------------------------------------------------------------------------

async function loadAccounts() {
  try {
    const response = await fetch('/api/studio/accounts', { headers: authHeaders(), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderAccounts(result.accounts || []);
  } catch (error) {
    $('account-rows').replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colSpan: 5, text: error.message })));
  }
}

function renderAccounts(list) {
  if (!list.length) {
    $('account-rows').replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colSpan: 5, text: 'Nobody has logged in to Studio yet.' })));
    return;
  }
  $('account-rows').replaceChildren(...list.map((account) => h('tr', {},
    h('td', {}, h('b', { text: account.name })),
    h('td', { class: 'num sub hide-sm', text: account.userId }),
    h('td', { class: 'sub', text: account.lastLoginAt ? when(account.lastLoginAt) : 'Never' }),
    h('td', {}, h('input', {
      type: 'checkbox', class: 'switch', checked: account.admin, 'aria-label': `${account.name} is an admin`,
      onchange: (event) => {
        const on = event.target.checked;
        act(async () => {
          await change('POST', `/api/studio/accounts/${encodeURIComponent(account.name)}`, JSON.stringify({ admin: on }));
          await loadAccounts();
        }, on ? `Making ${account.name} an admin` : `Removing ${account.name} as admin`, on ? `${account.name} is an admin` : `${account.name} is no longer an admin`);
      },
    })),
    h('td', { class: 'actions' }, btn('Delete', 'small danger', async () => {
      if (!await ask(`Delete ${account.name}?`, 'They are logged out. The next login with this name makes a new account with a new password, and it gets the games this one owns, so only do this for its owner.', 'Delete', true)) return;
      act(async () => {
        await change('DELETE', `/api/studio/accounts/${encodeURIComponent(account.name)}`);
        await loadAccounts();
      }, `Deleting ${account.name}`, `${account.name} deleted`);
    })))));
}

// --- missing assets ---------------------------------------------------------------------------

const KNOWN_TYPES = ['Audio', 'Image', 'Animation'];
async function loadMissing() {
  try {
    const response = await fetch('/api/assets/missing', { headers: authHeaders(), cache: 'no-store' });
    missing = (await response.json()).assets || [];
    renderMissing();
  } catch (error) {
    $('asset-rows').replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colSpan: 6, text: "Couldn't load the list." })));
  }
}

function renderMissing() {
  const matches = (asset, filter) => !filter || (filter === 'other' ? !KNOWN_TYPES.includes(asset.type) : asset.type === filter);
  const open = missing.filter((asset) => !asset.replaced);
  $('nav-assets').textContent = open.length || '';
  for (const button of document.querySelectorAll('#assets-filter button')) {
    const count = open.filter((asset) => matches(asset, button.dataset.filter)).length;
    button.classList.toggle('active', button.dataset.filter === assetFilter);
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = count || '';
  }
  const shown = missing.filter((asset) => matches(asset, assetFilter));
  if (!shown.length) {
    $('asset-rows').replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colSpan: 6, text: 'Nothing missing here.' })));
    return;
  }
  // Games that asked for it, newest first ("Unknown" last), e.g. "Lumber Tycoon 2, Obby +2".
  const usedBy = (asset) => {
    const uses = (asset.usedBy || []).slice().sort((a, b) => (a.placeId === 'unknown') - (b.placeId === 'unknown'));
    const names = [...new Set(uses.map((use) => (use.placeId === 'avatar' ? 'Avatars' : use.placeId === 'unknown' ? 'Unknown' : use.name || `Place ${use.placeId}`)))];
    if (!names.length) return h('td', { class: 'sub hide-sm', text: '–' });
    const text = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    return h('td', { class: 'sub hide-sm', text, title: names.length > 3 ? names.join(', ') : null });
  };
  $('asset-rows').replaceChildren(...shown.map((asset) => h('tr', {},
    h('td', {}, h('div', { class: 'game-name', text: asset.name || 'Unknown' }), asset.creator && h('div', { class: 'sub', text: asset.creator })),
    h('td', { class: 'hide-sm', text: asset.type || '…' }),
    usedBy(asset),
    h('td', { class: 'num sub mono hide-sm', text: asset.id }),
    h('td', { class: 'sub hide-sm', text: asset.reason }),
    h('td', { class: 'actions' }, asset.replaced
      ? [h('span', { class: 'replaced', text: 'Replaced', title: asset.replacement }), btn('Undo', 'small', () => act(async () => {
        await change('DELETE', `/api/assets/${asset.id}/replacement`);
        await loadMissing();
      }, 'Removing the replacement', 'Replacement removed'))]
      : btn('Replace', 'small', () => { pendingAsset = asset; $('missing-file').value = ''; $('missing-file').click(); })))));
}

for (const button of document.querySelectorAll('#assets-filter button')) {
  button.addEventListener('click', () => { assetFilter = button.dataset.filter; renderMissing(); });
}
$('missing-file').addEventListener('change', () => {
  const file = $('missing-file').files[0];
  const asset = pendingAsset;
  if (!file || !asset) return;
  if (file.size > 20 * 1024 * 1024) { toast('Replacements can be up to 20 MB.', 'error'); return; }
  act(async () => {
    await uploadFile(`/api/assets/${asset.id}/replacement`, file);
    await loadMissing();
  }, `Uploading ${file.name}`, `${asset.name || asset.id} replaced`);
});

// --- server ------------------------------------------------------------------------------------

async function loadServer() {
  try {
    const response = await fetch('/api/server/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    serverInfo = await response.json();
    renderServer();
  } catch (error) {
    $('srv-sub').textContent = `Couldn't read the server's state: ${error.message}`;
  }
}

function renderServerDot() {
  const dot = $('nav-server');
  const waiting = serverInfo && serverInfo.staged.some((item) => !item.failed);
  const failed = serverInfo && serverInfo.staged.some((item) => item.failed);
  dot.className = `dot ${!runner.running || failed ? 'bad' : waiting ? 'warn' : 'good'}`;
  dot.title = !runner.running ? 'Not running' : failed ? 'An update failed' : waiting ? 'Update ready' : 'Running';
}

function renderServer() {
  const info = serverInfo;
  const installed = info.installed || {};
  const status = info.runner || {};
  const checks = status.updates || null;
  const live = places.reduce((sum, place) => sum + (place.servers || []).filter((server) => server.state === 'running').length, 0);
  $('srv-sub').textContent = status.running ? '' : "The always-on server isn't running. Updates and restarts wait for it.";

  const stat = (label, value, note, kind) => h('div', { class: 'card stat' },
    h('div', { class: 'label', text: label }), h('div', { class: `value ${kind || ''}`, text: value }), note && h('div', { class: 'note', text: note }));
  const last = info.lastResult;
  $('srv-stats').replaceChildren(
    stat('Status', status.running ? 'Running' : 'Stopped', runner.idleStopMinutes ? `Empty servers stop after ${runner.idleStopMinutes} min` : null, status.running ? 'good' : 'bad'),
    stat('Game servers', `${live}${runner.maxGames ? ` of ${runner.maxGames}` : ''}`, 'running now'),
    stat('Version', installed.publicLabel || 'Not recorded', installed.privateLabel ? `Private files ${installed.privateLabel}` : null),
    stat('Last update', last ? (last.ok ? 'Installed' : 'Failed') : 'None yet', last ? `${when(last.at)}${last.ok ? '' : `: ${last.error}`}` : null, last && !last.ok ? 'bad' : ''));

  const waiting = info.staged.filter((item) => !item.failed);
  const failed = info.staged.filter((item) => item.failed);
  const label = (item) => `${item.kind === 'private' ? 'Private files' : 'Server files'} ${item.label}`;
  const box = $('srv-updates');
  box.replaceChildren();
  if (waiting.length) {
    box.append(h('b', { text: `Ready to install: ${waiting.map(label).join(', ')}` }));
    if (!checks || checks.autoUpdate !== false) box.append(h('small', { text: 'Installs by itself once nobody has played for 3 minutes.' }));
    for (const item of waiting) if (item.notes) box.append(h('small', { text: item.notes }));
  } else if (checks && checks.checking) {
    box.append(h('b', { text: 'Checking for updates' }));
  } else if (checks && checks.lastError) {
    box.append(h('b', { class: 'bad', text: "Couldn't check for updates" }), h('small', { text: checks.lastError }));
  } else {
    box.append(h('b', { text: 'Up to date' }), h('small', { text: checks && checks.lastCheck ? `Checked ${when(checks.lastCheck)}` : 'Not checked yet' }));
  }
  for (const item of failed) {
    box.append(h('div', { class: 'bad', text: `${label(item)} didn't work: ${item.failed}` }),
      h('div', {}, btn('Discard it', 'small danger', async () => {
        try {
          await change('POST', `/api/server/update/discard?build=${item.build}`);
          loadServer();
        } catch (error) {
          toast(error.message, 'error');
        }
      })));
  }
  $('srv-install').hidden = waiting.length === 0;
  renderServerDot();
}

async function serverAction(url, message, done) {
  try {
    const note = toast(message, 'busy', true);
    await change('POST', url).finally(() => note.close());
    toast(done, 'good');
    setTimeout(loadServer, 4000);
    setTimeout(loadServer, 15000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

$('srv-check').addEventListener('click', () => serverAction('/api/server/update/check', 'Asking the server to check', 'Checking. The result shows here in a few seconds.'));
$('srv-install').addEventListener('click', async () => {
  if (!await ask('Install the update now?', 'Players are saved and get a message. The server is back in about a minute, and if the new version fails the old one comes back.', 'Install')) return;
  serverAction('/api/server/update/install', 'Asking the server to install', 'Installing. Reload this page in a minute.');
});
$('srv-restart').addEventListener('click', async () => {
  if (!await ask('Restart the whole server?', 'Players are saved and get a message. Everything is back in about a minute.', 'Restart', true)) return;
  serverAction('/api/server/restart', 'Asking the server to restart', 'Restarting. Reload this page in a minute.');
});
$('srv-upload-button').addEventListener('click', () => $('srv-upload').click());
$('srv-upload').addEventListener('change', async () => {
  const file = $('srv-upload').files[0];
  $('srv-upload').value = '';
  if (!file) return;
  const progress = $('srv-progress');
  const note = toast(`Uploading ${file.name}`, 'busy', true);
  try {
    progress.hidden = false;
    progress.value = 0;
    const result = await uploadFile('/api/server/update/upload', file, (percent) => { progress.value = percent; });
    toast(`Ready: ${result.staged.kind === 'private' ? 'private files' : 'server files'} ${result.staged.label}, ${result.staged.files} files`, 'good');
    loadServer();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    note.close();
    progress.hidden = true;
  }
});

async function loadLog() {
  for (const button of document.querySelectorAll('#log-tabs button')) button.classList.toggle('active', button.dataset.log === logName);
  const out = $('srv-log');
  try {
    const response = await fetch(`/api/server/logs?name=${encodeURIComponent(logName)}&lines=300`, { headers: authHeaders(), cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = JSON.parse(text).error; } catch (error) { /* plain text */ }
      throw new Error(message || `HTTP ${response.status}`);
    }
    out.textContent = text || '(empty)';
    out.scrollTop = out.scrollHeight;
  } catch (error) {
    out.textContent = error.message;
  }
}
for (const button of document.querySelectorAll('#log-tabs button')) {
  button.addEventListener('click', () => { logName = button.dataset.log; loadLog(); });
}
$('log-reload').addEventListener('click', loadLog);

// --- join codes ---------------------------------------------------------------------------------
// "RBX1-" + base64url of {s: server address, k: Tailscale auth key, n: name},
// made here in the browser and never sent to the server.

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const server = $('join-server').value.trim().replace(/\/$/, '');
  const key = $('join-key').value.trim();
  if (!/^https?:\/\/[A-Za-z0-9.[\]:-]+$/.test(server)) { toast('The server address looks like http://100.x.y.z', 'error'); return; }
  if (!/^tskey-[A-Za-z0-9-]{10,200}$/.test(key)) { toast('A Tailscale auth key starts with tskey-', 'error'); return; }
  const json = JSON.stringify({ s: server, k: key, n: JOIN_CODE_NAME });
  const base64url = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  $('join-output').textContent = `RBX1-${base64url}`;
  $('join-result').hidden = false;
});
$('join-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('join-output').textContent);
    toast('Copied', 'good');
  } catch (error) {
    toast('Select the code and copy it.', 'error');
  }
});

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
  if (started) return refresh();
  started = true;
  await refresh();
  route();
  loadServer();
  loadNews();
  loadMissing();
  loadReports();
  setInterval(() => { if (!busy && unlocked && !document.hidden) refresh(); }, 5000);
  setInterval(() => {
    if (busy || !unlocked || document.hidden) return;
    loadServer();
    loadReports(); // every view: the open count is in the sidebar
    if (view === 'accounts') loadAccounts();
    if (view === 'assets') loadMissing();
    if (view === 'announcements') loadNews();
  }, 15000);
  return undefined;
}

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
unlock();
