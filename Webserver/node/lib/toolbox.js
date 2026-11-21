'use strict';

// Studio's Toolbox (IDE/ClientToolbox.aspx), like 2017's: search Roblox's free
// models, decals, meshes and audio made before 2018, or list the signed-in
// player's inventory; clicking an item inserts it. Studio's web view gives the
// page window.external (RobloxStudio RbxWorkspace): Insert(url) loads the
// model at url and puts it in the place. Studio 2017's web view is QtWebKit
// 5.6 (about Safari 7): ES5 and floats only. It reaches the server over
// http://localhost./ (tools/patch-2017-studio-webview.py; over https Qt refused
// the launcher proxy's self-signed certificate and the Toolbox stayed blank).
//
// Inserting goes through asset/?id=<id>&toolbox=<kind>, which hands Studio a
// model it can read: models, decals and items through the place converter
// (lib/placefile.js), meshes as a Part with a SpecialMesh, audio as a Sound.
//
//   const toolbox = require('./toolbox')({ send, sendUtf8, launcher, assetBytes, convertModel });
//   toolbox.page(ctx), toolbox.insert(ctx)

const accounts = require('./accounts');

const SEARCH_URL = 'https://apis.roblox.com/toolbox-service/v1/marketplace';
const DETAILS_URL = 'https://apis.roblox.com/toolbox-service/v1/items/details';
// Only items made before this (the user's choice): newer ones lean on what
// 2017 can't run. About one search result in ten is that old, so a page reads
// several search pages.
const CUTOFF = '2018-01-01';
const PAGE_SIZE = 24;
const BATCH = 100;
const MAX_BATCHES = 6;
const DETAILS_CHUNK = 50;

// [key, label, Roblox asset type, what an insert makes]
const SEARCHES = [
  ['models', 'Free Models', 10, 'model'],
  ['decals', 'Free Decals', 13, 'model'],
  ['meshes', 'Free Meshes', 40, 'mesh'],
  ['audio', 'Free Audio', 3, 'sound'],
];
// The player's inventory: things that are models in a place.
const INVENTORY = [
  ['hats', 'Hats'], ['gear', 'Gear'], ['hair', 'Hair'], ['faces', 'Faces'], ['heads', 'Heads'],
  ['shirts', 'Shirts'], ['pants', 'Pants'], ['tshirts', 'T-Shirts'], ['face', 'Face accessories'],
  ['neck', 'Neck'], ['shoulder', 'Shoulder'], ['front', 'Front'], ['back', 'Back'], ['waist', 'Waist'],
];

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const xmlText = (text) => String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// --- small caches -----------------------------------------------------------------------

function cache(maxEntries, ttlMs) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.at > ttlMs) { map.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, at: Date.now() });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
  };
}
const batches = cache(300, 10 * 60 * 1000);
const itemInfo = cache(20000, 6 * 3600 * 1000);
const converted = cache(60, 3600 * 1000);

async function getJson(url, emptyOn404 = false) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (response.status === 404 && emptyOn404) return {};
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}

// One page of Roblox's search: { ids, next }.
async function searchBatch(typeId, keyword, cursor) {
  const key = `${typeId}|${keyword}|${cursor}`;
  const known = batches.get(key);
  if (known) return known;
  const query = new URLSearchParams({ keyword, limit: String(BATCH) });
  if (cursor) query.set('cursor', cursor);
  const data = await getJson(`${SEARCH_URL}/${typeId}?${query}`);
  const ids = (Array.isArray(data.data) ? data.data : []).map((entry) => String(entry.id)).filter((id) => /^\d{1,20}$/.test(id));
  const result = { ids, next: typeof data.nextPageCursor === 'string' && data.nextPageCursor ? data.nextPageCursor : null };
  batches.set(key, result);
  return result;
}

// Name, creator and date of each item: Map id -> info. Items Roblox no longer
// lists are left out (and remembered as gone: asked for alone, Roblox answers 404).
const GONE = { gone: true };
async function details(ids) {
  const found = new Map();
  const missing = [];
  for (const id of ids) {
    const info = itemInfo.get(id);
    if (info === undefined) missing.push(id);
    else if (info !== GONE) found.set(id, info);
  }
  for (let i = 0; i < missing.length; i += DETAILS_CHUNK) {
    const chunk = missing.slice(i, i + DETAILS_CHUNK);
    const data = await getJson(`${DETAILS_URL}?assetIds=${chunk.join(',')}`, true);
    for (const id of chunk) itemInfo.set(id, GONE);
    for (const entry of Array.isArray(data.data) ? data.data : []) {
      const asset = entry && entry.asset;
      if (!asset || asset.id === undefined) continue;
      const info = {
        id: String(asset.id),
        name: String(asset.name || 'Item').slice(0, 100),
        creator: entry.creator && entry.creator.name ? String(entry.creator.name).slice(0, 50) : '',
        created: String(asset.createdUtc || ''),
        typeId: Number(asset.typeId) || 0,
      };
      itemInfo.set(info.id, info);
      found.set(info.id, info);
    }
  }
  return found;
}

