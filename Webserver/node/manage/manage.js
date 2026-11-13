'use strict';

// Server management page: the place library (GET /api/places) and the changes
// a host may make (see Webserver/node/lib/routes.js). The page stays locked
// until the server accepts the host key or a manage token (lib/admin.js): the
// launcher's Manage games button opens it as /manage#token=... for admins.

const $ = (id) => document.getElementById(id);
let data = null;
let busy = false;            // an upload or change is in progress
const editing = new Set();   // place IDs whose edit form is open
let pendingPlace = null;     // which place the hidden file inputs are for

// --- helpers -------------------------------------------------------------------------

function storedKey() {
  try { return localStorage.getItem('hostKey') || ''; } catch (error) { return ''; }
}
function storeKey(value) {
  try { if (value) localStorage.setItem('hostKey', value); else localStorage.removeItem('hostKey'); } catch (error) { /* private window */ }
}
function storedToken() {
  try { return localStorage.getItem('manageToken') || ''; } catch (error) { return ''; }
}
function storeToken(value) {
  try { if (value) localStorage.setItem('manageToken', value); else localStorage.removeItem('manageToken'); } catch (error) { /* private window */ }
}

// A token from the launcher (#token=...) is kept, and taken out of the address.
function takeTokenFromAddress() {
  const match = /(?:^#|&)token=([0-9a-f]{64})/.exec(location.hash);
  if (!match) return false;
  storeToken(match[1]);
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function setStatus(node, text, kind) {
  node.textContent = text || '';
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

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
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '';
}

function needKey() {
  const ok = Boolean(storedKey() || storedToken());
  if (!ok) {
    $('key-state').textContent = 'Enter the host key first.';
    $('host-key').focus();
  }
  return ok;
}

// Sends a change with the host key or token -> parsed JSON, or throws with the server's message.
async function change(method, url, body, contentType) {
  if (!needKey()) throw new Error('Enter the host key first.');
  const response = await fetch(url, { method, headers: authHeaders({ 'Content-Type': contentType || 'application/json' }), body });
  const result = await response.json().catch(() => ({}));
  if (response.status === 403) unlock();
  if (!response.ok) throw new Error(result.error || `The server answered HTTP ${response.status}.`);
  return result;
}

// Uploads a file with progress (fetch has none) -> parsed JSON, or throws.
function uploadFile(url, file, progress) {
  return new Promise((resolve, reject) => {
    if (!needKey()) return reject(new Error('Enter the host key first.'));
    const request = new XMLHttpRequest();
    request.open('POST', url);
    for (const [name, value] of Object.entries(authHeaders({ 'Content-Type': 'application/octet-stream' }))) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => { if (progress && event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100)); };
    request.onload = () => {
      let result = {};
      try { result = JSON.parse(request.responseText || '{}'); } catch (error) { result = {}; }
      if (request.status === 403) unlock();
      if (request.status >= 200 && request.status < 300) {
        resolve(result);
      } else {
        reject(new Error(result.error || `The server answered HTTP ${request.status}.`));
      }
    };
    request.onerror = () => reject(new Error('The upload failed (connection lost?).'));
    request.send(file);
  });
}

// --- server line and list ---------------------------------------------------------------

function renderServer() {
  const line = $('server-line');
  line.textContent = '';
  const runner = data && data.runner ? data.runner : { running: false };
  const online = data ? data.places.filter((place) => place.status && place.status.state === 'running').length : 0;
  if (runner.running) {
    line.append(el('span', 'ok', 'Always-on server running'), document.createTextNode(` · ${online} game${online === 1 ? '' : 's'} online${runner.maxGames ? ` (up to ${runner.maxGames})` : ''}`));
  } else {
    line.append(el('span', 'bad', 'The always-on server is not running'), document.createTextNode(' - games will not start until startServer.bat runs on the server.'));
  }
  for (const problem of runner.problems || []) line.append(el('div', 'bad', problem));
}

function statusPill(place) {
  const status = place.status;
  const runnerUp = data && data.runner && data.runner.running;
  if (!place.enabled) return el('span', 'pill', status ? 'Turning off…' : 'Offline');
  if (!runnerUp) return el('span', 'pill starting', 'Waiting for the always-on server');
  if (!status) return el('span', 'pill starting', 'Starting…');
  if (status.state === 'running') {
    const players = Array.isArray(status.players) ? status.players : null;
    const who = players === null ? 'busy' : `${players.length} player${players.length === 1 ? '' : 's'}${players.length ? `: ${players.join(', ')}` : ''}`;
    const pill = el('span', 'pill running', `Online · ${who} · ${status.memoryMB || '?'} MB · up ${duration(Date.now() - Date.parse(status.startedAt))}`);
    pill.title = `Players join at ${status.address || '?'}`;
    return pill;
  }
  if (status.state === 'error') return el('span', 'pill error', `Not starting: ${status.lastError || 'unknown error'}`);
  return el('span', 'pill starting', status.state === 'restarting' ? 'Restarting…' : 'Starting…');
}

function placeCard(place) {
  const id = place.placeId;
  const card = el('article', `card${place.enabled ? '' : ' off'}`);
  card.dataset.placeId = id;

  const top = el('div', 'card-top');
  const thumb = el('div', 'thumb');
  if (place.thumbnail) {
    const img = el('img');
    img.alt = '';
    img.src = `/api/thumbnails/${id}?v=${place.thumbnail}`;
    thumb.append(img);
  } else {
    thumb.textContent = 'No picture';
  }
  const info = el('div', 'info');
  info.append(el('div', 'name', place.name));
  const pid = el('div', 'pid');
  pid.append(document.createTextNode('Place ID '), el('b', '', id), document.createTextNode(` · version ${place.version} · ${size(place.fileSize)}`));
  info.append(pid);
  if (place.description) info.append(el('div', 'desc', place.description));
  if (place.teamCreate) {
    const server = place.cloudEdit;
    const editing = server && Array.isArray(server.editors) ? server.editors : [];
    info.append(el('div', 'pid', `Team Create on${server ? ` · ${server.state === 'running' ? `${editing.length} editing${editing.length ? ` (${editing.join(', ')})` : ''}` : server.state}` : ''}`));
  }
  const creator = place.creator;
  info.append(el('div', 'pid', creator
    ? `By ${creator.name}${creator.source === 'roblox' ? ' (from Roblox)' : creator.source === 'owner' ? ' (its Studio owner)' : ''}${creator.type === 'Group' ? ' · group' : ''}`
    : `Creator: unknown${place.universeId ? ' (looking it up on Roblox…)' : ' (set the Roblox universe, or type one under Edit)'}`));
  if (place.owner || place.editors.length) {
    const who = [place.owner ? `Owner ${place.owner.name}` : 'No owner (admins only)'];
    if (place.editors.length) who.push(`editors: ${place.editors.map((e) => e.name).join(', ')}`);
    info.append(el('div', 'pid', `Studio: ${who.join(' · ')}`));
  }
  const pill = statusPill(place);
  pill.dataset.pill = id;
  info.append(pill);
  top.append(thumb, info);
  card.append(top);

  const actions = el('div', 'card-actions');
  const toggle = el('label', 'switch');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = place.enabled;
  box.addEventListener('change', () => act(() => change('POST', `/api/places/${id}`, JSON.stringify({ enabled: box.checked })), box.checked ? `Turning "${place.name}" on…` : `Turning "${place.name}" off…`));
  toggle.append(box, document.createTextNode('Online'));
  actions.append(toggle);
  const restart = button('Restart', 'ghost', () => act(() => change('POST', `/api/places/${id}/restart`, '{}'), `Restarting "${place.name}" (players are saved first)…`));
  restart.disabled = !place.enabled;
  actions.append(restart);
  actions.append(button('Edit', 'ghost', () => { editing.has(id) ? editing.delete(id) : editing.add(id); renderPlaces(true); }));
  actions.append(button('Replace file', 'ghost', () => { pendingPlace = place; $('replace-file').value = ''; $('replace-file').click(); }));
  actions.append(button('Thumbnail', 'ghost', () => { pendingPlace = place; $('thumb-file').value = ''; $('thumb-file').click(); }));
  actions.append(button('Delete', 'danger', () => {
    if (!confirm(`Delete "${place.name}" (place ${id})?\n\nIts file moves to Server\\content\\places\\deleted. Saves and the thumbnail are kept, and place ID ${id} is never reused.`)) return;
    act(() => change('DELETE', `/api/places/${id}`), `Deleting "${place.name}"…`);
  }));
  card.append(actions);

  if (editing.has(id)) card.append(editForm(place));

  const details = el('details');
  details.append(el('summary', '', 'Details'));
  const lines = [
    `File: Server\\content\\${String(place.file || '?').replace(/\//g, '\\')}`,
    `Uploaded from: ${place.uploadedFrom || '?'} · added ${when(place.createdAt)} · changed ${when(place.updatedAt)}`,
    place.universeId ? `Roblox universe for its images: ${place.universeId}` : 'Roblox universe: not set',
  ];
  if (place.notes && place.notes.length) lines.push('', 'Conversion notes:', ...place.notes);
  details.append(el('pre', '', lines.join('\n')));
  card.append(details);
  return card;
}

function editForm(place) {
  const id = place.placeId;
  const form = el('form', 'edit');
  const name = el('input');
  name.value = place.name;
  name.maxLength = 60;
  const description = el('textarea');
  description.value = place.description;
  description.maxLength = 1000;
  description.rows = 3;
  const universe = el('input');
  universe.value = place.universeId;
  universe.placeholder = 'Roblox universe ID (optional)';
  const nameLabel = el('label', '', 'Name');
  nameLabel.append(name);
  const descriptionLabel = el('label', '', 'Description');
  descriptionLabel.append(description);
  const universeLabel = el('label', '', 'Roblox universe (its images, and who made it)');
  universeLabel.append(universe);
  const creator = el('input');
  creator.maxLength = 60;
  const ownedHere = place.creator && place.creator.source === 'owner';
  creator.value = place.creator && !ownedHere ? place.creator.name : '';
  creator.placeholder = ownedHere ? `${place.creator.name} (its Studio owner)` : 'Found from the Roblox universe, or type a name';
  creator.disabled = ownedHere;
  const creatorLabel = el('label', '', 'Creator ("By ..." in the game and the launcher)');
  creatorLabel.append(creator);
  const owner = el('input');
  owner.value = place.owner ? place.owner.name : '';
  owner.placeholder = 'Studio account name (empty: admins only)';
  const ownerLabel = el('label', '', 'Owner in Studio (may publish over it and pick editors)');
  ownerLabel.append(owner);
  const editors = el('input');
  editors.value = place.editors.map((e) => e.name).join(', ');
  editors.placeholder = 'Studio account names, comma-separated';
  const editorsLabel = el('label', '', 'Editors in Studio');
  editorsLabel.append(editors);
  const teamCreate = el('input');
  teamCreate.type = 'checkbox';
  teamCreate.checked = place.teamCreate;
  const teamCreateLabel = el('label', 'check');
  teamCreateLabel.append(teamCreate, document.createTextNode(' Team Create: the owner and editors build it together in Studio'));
  const row = el('div', 'row');
  const save = el('button', '', 'Save');
  save.type = 'submit';
  row.append(save, button('Cancel', 'ghost', () => { editing.delete(id); renderPlaces(true); }));
  form.append(nameLabel, descriptionLabel, universeLabel, creatorLabel, ownerLabel, editorsLabel, teamCreateLabel, row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      const fields = { name: name.value, description: description.value, universeId: universe.value.trim(), teamCreate: teamCreate.checked };
      if (!ownedHere) fields.creator = creator.value.trim();
      await change('POST', `/api/places/${id}`, JSON.stringify(fields));
      const editorNames = editors.value.split(',').map((n) => n.trim()).filter(Boolean);
      await change('POST', `/api/places/${id}/access`, JSON.stringify({ owner: owner.value.trim(), editors: editorNames }));
      editing.delete(id);
    }, `Saving "${name.value}"…`);
  });
  return form;
}

