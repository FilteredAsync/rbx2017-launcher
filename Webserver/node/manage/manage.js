'use strict';

// Server management page: the place library (GET /api/places) and the changes
// a host may make with the host key (see Webserver/node/lib/routes.js).

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
  const key = storedKey();
  if (!key) {
    $('key-state').textContent = 'Enter the host key first.';
    $('host-key').focus();
  }
  return key;
}

// Sends a change with the host key -> parsed JSON, or throws with the server's message.
async function change(method, url, body, contentType) {
  const key = needKey();
  if (!key) throw new Error('Enter the host key first.');
  const response = await fetch(url, { method, headers: { 'X-Host-Key': key, 'Content-Type': contentType || 'application/json' }, body });
  const result = await response.json().catch(() => ({}));
  if (response.status === 403) $('key-state').textContent = 'The server did not accept this key.';
  if (!response.ok) throw new Error(result.error || `The server answered HTTP ${response.status}.`);
  $('key-state').textContent = 'Key accepted.';
  return result;
}

// Uploads a file with progress (fetch has none) -> parsed JSON, or throws.
function uploadFile(url, file, progress) {
  return new Promise((resolve, reject) => {
    const key = needKey();
    if (!key) return reject(new Error('Enter the host key first.'));
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.setRequestHeader('X-Host-Key', key);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => { if (progress && event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100)); };
    request.onload = () => {
      let result = {};
      try { result = JSON.parse(request.responseText || '{}'); } catch (error) { result = {}; }
      if (request.status === 403) $('key-state').textContent = 'The server did not accept this key.';
      if (request.status >= 200 && request.status < 300) {
        $('key-state').textContent = 'Key accepted.';
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
    `File: Server\\content\\${place.file.replace(/\//g, '\\')}`,
    `Uploaded from: ${place.uploadedFrom || '?'} · added ${when(place.createdAt)} · changed ${when(place.updatedAt)}`,
    place.universeId ? `Roblox universe for its images: ${place.universeId}` : 'Roblox universe: not set',
  ];
  if (place.notes.length) lines.push('', 'Conversion notes:', ...place.notes);
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
  const universeLabel = el('label', '', 'Roblox universe for rbxgameasset images');
  universeLabel.append(universe);
  const row = el('div', 'row');
  const save = el('button', '', 'Save');
  save.type = 'submit';
  row.append(save, button('Cancel', 'ghost', () => { editing.delete(id); renderPlaces(true); }));
  form.append(nameLabel, descriptionLabel, universeLabel, row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      await change('POST', `/api/places/${id}`, JSON.stringify({ name: name.value, description: description.value, universeId: universe.value.trim() }));
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
    const response = await fetch('/api/places', { cache: 'no-store' });
    data = await response.json();
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
  $('key-state').textContent = storedKey() ? 'Saved in this browser.' : '';
});
$('key-forget').addEventListener('click', () => {
  storeKey('');
  $('host-key').value = '';
  $('key-state').textContent = 'Forgotten.';
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

refresh();
setInterval(() => { if (!busy) refresh(); }, 5000);
