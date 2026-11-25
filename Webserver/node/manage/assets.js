'use strict';

// Assets Roblox no longer serves: the missing list (upload a replacement, or
// drop a file on a row), copies the searcher found (lib/assetsearch.js) to
// approve or reject, and what was replaced.

const KNOWN_TYPES = ['Audio', 'Image', 'Animation'];
const assetView = {
  tab: 'missing',        // missing | review | replaced
  type: '',
  game: '',              // a place ID, 'avatar' or 'unknown'
  text: '',
  previews: new Map(),   // "<id>/<n>" -> object URL
};
let pendingAsset = null;

const searchOf = (id) => (data.search && data.search.assets[id]) || null;
const pendingOf = (entry) => (entry ? entry.found.filter((item) => item.status === 'pending') : []);
const gameNameOf = (use) => (use.placeId === 'avatar' ? 'Avatars' : use.placeId === 'unknown' ? 'Unknown' : (placeById(use.placeId) || {}).name || use.name || `Place ${use.placeId}`);

function assetMatches(asset) {
  if (assetView.type && (assetView.type === 'other' ? KNOWN_TYPES.includes(asset.type) : asset.type !== assetView.type)) return false;
  if (assetView.game && !(asset.usedBy || []).some((use) => use.placeId === assetView.game)) return false;
  const text = assetView.text.trim().toLowerCase();
  if (text && !`${asset.name || ''} ${asset.creator || ''} ${asset.id}`.toLowerCase().includes(text)) return false;
  return true;
}

function searchCell(asset) {
  const entry = searchOf(asset.id);
  const found = pendingOf(entry).length;
  if (found) return h('td', { class: 'hide-sm' }, link(`${found} found`, 'assets/review', 'found-link'));
  if (!entry) return h('td', { class: 'sub hide-sm', text: 'Waiting' });
  const text = {
    queued: 'Waiting', new: 'Waiting', searching: 'Searching', failed: "Couldn't search",
    skipped: entry.skipped || 'Skipped', done: 'Nothing found',
  }[entry.state] || entry.state;
  return h('td', { class: `sub hide-sm${entry.state === 'searching' ? ' searching' : ''}`, text, title: entry.error || (entry.searchedAt ? `Searched ${when(entry.searchedAt)}` : null) });
}

function usedByCell(asset) {
  const uses = (asset.usedBy || []).slice().sort((a, b) => (a.placeId === 'unknown') - (b.placeId === 'unknown'));
  const names = [...new Set(uses.map(gameNameOf))];
  if (!names.length) return h('td', { class: 'sub hide-sm', text: '–' });
  const text = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  return h('td', { class: 'sub hide-sm', text, title: names.length > 2 ? names.join(', ') : null });
}

// A file dropped on a row replaces that asset.
const dropOn = (asset) => ({
  ondragover: (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    event.currentTarget.classList.add('drop-target');
  },
  ondragleave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('drop-target'); },
  ondrop: (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.currentTarget.classList.remove('drop-target');
    replaceAsset(asset, event.dataTransfer.files[0]);
  },
});