function renderPlaces(force) {
  if (!data) return;
  const list = $('places');
  // Keep open edit forms as they are; only refresh the status lines.
  if (!force && editing.size > 0) {
    for (const place of data.places) {
      const old = list.querySelector(`[data-pill="${place.placeId}"]`);
      if (old) {
        const pill = statusPill(place);
        pill.dataset.pill = place.placeId;
        old.replaceWith(pill);
      }
    }
    return;
  }
  list.textContent = '';
  if (data.places.length === 0) list.append(el('div', 'empty', 'No games yet. Upload one above.'));
  for (const place of data.places) list.append(placeCard(place));
}

async function refresh() {
  try {
    const response = await fetch('/api/places', { headers: authHeaders(), cache: 'no-store' });
    data = await response.json();
    if (!$('join-server').value && data.server && data.server.tailscaleUrl) $('join-server').value = data.server.tailscaleUrl;
    renderServer();
    renderPlaces(false);
    $('list-state').textContent = '';
  } catch (error) {
    $('server-line').textContent = 'Cannot reach the web server.';
  }
}

// Runs a change, shows what happens, refreshes.
async function act(work, message) {
  if (busy) return;
  busy = true;
  setStatus($('list-state'), message);
  try {
    const result = await work();
    setStatus($('list-state'), 'Done.', 'good');
    await refresh();
    return result;
  } catch (error) {
    setStatus($('list-state'), error.message, 'error');
    await refresh();
    return null;
  } finally {
    busy = false;
  }
}

