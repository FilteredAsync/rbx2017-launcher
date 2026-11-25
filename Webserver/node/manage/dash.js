'use strict';

// Dashboard: players and servers per Roblox version, players over time, what
// needs a look, and the always-on server's recent errors.

const dash = { range: 'day' };   // 'day' (24 h) or 'week'

function renderDash() {
  const overview = data.overview;
  $('dash-sub').textContent = data.overviewError || '';
  if (!overview) return;
  const open = data.missing.filter((asset) => !asset.replaced);
  const review = data.search ? Object.values(data.search.assets).reduce((sum, entry) => sum + entry.found.filter((item) => item.status === 'pending').length, 0) : 0;
  const openReports = data.reports.filter((report) => report.status === 'open');

  // Tiles
  const now = overview.now;
  const tile = (label, value, sub, hash, kind) => h(hash ? 'a' : 'div', { class: `card tile ${kind || ''}`, href: hash ? `#${hash}` : null },
    h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value', text: value }), sub && h('div', { class: 'tile-sub', text: sub }));
  paint($('dash-tiles'), JSON.stringify([now, open.length, review, openReports.length, data.runner.running]), () => [
    tile('Playing now', String(now.players), now.up ? `on ${plural(now.servers, 'server')}` : 'Server not running', 'games', now.up ? '' : 'bad'),
    ...now.engines.filter((engine) => engine.installed || engine.servers).map((engine) => tile(
      h('span', { class: 'engine-key' }, h('i', { class: `swatch e${engine.id}` }), engine.label),
      String(engine.players), `${plural(engine.servers, 'server')}, ${plural(engine.games, 'game')}`, null)),
    tile('Missing assets', String(open.length), review ? `${review} found to review` : 'Nothing to review', review ? 'assets/review' : 'assets', review ? 'hot' : ''),
    tile('Open reports', String(openReports.length), openReports.length ? `Newest ${ago(openReports[0].at)}` : 'All clear', 'reports'),
  ]);

  paintChart(overview);

  // Needs a look
  const todo = [];
  for (const problem of overview.problems) {
    const game = problem.placeId ? placeById(problem.placeId) : null;
    todo.push({
      kind: 'bad', tag: problem.kind === 'start' ? "Didn't start" : problem.kind === 'server' ? 'Server error' : 'Server',
      text: `${problem.name || (game && game.name) || ''}${problem.name || game ? ': ' : ''}${problem.text}`,
      hash: problem.placeId ? `games/${problem.placeId}/${problem.kind === 'server' ? 'servers' : 'log'}` : 'server',
    });
  }
  for (const [placeId, report] of Object.entries(overview.convertReports)) {
    const game = placeById(placeId);
    if (!game || (!report.errors && report.loads !== false)) continue;
    todo.push({ kind: 'bad', tag: 'Converter', text: `${game.name}: ${report.loads === false ? "doesn't load" : plural(report.errors, 'error')}`, hash: `games/${placeId}/report` });
  }
  if (review) todo.push({ kind: 'hot', tag: 'Assets', text: `${plural(review, 'copy', 'copies')} of missing assets to review`, hash: 'assets/review' });
  if (openReports.length) todo.push({ kind: 'warn', tag: 'Reports', text: `${plural(openReports.length, 'open report')}`, hash: 'reports' });
  const info = data.serverInfo;
  if (info && info.staged.some((item) => !item.failed)) todo.push({ kind: 'warn', tag: 'Update', text: 'An update is ready to install', hash: 'server' });
  if (info && info.staged.some((item) => item.failed)) todo.push({ kind: 'bad', tag: 'Update', text: 'An update failed', hash: 'server' });
  paint($('dash-todo'), JSON.stringify(todo), () => (todo.length
    ? todo.map((item) => h('a', { class: 'todo', href: `#${item.hash}` }, h('span', { class: `todo-tag ${item.kind}`, text: item.tag }), h('span', { class: 'todo-text', text: item.text })))
    : h('p', { class: 'muted pad', text: 'Nothing needs a look.' })));

  // Busiest games
  const busiest = data.places.filter((place) => playersIn(place) > 0).sort((a, b) => playersIn(b) - playersIn(a)).slice(0, 6);
  paint($('dash-busy'), JSON.stringify(busiest.map((place) => [place.placeId, place.name, playersIn(place), engineOf(place), place.thumbnail])), () => (busiest.length
    ? busiest.map((place) => h('a', { class: 'busy-row', href: `#games/${place.placeId}` }, thumb(place), h('span', { class: 'busy-name', text: place.name }), engineTag(engineOf(place)), h('b', { text: playersIn(place) })))
    : h('p', { class: 'muted pad', text: 'Nobody is playing.' })));

  // Recent errors
  paint($('dash-errors'), JSON.stringify(overview.errors.slice(0, 12)), () => (overview.errors.length
    ? overview.errors.slice(0, 12).map((line) => {
      const game = line.placeId ? placeById(line.placeId) : null;
      return h('div', { class: 'err-row' },
        h('span', { class: 'at', text: ago(line.at), title: line.at }),
        game ? link(game.name, `games/${game.placeId}/log`, 'err-game') : h('span', { class: 'err-game muted', text: line.scope.replace(/\s#[0-9a-f]+$/, '') || 'server' }),
        h('span', { class: 'err-text', text: line.text, title: line.text }));
    })
    : h('p', { class: 'muted pad', text: 'No errors logged.' })));
}

// Players over the last day or week, stacked per Roblox version.
function paintChart(overview) {
  for (const button of document.querySelectorAll('#dash-range button')) button.classList.toggle('active', button.dataset.range === dash.range);
  const box = $('dash-chart');
  const span = dash.range === 'week' ? 7 * 86400000 : 86400000;
  const step = overview.bucketMinutes * 60000;
  const end = Math.floor(Date.now() / step) * step;
  const start = end - span;
  const byTime = new Map(overview.history.map((bucket) => [bucket.t, bucket]));
  // A week is drawn per hour (the busiest 10 minutes of it).
  const group = dash.range === 'week' ? 6 : 1;
  const ids = data.engines.map((engine) => engine.id).filter((id) => overview.history.some((bucket) => bucket.engines && bucket.engines[id]));
  const points = [];
  for (let t = start + step; t <= end; t += step * group) {
    const values = {};
    let any = false;
    for (let i = 0; i < group; i++) {
      const bucket = byTime.get(t + i * step);
      if (!bucket) continue;
      any = true;
      for (const id of ids) values[id] = Math.max(values[id] || 0, (bucket.engines && bucket.engines[id]) || 0);
    }
    points.push({ t, values: any ? values : null });
  }
  const totals = points.map((point) => (point.values ? ids.reduce((sum, id) => sum + point.values[id], 0) : 0));
  const peak = Math.max(4, ...totals);
  const top = Math.ceil(peak / 5) * 5;
  const signature = JSON.stringify([dash.range, ids, totals, points.length && points[points.length - 1].t]);
  if (box.dataset.sig === signature) return;
  box.dataset.sig = signature;

  const W = 1000;
  const H = 220;
  const left = 34;
  const bottom = 22;
  const plotH = H - bottom - 8;
  const x = (i) => left + (i / Math.max(1, points.length - 1)) * (W - left - 6);
  const y = (value) => 8 + plotH - (value / top) * plotH;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'chart-svg', role: 'img', 'aria-label': 'Players over time' });
  for (const value of [0, top / 2, top]) {
    chart.append(svg('line', { x1: left, x2: W - 6, y1: y(value), y2: y(value), class: 'grid' }));
    chart.append(svg('text', { x: left - 6, y: y(value) + 4, class: 'axis', 'text-anchor': 'end' }, String(value)));
  }
  // Stacked areas, oldest version at the bottom.
  let below = points.map(() => 0);
  for (const id of ids) {
    const above = points.map((point, i) => below[i] + (point.values ? point.values[id] : 0));
    const path = points.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(above[i]).toFixed(1)}`).join('')
      + points.map((point, i) => `L${x(points.length - 1 - i).toFixed(1)},${y(below[points.length - 1 - i]).toFixed(1)}`).join('') + 'Z';
    chart.append(svg('path', { d: path, class: `area e${id}` }));
    below = above;
  }
  // Hours or days along the bottom.
  const labels = dash.range === 'week' ? 7 : 6;
  for (let i = 0; i <= labels; i++) {
    const t = start + (span / labels) * i;
    const date = new Date(t);
    const text = dash.range === 'week' ? date.toLocaleDateString([], { weekday: 'short' }) : date.toLocaleTimeString([], { hour: 'numeric' });
    chart.append(svg('text', { x: left + ((W - left - 6) / labels) * i, y: H - 5, class: 'axis', 'text-anchor': i === 0 ? 'start' : i === labels ? 'end' : 'middle' }, text));
  }
  const hover = svg('line', { class: 'hover-line', y1: 8, y2: 8 + plotH, x1: 0, x2: 0, visibility: 'hidden' });
  chart.append(hover);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  chart.addEventListener('mousemove', (event) => {
    const rect = chart.getBoundingClientRect();
    const fx = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((fx - left) / (W - left - 6)) * (points.length - 1))));
    const point = points[i];
    hover.setAttribute('x1', x(i));
    hover.setAttribute('x2', x(i));
    hover.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.replaceChildren(h('b', { text: dash.range === 'week' ? new Date(point.t).toLocaleString([], { weekday: 'short', hour: 'numeric' }) : new Date(point.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
      ...(point.values ? ids.slice().reverse().map((id) => h('div', {}, h('i', { class: `swatch e${id}` }), `${engineLabel(id)}: ${point.values[id]}`)) : [h('div', { class: 'muted', text: 'Server off' })]));
    const tipX = (x(i) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - 140, Math.max(0, tipX + 12))}px`;
  });
  chart.addEventListener('mouseleave', () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); });
  const legend = h('div', { class: 'legend' }, ids.map((id) => h('span', {}, h('i', { class: `swatch e${id}` }), engineLabel(id))),
    h('span', { class: 'muted' }, `Peak ${Math.max(0, ...totals)}`));
  box.replaceChildren(chart, tip, legend);
}

views.dashboard = {
  show() { renderDash(); },
  render(what) { if (['overview', 'places', 'missing', 'search', 'reports', 'serverInfo'].includes(what)) renderDash(); },
};

document.addEventListener('DOMContentLoaded', () => {
  for (const button of document.querySelectorAll('#dash-range button')) {
    button.addEventListener('click', () => { dash.range = button.dataset.range; if (data.overview) paintChart(data.overview); });
  }
});