function renderAssets() {
  const open = data.missing.filter((asset) => !asset.replaced);
  const replaced = data.missing.filter((asset) => asset.replaced);
  const review = open.filter((asset) => pendingOf(searchOf(asset.id)).length);
  const reviewCount = review.reduce((sum, asset) => sum + pendingOf(searchOf(asset.id)).length, 0);
  const counts = { missing: open.length, review: reviewCount, replaced: replaced.length };
  for (const button of document.querySelectorAll('#assets-tabs button')) {
    button.classList.toggle('active', button.dataset.tab === assetView.tab);
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = counts[button.dataset.tab] || '';
  }
  // Type filter counts follow the tab.
  const pool = assetView.tab === 'replaced' ? replaced : assetView.tab === 'review' ? review : open;
  for (const button of document.querySelectorAll('#assets-type button')) {
    button.classList.toggle('active', button.dataset.filter === assetView.type);
    const saved = assetView.type;
    assetView.type = button.dataset.filter;
    const n = pool.filter(assetMatches).length;
    assetView.type = saved;
    let badge = button.querySelector('.n');
    if (!badge) { badge = h('span', { class: 'n' }); button.append(badge); }
    badge.textContent = button.dataset.filter ? n || '' : '';
  }
  // Games that asked for something missing.
  const gameIds = [...new Set(data.missing.flatMap((asset) => (asset.usedBy || []).map((use) => use.placeId)))];
  const gameSelect = $('assets-game');
  paint(gameSelect, JSON.stringify(gameIds.map((id) => [id, gameNameOf({ placeId: id })])), () => [h('option', { value: '', text: 'Every game' }),
    ...gameIds.map((id) => ({ id, name: gameNameOf({ placeId: id }) })).sort((a, b) => a.name.localeCompare(b.name)).map((item) => h('option', { value: item.id, text: item.name }))]);
  gameSelect.value = assetView.game;

  renderSearchState();
  $('assets-missing').hidden = assetView.tab !== 'missing';
  $('assets-review').hidden = assetView.tab !== 'review';
  $('assets-replaced').hidden = assetView.tab !== 'replaced';
  if (assetView.tab === 'missing') renderMissingTable(open.filter(assetMatches));
  if (assetView.tab === 'review') renderReview(review.filter(assetMatches));
  if (assetView.tab === 'replaced') renderReplaced(replaced.filter(assetMatches));
}

function renderSearchState() {
  const search = data.search;
  const box = $('search-state');
  if (!search) { box.replaceChildren(); return; }
  const running = search.running ? searchOf(search.running) : null;
  const runningAsset = search.running ? data.missing.find((asset) => asset.id === search.running) : null;
  const text = search.paused ? 'Search paused'
    : running ? `Searching ${(runningAsset && runningAsset.name) || search.running}${search.queued ? `, ${search.queued} waiting` : ''}`
      : search.queued ? `${search.queued} waiting` : 'Search idle';
  paint(box, JSON.stringify([text, search.paused]), () => [
    h('span', { class: `search-dot ${search.paused ? '' : running ? 'on' : ''}` }),
    h('span', { text }),
    btn(search.paused ? 'Resume' : 'Pause', 'small quiet', () => act(async () => {
      await change('POST', '/api/manage/asset-search', JSON.stringify({ paused: !search.paused }));
      await loadSearch();
    }, search.paused ? 'Resuming' : 'Pausing', search.paused ? 'Searching again' : 'Paused')),
  ]);
}

function renderMissingTable(shown) {
  const rows = $('asset-rows');
  $('asset-table').classList.toggle('no-type', KNOWN_TYPES.includes(assetView.type));
  const signature = JSON.stringify([shown.map((asset) => [asset, searchOf(asset.id)]), assetView.type]);
  paint(rows, signature, () => (shown.length ? shown.map((asset) => h('tr', dropOn(asset),
    h('td', {}, h('div', { class: 'game-name', text: asset.name || 'Unknown' }), asset.creator && h('div', { class: 'sub', text: asset.creator })),
    h('td', { class: 'hide-sm col-type', text: asset.type || '…' }),
    usedByCell(asset),
    h('td', { class: 'num sub mono hide-sm' }, h('a', { href: `https://www.roblox.com/library/${asset.id}`, target: '_blank', rel: 'noopener noreferrer', text: asset.id })),
    h('td', { class: 'sub hide-sm', text: asset.reason }),
    searchCell(asset),
    h('td', { class: 'actions' },
      btn('Search', 'small quiet', () => searchAgain(asset), { title: 'Search again now' }),
      btn('Replace', 'small', () => { pendingAsset = asset; $('missing-file').value = ''; $('missing-file').click(); }))))
    : h('tr', {}, h('td', { class: 'empty-cell', colSpan: 7, text: data.missingError || 'Nothing missing here.' }))));
}