// --- forms -------------------------------------------------------------------------------

$('host-key').value = storedKey();
$('key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  storeKey($('host-key').value.trim());
  unlock();
});
$('key-forget').addEventListener('click', () => {
  storeKey('');
  storeToken('');
  $('host-key').value = '';
  lock('Forgotten.');
});

$('upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('upload-file').files[0];
  const status = $('upload-status');
  const from = $('upload-from').value.trim();
  if (!file) return;
  if (from && !/^\d{1,15}$/.test(from)) {
    setStatus(status, 'The Roblox place ID is a number.', 'error');
    return;
  }
  const query = new URLSearchParams({ name: $('upload-name').value.trim(), description: $('upload-description').value.trim(), enabled: $('upload-enabled').checked ? '1' : '0' });
  if (from) query.set('fromPlace', from);
  $('upload-button').disabled = true;
  $('upload-progress').hidden = false;
  $('upload-notes').hidden = true;
  setStatus(status, 'Uploading…');
  busy = true;
  try {
    const result = await uploadFile(`/api/places?${query}`, file, (percent) => {
      $('upload-progress').value = percent;
      if (percent === 100) setStatus(status, 'Converting…');
    });
    setStatus(status, `Uploaded as place ${result.place.placeId}.`, 'good');
    $('upload-notes').textContent = [`Place ID ${result.place.placeId} - "${result.place.name}"`, '', ...(result.notes || [])].join('\n');
    $('upload-notes').hidden = false;
    $('upload-form').reset();
    $('upload-enabled').checked = true;
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    busy = false;
    $('upload-button').disabled = false;
    $('upload-progress').hidden = true;
    $('upload-progress').value = 0;
    refresh();
  }
});