// Where a page starts: Roblox's cursor plus a place in that batch, as one token.
const pageToken = (cursor, index) => `${index}.${cursor}`;
function readToken(token) {
  const match = /^(\d{1,3})\.(.{0,600})$/.exec(String(token || ''));
  return match ? { index: Number(match[1]), cursor: match[2] } : { index: 0, cursor: '' };
}

// A page of items made before the cutoff: { items, next } (next: token or null).
async function search(typeId, keyword, token) {
  let { cursor, index } = readToken(token);
  const items = [];
  for (let n = 0; n < MAX_BATCHES; n += 1) {
    const batch = await searchBatch(typeId, keyword, cursor);
    const info = await details(batch.ids.slice(index));
    for (let i = index; i < batch.ids.length; i += 1) {
      const item = info.get(batch.ids[i]);
      if (!item || !item.created || item.created >= CUTOFF || item.typeId !== typeId) continue;
      if (items.length === PAGE_SIZE) return { items, next: pageToken(cursor, i) };
      items.push(item);
    }
    index = 0;
    if (!batch.next) return { items, next: null };
    cursor = batch.next;
  }
  return { items, next: pageToken(cursor, 0) };
}

// --- the page ----------------------------------------------------------------------------

const STYLE = `body{margin:0;font:13px/1.35 "Source Sans Pro",Arial,sans-serif;background:#fff;color:#191919}
form{margin:0;padding:6px 6px 5px;border-bottom:1px solid #ddd;background:#f2f2f2}
select{width:100%;font-size:13px;padding:2px;margin:0 0 5px}
.find{position:relative;height:24px}
.find input{float:left;width:100%;height:24px;font-size:13px;padding:2px 30px 2px 5px;border:1px solid #b8b8b8;box-sizing:border-box;-webkit-box-sizing:border-box}
.find button{position:absolute;right:1px;top:1px;width:26px;height:22px;border:0;border-left:1px solid #ddd;background:#fff;cursor:pointer;font-size:14px;color:#555;padding:0}
.grid{padding:4px}.grid:after{content:"";display:block;clear:both}
.tile{float:left;width:84px;margin:3px;text-align:center;cursor:pointer;border:1px solid transparent;border-radius:3px;padding:3px 0 2px}
.tile:hover{border-color:#00a2ff;background:#eef8ff}.tile img{width:70px;height:70px;display:block;margin:0 auto 2px}
.tname{display:block;height:2.6em;overflow:hidden;font-size:11px;padding:0 2px;word-wrap:break-word}
.tby{display:block;height:1.3em;overflow:hidden;font-size:10px;color:#888;padding:0 2px;white-space:nowrap;text-overflow:ellipsis}
.note{padding:8px 10px;color:#666}.status{padding:4px 8px;color:#02b757;min-height:1.4em}.status.bad{color:#c0392b}
.pager{padding:6px 8px 12px;text-align:center}.pager a{color:#00a2ff;text-decoration:none;margin:0 10px}`;