async function searchAgain(asset) {
  try {
    await change('POST', `/api/manage/asset-search/${asset.id}/search`, '{}');
    toast(`Searching for ${asset.name || asset.id}`, 'good');
    loadSearch();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// One card per asset, its found copies side by side.
function renderReview(list) {
  const box = $('assets-review');
  const signature = JSON.stringify(list.map((asset) => [asset.id, asset.name, pendingOf(searchOf(asset.id))]));
  paint(box, signature, () => {
    if (!list.length) {
      const searched = data.search ? Object.values(data.search.assets).filter((entry) => entry.state === 'done' || entry.state === 'skipped').length : 0;
      return h('p', { class: 'empty', text: searched ? 'Nothing to review.' : 'Nothing found yet. The search runs in the background.' });
    }
    // Assets Roblox serves again are their own original files: one click for all of them.
    const originals = list.map((asset) => [asset, pendingOf(searchOf(asset.id)).find((item) => item.source === 'roblox')]).filter(([, item]) => item);
    const head = originals.length > 1 ? h('div', { class: 'review-bulk' },
      h('span', { text: `Roblox serves ${originals.length} of these again.` }),
      btn(`Approve those ${originals.length}`, 'small', () => approveOriginals(originals))) : null;
    return [head, ...list.map((asset) => {
      const found = pendingOf(searchOf(asset.id));
      const uses = [...new Set((asset.usedBy || []).filter((use) => use.placeId !== 'unknown').map(gameNameOf))];
      return h('div', { class: 'card review' },
        h('div', { class: 'review-head' },
          h('div', {}, h('b', { text: asset.name || asset.id }),
            h('div', { class: 'sub' }, [asset.type, asset.creator, asset.id].filter(Boolean).join(', '))),
          h('div', { class: 'sub right' }, h('div', { text: asset.reason }), uses.length ? h('div', { text: uses.slice(0, 3).join(', ') }) : null)),
        h('div', { class: 'found-row' }, found.map((item) => foundCard(asset, item))));
    })];
  });
  for (const element of box.querySelectorAll('[data-preview]')) fillPreview(element);
}

function foundCard(asset, item) {
  const kind = ['ogg', 'mp3', 'wav'].includes(item.ext) ? 'audio' : ['png', 'jpg'].includes(item.ext) ? 'image' : 'file';
  const preview = h('div', { class: `preview ${kind}`, dataset: { preview: `${asset.id}/${item.n}`, kind } },
    kind === 'file' ? h('span', { class: 'file-icon', text: item.ext.toUpperCase() }) : h('span', { class: 'muted', text: 'Loading' }));
  return h('div', { class: 'found' },
    preview,
    h('div', { class: 'found-text' },
      h('b', { text: item.label }),
      h('div', { class: 'sub' }, `${item.ext.toUpperCase()}, ${size(item.size)}`, item.date && !item.label.includes(item.date) ? `, ${item.date}` : ''),
      item.name && item.name !== asset.name ? h('div', { class: 'sub', text: `"${item.name}"` }) : null,
      item.link ? h('a', { class: 'sub', href: item.link, target: '_blank', rel: 'noopener noreferrer', text: 'Source' }) : null),
    h('div', { class: 'btn-row' },
      btn('Approve', 'small primary', () => decide(asset, item, 'approve')),
      btn('Reject', 'small', () => decide(asset, item, 'reject'))));
}

// Previews need the manage headers, so they come as blobs.
async function fillPreview(element) {
  const key = element.dataset.preview;
  const kind = element.dataset.kind;
  if (kind === 'file' || element.dataset.filled) return;
  element.dataset.filled = '1';
  let url = assetView.previews.get(key);
  if (!url) {
    try {
      const response = await fetch(`/api/manage/asset-search/${key}`, { headers: authHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      url = URL.createObjectURL(await response.blob());
      assetView.previews.set(key, url);
    } catch (error) {
      element.replaceChildren(h('span', { class: 'muted', text: "Couldn't load" }));
      return;
    }
  }
  if (kind === 'audio') element.replaceChildren(h('audio', { controls: true, preload: 'metadata', src: url }));
  else {
    const image = h('img', { alt: '', src: url });
    image.addEventListener('load', () => { element.title = `${image.naturalWidth} x ${image.naturalHeight}`; });
    element.replaceChildren(image);
  }
}

async function decide(asset, item, what) {
  const name = asset.name || asset.id;
  if (what === 'approve' && !await ask(`Use this for ${name}?`, `${item.label}. Games get it the next time they load the asset.`, 'Approve')) return;
  await act(async () => {
    await change('POST', `/api/manage/asset-search/${asset.id}/${item.n}/${what}`, '{}');
    const key = `${asset.id}/${item.n}`;
    if (assetView.previews.has(key)) { URL.revokeObjectURL(assetView.previews.get(key)); assetView.previews.delete(key); }
    await Promise.all([loadSearch(), loadMissing()]);
  }, what === 'approve' ? `Saving ${name}` : 'Rejecting', what === 'approve' ? `${name} replaced` : 'Rejected');
}

async function approveOriginals(pairs) {
  if (!await ask(`Approve ${plural(pairs.length, 'asset')}?`, 'Each is the file Roblox serves for that asset now.', 'Approve')) return;
  await actEach(pairs, ([asset, item]) => change('POST', `/api/manage/asset-search/${asset.id}/${item.n}/approve`, '{}'),
    (i, n) => `Approving ${i} of ${n}`, (n) => `${plural(n, 'asset')} replaced`);
  await Promise.all([loadSearch(), loadMissing()]);
}

function renderReplaced(list) {
  paint($('replaced-rows'), JSON.stringify(list), () => (list.length ? list.map((asset) => h('tr', {},
    h('td', {}, h('div', { class: 'game-name', text: asset.name || 'Unknown' }), asset.creator && h('div', { class: 'sub', text: asset.creator })),
    h('td', { class: 'hide-sm', text: asset.type || '' }),
    usedByCell(asset),
    h('td', { class: 'sub mono hide-sm', text: asset.replacement || '' }),
    h('td', { class: 'actions' }, btn('Undo', 'small', () => act(async () => {
      await change('DELETE', `/api/assets/${asset.id}/replacement`);
      await loadMissing();
    }, 'Removing the replacement', 'Replacement removed')))))
    : h('tr', {}, h('td', { class: 'empty-cell', colSpan: 5, text: 'Nothing replaced yet.' }))));
}

function replaceAsset(asset, file) {
  if (!file || !asset) return;
  if (file.size > 20 * 1024 * 1024) { toast('Replacements can be up to 20 MB.', 'error'); return; }
  act(async () => {
    await uploadFile(`/api/assets/${asset.id}/replacement`, file);
    await loadMissing();
  }, `Uploading ${file.name}`, `${asset.name || asset.id} replaced`);
}

views.assets = {
  // #assets[/missing|review|replaced[/<game>]]
  show(args) {
    assetView.tab = ['missing', 'review', 'replaced'].includes(args[0]) ? args[0] : 'missing';
    if (args[1] !== undefined) assetView.game = args[1];
    renderAssets();
  },
  render(what) { if (['missing', 'search', 'places'].includes(what)) renderAssets(); },
};

document.addEventListener('DOMContentLoaded', () => {
  for (const button of document.querySelectorAll('#assets-tabs button')) {
    button.addEventListener('click', () => { location.hash = `assets/${button.dataset.tab}`; });
  }
  for (const button of document.querySelectorAll('#assets-type button')) {
    button.addEventListener('click', () => { assetView.type = button.dataset.filter; renderAssets(); });
  }
  $('assets-game').addEventListener('change', () => { assetView.game = $('assets-game').value; renderAssets(); });
  $('assets-filter').addEventListener('input', () => { assetView.text = $('assets-filter').value; renderAssets(); });
  $('missing-file').addEventListener('change', () => replaceAsset(pendingAsset, $('missing-file').files[0]));
});