$('replace-file').addEventListener('change', () => {
  const file = $('replace-file').files[0];
  const place = pendingPlace;
  if (!file || !place) return;
  if (!confirm(`Replace the file of "${place.name}" (place ${place.placeId})?\n\nThe old version is kept in Server\\content\\places\\old. If the game is online it restarts after saving its players.`)) return;
  act(async () => {
    const query = place.universeId ? `?universeId=${encodeURIComponent(place.universeId)}` : '';
    const result = await uploadFile(`/api/places/${place.placeId}/file${query}`, file, (percent) => setStatus($('list-state'), `Uploading ${percent}%…`));
    return result;
  }, `Uploading a new version of "${place.name}"…`);
});

$('thumb-file').addEventListener('change', () => {
  const file = $('thumb-file').files[0];
  const place = pendingPlace;
  if (!file || !place) return;
  if (file.size > 4 * 1024 * 1024) {
    setStatus($('list-state'), 'Thumbnails can be up to 4 MB.', 'error');
    return;
  }
  act(() => change('POST', `/api/thumbnails/${place.placeId}`, file, 'application/octet-stream'), `Setting the thumbnail of "${place.name}"…`);
});

// --- join code --------------------------------------------------------------------------------
// "RBX1-" + base64url of {s: server address, k: Tailscale auth key, n: name};
// made here in the browser, never stored on the server.

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const server = $('join-server').value.trim().replace(/\/$/, '');
  const key = $('join-key').value.trim();
  if (!/^https?:\/\/[A-Za-z0-9.[\]:-]+$/.test(server)) {
    setStatus($('join-state'), 'The server address looks like http://100.x.y.z', 'error');
    return;
  }
  if (!/^tskey-[A-Za-z0-9-]{10,200}$/.test(key)) {
    setStatus($('join-state'), 'A Tailscale auth key starts with tskey-', 'error');
    return;
  }
  const json = JSON.stringify({ s: server, k: key, n: document.title });
  const base64url = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  $('join-output').textContent = `RBX1-${base64url}`;
  $('join-output').hidden = false;
  $('join-copy').hidden = false;
  setStatus($('join-state'), 'Share this code with your players (privately).', 'good');
});