module.exports = function toolboxPages({ send, sendUtf8, launcher, assetBytes, convertModel }) {
  function html(ctx, body) {
    sendUtf8(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`);
  }

  function form(category, keyword) {
    const option = ([key, label]) => `<option value="${key}"${key === category ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    return '<form id="f" method="get" action="/IDE/ClientToolbox.aspx">'
      + `<select name="category" id="cat"><optgroup label="Made before 2018">${SEARCHES.map(option).join('')}</optgroup>`
      + `<optgroup label="My inventory">${INVENTORY.map(option).join('')}</optgroup></select>`
      + `<div class="find"><input type="text" name="q" value="${escapeHtml(keyword)}" placeholder="Search" maxlength="60"><button type="submit" title="Search">&#9906;</button></div>`
      + '</form>';
  }

  function tiles(items, kind) {
    return items.map((item) => `<div class="tile" title="${escapeHtml(item.name)}" data-id="${escapeHtml(item.id)}" data-kind="${kind}">`
      + `<img src="/asset-thumbnail/image?assetId=${encodeURIComponent(item.id)}&amp;width=110&amp;height=110" alt="">`
      + `<span class="tname">${escapeHtml(item.name)}</span>${item.creator ? `<span class="tby">by ${escapeHtml(item.creator)}</span>` : ''}</div>`).join('');
  }

  const SCRIPT = `<script>(function () {
  var select = document.getElementById('cat');
  select.onchange = function () { document.getElementById('f').submit(); };
  var grid = document.getElementById('grid');
  var status = document.getElementById('status');
  if (!grid) return;
  grid.onclick = function (event) {
    var node = event.target;
    while (node && node !== grid && !(node.className && node.className.indexOf('tile') === 0)) node = node.parentNode;
    if (!node || node === grid) return;
    var name = node.getAttribute('title');
    var url = location.protocol + '//' + location.host + '/asset/?id=' + node.getAttribute('data-id') + '&toolbox=' + node.getAttribute('data-kind');
    status.className = 'status';
    status.textContent = 'Inserting ' + name + '...';
    setTimeout(function () {
      var ok = false;
      try { ok = window.external && window.external.Insert(url); } catch (e) { ok = false; }
      status.className = ok ? 'status' : 'status bad';
      status.textContent = ok ? 'Inserted ' + name + '.' : 'Could not insert ' + name + '.';
    }, 30);
  };
})();</script>`;

  async function page(ctx) {
    const who = accounts.fromRequest(ctx.req);
    const asked = String(ctx.queryLower.category || 'models');
    const keyword = String(ctx.queryLower.q || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    const searchEntry = SEARCHES.find(([key]) => key === asked);
    const inventoryEntry = INVENTORY.find(([key]) => key === asked);
    const category = searchEntry || inventoryEntry ? asked : 'models';
    let body = form(category, keyword) + '<div class="status" id="status"></div>';

    if (inventoryEntry) {
      if (!who) {
        body += '<p class="note">Log in to Studio from the launcher to see your inventory.</p>';
      } else {
        const wanted = keyword.toLowerCase();
        const items = (await launcher.shop.inventory(who.userId, category))
          .filter((item) => !wanted || String(item.name).toLowerCase().includes(wanted))
          .map((item) => ({ id: String(item.id), name: item.name, creator: '' }));
        body += items.length ? `<div class="grid" id="grid">${tiles(items, 'model')}</div>`
          : '<p class="note">Nothing here. Get items in the launcher\'s Avatar tab or on the website\'s catalog.</p>';
      }
      return html(ctx, body + SCRIPT);
    }

    const [, , typeId, kind] = searchEntry || SEARCHES[0];
    let result;
    try {
      result = await search(typeId, keyword, ctx.queryLower.page);
    } catch (error) {
      return html(ctx, `${body}<p class="note">Search is not answering right now (${escapeHtml(error.message)}). Try again in a moment.</p>${SCRIPT}`);
    }
    if (!result.items.length) {
      body += `<p class="note">${keyword ? 'Nothing from before 2018 matches that.' : 'Nothing found.'}</p>`;
    } else {
      body += `<div class="grid" id="grid">${tiles(result.items, kind)}</div>`;
    }
    const links = [];
    if (ctx.queryLower.page) links.push('<a href="javascript:history.back()">&lsaquo; Back</a>');
    if (result.next) {
      const query = new URLSearchParams({ category, q: keyword, page: result.next });
      links.push(`<a href="/IDE/ClientToolbox.aspx?${escapeHtml(query.toString())}">More &rsaquo;</a>`);
    }
    if (links.length) body += `<div class="pager">${links.join('')}</div>`;
    html(ctx, body + SCRIPT);
  }

  // --- inserting ---------------------------------------------------------------------------

  const REFERENT = 'RBX2017TOOLBOX';
  const xmlModel = (items) => '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    + `xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n${items}</roblox>\n`;

  function meshModel(id, name) {
    return xmlModel(`<Item class="Part" referent="${REFERENT}0"><Properties>`
      + `<string name="Name">${xmlText(name)}</string><bool name="Anchored">true</bool>`
      + '<Vector3 name="size"><X>4</X><Y>4</Y><Z>4</Z></Vector3>'
      + `</Properties><Item class="SpecialMesh" referent="${REFERENT}1"><Properties>`
      + '<string name="Name">Mesh</string><token name="MeshType">5</token>'
      + `<Content name="MeshId"><url>rbxassetid://${id}</url></Content>`
      + '<Vector3 name="Scale"><X>1</X><Y>1</Y><Z>1</Z></Vector3>'
      + '</Properties></Item></Item>\n');
  }

  function soundModel(id, name) {
    return xmlModel(`<Item class="Sound" referent="${REFERENT}0"><Properties>`
      + `<string name="Name">${xmlText(name)}</string>`
      + `<Content name="SoundId"><url>rbxassetid://${id}</url></Content>`
      + '<float name="Volume">0.5</float>'
      + '</Properties></Item>\n');
  }

  // asset/?id=<id>&toolbox=<model|mesh|sound> (lib/routes.js assetEndpoint): the
  // engine only loads content from asset paths, so inserts use that address.
  async function insert(ctx) {
    const id = String(ctx.queryLower.id || '');
    const kind = String(ctx.queryLower.toolbox || 'model');
    if (!/^\d{1,20}$/.test(id)) return sendUtf8(ctx, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Invalid id');
    const headers = { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' };
    if (kind === 'mesh' || kind === 'sound') {
      let name = kind === 'mesh' ? 'Mesh' : 'Sound';
      try { name = ((await details([id])).get(id) || {}).name || name; } catch (error) { /* keep the plain name */ }
      return sendUtf8(ctx, 200, headers, kind === 'mesh' ? meshModel(id, name) : soundModel(id, name));
    }
    let xml = converted.get(id);
    if (!xml) {
      const bytes = await assetBytes(id);
      if (!bytes) return sendUtf8(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Asset unavailable');
      try {
        xml = await convertModel(bytes);
      } catch (error) {
        return sendUtf8(ctx, 422, { 'Content-Type': 'text/plain; charset=utf-8' }, `Could not convert this model: ${error.message}`);
      }
      converted.set(id, xml);
    }
    send(ctx, 200, headers, xml);
  }

  return { page, insert };
};
