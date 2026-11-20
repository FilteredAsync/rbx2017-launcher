'use strict';

// Studio's Toolbox (IDE/ClientToolbox.aspx): the signed-in player's inventory
// by category; clicking an item inserts it into the place. Studio's web view
// gives the page window.external (RobloxStudio RbxWorkspace): Insert(url)
// loads the asset at url and puts it in the Workspace. Studio 2017's web view
// is QtWebKit 5.6 (about Safari 7): ES5 and floats only.
//
//   const toolbox = require('./toolbox')({ sendUtf8, launcher });
//   toolbox.page(ctx)

const accounts = require('./accounts');

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// What can be inserted: things that are models in a place (packages are not
// assets, body parts only make sense on a character).
const CATEGORIES = [
  ['hats', 'Hats'], ['gear', 'Gear'], ['hair', 'Hair'], ['faces', 'Faces'], ['heads', 'Heads'],
  ['shirts', 'Shirts'], ['pants', 'Pants'], ['tshirts', 'T-Shirts'], ['face', 'Face accessories'],
  ['neck', 'Neck'], ['shoulder', 'Shoulder'], ['front', 'Front'], ['back', 'Back'], ['waist', 'Waist'],
];

const STYLE = `body{margin:0;font:13px/1.35 "Source Sans Pro",Arial,sans-serif;background:#fff;color:#191919}
.top{padding:6px 6px 4px;border-bottom:1px solid #ddd}.top select{width:100%;font-size:13px;padding:3px}
.who{color:#757575;margin:4px 0 0}.grid{padding:4px}.grid:after{content:"";display:block;clear:both}
.tile{float:left;width:76px;margin:3px;text-align:center;cursor:pointer;border:1px solid transparent;border-radius:3px;padding:2px 0}
.tile:hover{border-color:#00a2ff;background:#eef8ff}.tile img{width:64px;height:64px;display:block;margin:0 auto}
.tname{display:block;height:2.7em;overflow:hidden;font-size:11px;padding:0 2px}.note{padding:10px;color:#555}.note a{color:#00a2ff}
.status{padding:4px 8px;color:#02b757;min-height:1.4em}.status.bad{color:#c0392b}`;

module.exports = function toolboxPages({ sendUtf8, launcher }) {
  function html(ctx, body) {
    sendUtf8(ctx, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`);
  }

  async function page(ctx) {
    const who = accounts.fromRequest(ctx.req);
    if (!who) {
      return html(ctx, '<p class="note">Log in to Studio (from the launcher) to see your inventory here.</p>'
        + '<p class="note">Insert models you saved as .rbxm/.rbxmx with right-click &gt; Insert from File.</p>');
    }
    const asked = String(ctx.queryLower.category || 'hats');
    const category = CATEGORIES.some(([key]) => key === asked) ? asked : 'hats';
    const items = await launcher.shop.inventory(who.userId, category);
    const options = CATEGORIES.map(([key, label]) => `<option value="${key}"${key === category ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    const tiles = items.map((item) => `<div class="tile" title="${escapeHtml(item.name)}" data-id="${escapeHtml(item.id)}">`
      + `<img src="/asset-thumbnail/image?assetId=${encodeURIComponent(item.id)}&amp;width=110&amp;height=110" alt="">`
      + `<span class="tname">${escapeHtml(item.name)}</span></div>`).join('');
    html(ctx, `<div class="top"><select id="cat">${options}</select><div class="who">${escapeHtml(who.name)}'s inventory. Click to insert.</div></div>`
      + '<div class="status" id="status"></div>'
      + (items.length ? `<div class="grid" id="grid">${tiles}</div>` : '<p class="note">Nothing here yet. Get items in the launcher\'s Avatar tab or on the website\'s catalog.</p>')
      + `<script>(function () {
  var select = document.getElementById('cat');
  select.onchange = function () { location.href = '/IDE/ClientToolbox.aspx?category=' + select.value; };
  var grid = document.getElementById('grid');
  var status = document.getElementById('status');
  if (!grid) return;
  grid.onclick = function (event) {
    var node = event.target;
    while (node && node !== grid && !(node.className && node.className.indexOf('tile') === 0)) node = node.parentNode;
    if (!node || node === grid) return;
    var id = node.getAttribute('data-id');
    var name = node.getAttribute('title');
    var ok = false;
    try { ok = window.external && window.external.Insert(location.protocol + '//' + location.host + '/asset/?id=' + id); } catch (e) { ok = false; }
    status.className = ok ? 'status' : 'status bad';
    status.textContent = ok ? 'Inserted ' + name + '.' : 'Could not insert ' + name + '.';
  };
})();</script>`);
  }

  return { page };
};