$('join-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('join-output').textContent);
    setStatus($('join-state'), 'Copied.', 'good');
  } catch (error) {
    setStatus($('join-state'), 'Select the code and copy it.', 'error');
  }
});

// --- missing assets ------------------------------------------------------------------------

let missing = [];
let pendingAsset = null;

async function loadMissing() {
  try {
    missing = (await (await fetch('/api/assets/missing', { headers: authHeaders(), cache: 'no-store' })).json()).assets || [];
    renderMissing();
  } catch (error) {
    $('missing-state').textContent = 'Could not load the list.';
  }
}

function renderMissing() {
  const filter = $('missing-filter').value;
  const known = ['Audio', 'Image', 'Animation'];
  const shown = missing.filter((asset) => !filter || (filter === 'other' ? !known.includes(asset.type) : asset.type === filter));
  const rows = $('missing-rows');
  rows.textContent = '';
  const open = missing.filter((asset) => !asset.replaced).length;
  $('missing-state').textContent = `${open} missing, ${missing.length - open} replaced${missing.some((asset) => !asset.type) ? ' · looking up names…' : ''}`;
  if (shown.length === 0) {
    const row = el('tr');
    const cell = el('td', 'who', 'Nothing here.');
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const asset of shown) {
    const row = el('tr');
    row.append(el('td', '', asset.type || '…'));
    const name = el('td');
    name.append(document.createTextNode(asset.name || '(unknown)'));
    if (asset.creator) name.append(el('div', 'hint', `by ${asset.creator}`));
    row.append(name, el('td', 'who', asset.id), el('td', 'who', asset.reason));
    const actions = el('td', 'actions');
    if (asset.replaced) {
      actions.append(el('span', 'ok', `Replaced (${asset.replacement})`));
      actions.append(button('Remove', 'ghost', () => act(async () => {
        await change('DELETE', `/api/assets/${asset.id}/replacement`);
        await loadMissing();
      }, `Removing the replacement for ${asset.name || asset.id}…`)));
    } else {
      actions.append(button('Upload replacement', 'ghost', () => {
        pendingAsset = asset;
        $('missing-file').value = '';
        $('missing-file').click();
      }));
    }
    row.append(actions);
    rows.append(row);
  }
}

$('missing-filter').addEventListener('change', renderMissing);
$('missing-file').addEventListener('change', () => {
  const file = $('missing-file').files[0];
  const asset = pendingAsset;
  if (!file || !asset) return;
  if (file.size > 20 * 1024 * 1024) {
    setStatus($('list-state'), 'Replacements can be up to 20 MB.', 'error');
    return;
  }
  act(async () => {
    await uploadFile(`/api/assets/${asset.id}/replacement`, file);
    await loadMissing();
  }, `Uploading a replacement for ${asset.name || asset.id}…`);
});

// --- Studio accounts -----------------------------------------------------------------------

async function loadAccounts() {
  const rows = $('account-rows');
  if (!storedKey() && !storedToken()) {
    $('accounts-state').textContent = 'Enter the host key to see them.';
    rows.textContent = '';
    return;
  }
  try {
    const response = await fetch('/api/studio/accounts', { headers: authHeaders(), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderAccounts(result.accounts);
  } catch (error) {
    $('accounts-state').textContent = error.message;
  }
}

function renderAccounts(list) {
  const rows = $('account-rows');
  rows.textContent = '';
  $('accounts-state').textContent = `${list.length} account${list.length === 1 ? '' : 's'}`;
  if (list.length === 0) {
    const row = el('tr');
    const cell = el('td', 'who', 'Nobody has logged in to Studio yet.');
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const account of list) {
    const row = el('tr');
    row.append(el('td', '', account.name), el('td', 'who', account.userId), el('td', 'who', account.lastLoginAt ? when(account.lastLoginAt) : 'never'));
    const adminCell = el('td');
    const admin = el('input');
    admin.type = 'checkbox';
    admin.checked = account.admin;
    admin.addEventListener('change', () => act(async () => {
      await change('POST', `/api/studio/accounts/${encodeURIComponent(account.name)}`, JSON.stringify({ admin: admin.checked }));
      await loadAccounts();
    }, admin.checked ? `Making ${account.name} an admin…` : `${account.name} is no longer an admin…`));
    adminCell.append(admin);
    const actions = el('td', 'actions');
    actions.append(button('Delete', 'danger', () => {
      if (!confirm(`Delete the Studio account ${account.name}?

They are logged out. Logging in with that name again makes a new account with whatever password is typed (how a forgotten password is reset). Whoever logs in with that name next also gets the games it owns, so only delete it for its owner.`)) return;
      act(async () => {
        await change('DELETE', `/api/studio/accounts/${encodeURIComponent(account.name)}`);
        await loadAccounts();
      }, `Deleting ${account.name}…`);
    }));
    row.append(adminCell, actions);
    rows.append(row);
  }
}

$('key-form').addEventListener('submit', () => setTimeout(loadAccounts, 0));

// --- Announcements -------------------------------------------------------------------------

async function loadNews() {
  try {
    const response = await fetch('/api/announcements', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderNews(result.announcements || []);
  } catch (error) {
    $('news-state').textContent = error.message;
  }
}

function renderNews(list) {
  const box = $('news-list');
  box.textContent = '';
  $('news-state').textContent = list.length ? `${list.length} showing` : 'None showing';
  for (const item of list) {
    const row = el('div', `news-item${item.level === 'important' ? ' important' : ''}`);
    const body = el('div', 'body');
    if (item.title) body.append(el('div', 'head', item.title));
    body.append(el('div', 'text', item.text));
    const meta = [`Posted ${when(item.postedAt)}`, item.expiresAt ? `until ${when(item.expiresAt)}` : 'until removed'];
    if (item.level === 'important') meta.push('important');
    body.append(el('div', 'meta', meta.join(' · ')));
    row.append(body, button('Remove', 'danger', async () => {
      if (!confirm('Remove this announcement from every launcher?')) return;
      const status = $('news-status');
      try {
        setStatus(status, 'Removing…');
        await change('DELETE', `/api/announcements/${encodeURIComponent(item.id)}`);
        setStatus(status, 'Removed.', 'good');
        await loadNews();
      } catch (error) {
        setStatus(status, error.message, 'error');
      }
    }));
    box.append(row);
  }
}

$('news-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('news-status');
  try {
    setStatus(status, 'Posting…');
    await change('POST', '/api/announcements', JSON.stringify({
      title: $('news-title').value,
      text: $('news-text').value,
      level: $('news-important').checked ? 'important' : 'info',
      expiresHours: Number($('news-expires').value),
    }));
    $('news-title').value = '';
    $('news-text').value = '';
    $('news-important').checked = false;
    setStatus(status, 'Posted. Launchers show it within a few minutes.', 'good');
    await loadNews();
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
});

// --- Server: updates, restarting it, its logs ------------------------------------------------

let serverInfo = null;

async function loadServerPanel() {
  try {
    const response = await fetch('/api/server/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    serverInfo = await response.json();
    renderServerPanel();
  } catch (error) {
    $('srv-state').textContent = `Could not read the server's state: ${error.message}`;
  }
}

function renderServerPanel() {
  const info = serverInfo;
  const installed = info.installed;
  const runner = info.runner || {};
  const checks = runner.updates || null;
  $('srv-state').textContent = runner.running ? '' : 'The always-on server is not running: updates and restarts wait for it.';
  $('srv-installed').textContent = installed.publicLabel
    ? `${installed.publicLabel}${installed.privateLabel ? `; private files ${installed.privateLabel}` : ''}`
    : `Not recorded (set up before the updater)${installed.privateLabel ? `; private files ${installed.privateLabel}` : ''}`;

  const box = $('srv-updates');
  box.textContent = '';
  const waiting = info.staged.filter((item) => !item.failed);
  const failed = info.staged.filter((item) => item.failed);
  let line;
  if (waiting.length > 0) {
    line = `Ready to install: ${waiting.map((item) => `${item.kind === 'private' ? 'private files' : 'server files'} ${item.label}`).join(', ')}`
      + (checks && checks.autoUpdate === false ? '' : ' (installs once nobody has played for 3 minutes)');
  } else if (checks && checks.checking) {
    line = 'Checking…';
  } else if (checks && checks.lastError) {
    line = `Could not check: ${checks.lastError}`;
  } else if (checks && checks.lastCheck) {
    line = `Up to date (checked ${when(checks.lastCheck)})`;
  } else {
    line = 'Not checked yet (it checks a few minutes after starting, then every few hours)';
  }
  box.append(el('div', checks && checks.lastError && waiting.length === 0 ? 'bad' : '', line));
  for (const item of waiting) {
    if (item.notes) box.append(el('div', 'hint', item.notes));
  }
  for (const item of failed) {
    box.append(el('div', 'bad', `${item.label} did not work: ${item.failed}`));
    box.append(button('Discard it', 'danger', async () => {
      try {
        await change('POST', `/api/server/update/discard?build=${item.build}`);
        await loadServerPanel();
      } catch (error) {
        setStatus($('srv-status'), error.message, 'error');
      }
    }));
  }
  $('srv-install').hidden = waiting.length === 0;

  const last = info.lastResult;
  const lastBox = $('srv-last');
  lastBox.textContent = '';
  if (!last) {
    lastBox.textContent = 'None yet';
  } else {
    lastBox.append(el('div', last.ok ? 'good' : 'bad', `${last.ok ? 'Installed' : 'Failed'}: ${last.updates || 'update'}`));
    lastBox.append(el('div', 'hint', `${when(last.at)}${last.ok ? '' : ` · ${last.error}${last.restored === false ? ' · the server did not come back by itself' : ''}`}`));
  }
}

async function serverAction(url, waitingText, doneText) {
  const status = $('srv-status');
  try {
    setStatus(status, waitingText);
    await change('POST', url);
    setStatus(status, doneText, 'good');
    setTimeout(loadServerPanel, 4000);
    setTimeout(loadServerPanel, 15000);
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

$('srv-check').addEventListener('click', () => serverAction('/api/server/update/check', 'Asking the server to check…', 'Checking: the result shows here within a few seconds.'));

$('srv-install').addEventListener('click', () => {
  if (!confirm('Install the update now?\n\nPlayers in games are saved and sent a message; the server is back in about a minute. If the new version does not start, the old one is put back.')) return;
  serverAction('/api/server/update/install', 'Asking the server to install…', 'Installing: the server is back in about a minute (refresh this page then).');
});

$('srv-restart').addEventListener('click', () => {
  if (!confirm('Restart the whole server?\n\nPlayers in games are saved and sent a message; the web server and every game start again within about a minute.')) return;
  serverAction('/api/server/restart', 'Asking the server to restart…', 'Restarting: back in about a minute (refresh this page then).');
});

$('srv-upload-button').addEventListener('click', () => {
  if (needKey()) $('srv-upload').click();
});

$('srv-upload').addEventListener('change', async () => {
  const file = $('srv-upload').files[0];
  $('srv-upload').value = '';
  if (!file) return;
  const status = $('srv-status');
  const progress = $('srv-progress');
  try {
    progress.hidden = false;
    progress.value = 0;
    setStatus(status, `Uploading ${file.name}…`);
    const result = await uploadFile('/api/server/update/upload', file, (percent) => { progress.value = percent; });
    setStatus(status, `Checked and ready: ${result.staged.kind === 'private' ? 'private files' : 'server files'} ${result.staged.label} (${result.staged.files} files). Press Install now, or it installs once nobody is playing.`, 'good');
    await loadServerPanel();
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    progress.hidden = true;
  }
});

$('srv-log-show').addEventListener('click', async () => {
  if (!needKey()) return;
  const out = $('srv-log');
  try {
    const response = await fetch(`/api/server/logs?name=${encodeURIComponent($('srv-log-name').value)}&lines=300`, { headers: authHeaders(), cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = JSON.parse(text).error; } catch (error) { /* plain text */ }
      throw new Error(message || `HTTP ${response.status}`);
    }
    out.textContent = text;
    out.hidden = false;
    out.scrollTop = out.scrollHeight;
  } catch (error) {
    setStatus($('srv-status'), error.message, 'error');
  }
});

// --- lock -------------------------------------------------------------------------------
// Nothing shows until the server accepts the host key or a manage token.

let unlocked = false;
let started = false;

function lock(message) {
  unlocked = false;
  document.body.classList.add('locked');
  $('server-line').textContent = 'Locked: for admins only';
  $('key-state').textContent = message || '';
}

async function unlock() {
  if (!storedKey() && !storedToken()) return lock('');
  let response;
  try {
    response = await fetch('/api/manage/whoami', { headers: authHeaders(), cache: 'no-store' });
  } catch (error) {
    return lock('Cannot reach the web server.');
  }
  if (!response.ok) {
    const hadToken = Boolean(storedToken());
    storeToken('');
    if (storedKey()) return lock('The server did not accept this key.');
    return lock(hadToken ? 'That link has run out: open Manage games from the launcher again.' : '');
  }
  const who = await response.json().catch(() => ({}));
  unlocked = true;
  document.body.classList.remove('locked');
  $('key-state').textContent = who.via === 'account' ? `Signed in as ${who.name} (admin).` : 'Host key accepted.';
  if (started) return refresh();
  started = true;
  refresh();
  loadNews();
  loadServerPanel();
  loadMissing();
  loadAccounts();
  setInterval(() => { if (!busy && unlocked) loadServerPanel(); }, 15000);
  setInterval(() => { if (!busy && unlocked) loadAccounts(); }, 15000);
  setInterval(() => { if (!busy && unlocked) refresh(); }, 5000);
  setInterval(() => { if (!busy && unlocked) loadMissing(); }, 15000);
  return undefined;
}

unlock();
// The same page opened again from the launcher, with a new token.
window.addEventListener('hashchange', () => { if (takeTokenFromAddress()) unlock(); });
