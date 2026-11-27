'use strict';

// Performance: the server PC's CPU, GPU, RAM, temperatures, network, players,
// games and RCC over the last hour (lib/hoststats.js samples every 10 s).

const perf = {
  range: 60,           // minutes shown
  samples: [],         // oldest first
  info: null,
  interval: 10000,
  keep: 360,
  last: 0,             // newest sample's time: the next load asks for what came after
  error: null,
  loading: false,
  hoverX: null,        // 0..1 across a plot while the pointer is on one
  hoverChart: null,
};

const GB = 1073741824;
const gb = (bytes) => `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`;
function bits(bytesPerSecond) {
  const value = bytesPerSecond * 8;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} Gbps`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)} Mbps`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} Kbps`;
  return `${Math.round(value)} bps`;
}
const percent = (value) => `${Math.round(value)}%`;
const degrees = (value) => `${Math.round(value)} °C`;
const count = (value) => String(value);
// A round axis top: 1, 2, 5, 10, 20, 50 ...
function niceTop(peak, floor) {
  const value = Math.max(peak, floor);
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * power).find((top) => top >= value - 1e-9);
}
const peakOf = (list, key) => list.reduce((most, item) => (Number.isFinite(item[key]) && item[key] > most ? item[key] : most), -Infinity);

// One card per chart. series: sample keys (each a line); sub(sample, info, list) is the line under the value.
const PERF_CHARTS = [
  { id: 'cpu', label: 'CPU', series: ['cpu'], format: percent, top: () => 100,
    sub: (sample, info) => (info.cores ? plural(info.cores, 'core') : ''), missing: "Can't read it" },
  { id: 'gpu', label: 'GPU', series: ['gpu'], format: percent, top: () => 100,
    sub: (sample, info) => (sample && Number.isFinite(sample.vram) && info.vramTotal ? `VRAM ${gb(sample.vram)} of ${gb(info.vramTotal)}` : ''),
    missing: 'No GPU counters' },
  { id: 'ram', label: 'RAM', series: ['ram'], format: gb, top: (peak, info) => info.ramTotal || peak,
    sub: (sample, info) => (info.ramTotal ? `of ${gb(info.ramTotal)}` : ''), missing: "Can't read it" },
  { id: 'cpuTemp', label: 'CPU temp', series: ['cpuTemp'], format: degrees, top: (peak) => Math.max(100, peak),
    sub: (sample, info, list) => peakText(list, 'cpuTemp', degrees), missing: 'Needs LibreHardwareMonitor', from: 'cpuTemp' },
  { id: 'gpuTemp', label: 'GPU temp', series: ['gpuTemp'], format: degrees, top: (peak) => Math.max(100, peak),
    sub: (sample, info, list) => peakText(list, 'gpuTemp', degrees), missing: 'Needs nvidia-smi or LibreHardwareMonitor', from: 'gpuTemp' },
  { id: 'net', label: 'Network', series: ['netIn', 'netOut'], names: ['In', 'Out'], marks: ['↓', '↑'], format: bits,
    top: (peak) => niceTop(peak * 8, 1e5) / 8, missing: "Can't read it" },
  { id: 'players', label: 'Players', series: ['players'], format: count, top: (peak) => niceTop(peak, 5),
    sub: (sample, info, list) => peakText(list, 'players', count), missing: 'Server off' },
  { id: 'games', label: 'Games', series: ['games'], format: count, top: (peak) => niceTop(peak, 5),
    sub: (sample) => (sample && Number.isFinite(sample.servers) ? plural(sample.servers, 'server') : ''), missing: 'Server off' },
  { id: 'rcc', label: 'RCC', series: ['rcc'], format: count, top: (peak) => niceTop(peak, 5),
    sub: (sample) => (sample && Number.isFinite(sample.rccRam) && sample.rcc ? `${gb(sample.rccRam)} RAM` : ''), missing: "Can't read it" },
];

function peakText(list, key, format) {
  const peak = peakOf(list, key);
  return Number.isFinite(peak) ? `Peak ${format(peak)}` : '';
}

// --- loading --------------------------------------------------------------------------------

async function loadPerf(full) {
  if (perf.loading) return;
  perf.loading = true;
  try {
    const result = await getJson(`/api/manage/stats${!full && perf.last ? `?since=${perf.last}` : ''}`);
    perf.info = result.info;
    perf.interval = result.interval || perf.interval;
    perf.keep = result.keep || perf.keep;
    const incoming = Array.isArray(result.samples) ? result.samples : [];
    perf.samples = full || !perf.last ? incoming : perf.samples.concat(incoming);
    const oldest = Date.now() - perf.keep * perf.interval - 60000;
    while (perf.samples.length && perf.samples[0].t < oldest) perf.samples.shift();
    if (perf.samples.length) perf.last = perf.samples[perf.samples.length - 1].t;
    perf.error = null;
  } catch (error) {
    perf.error = error.message;
  } finally {
    perf.loading = false;
  }
  renderPerf();
}

// --- drawing --------------------------------------------------------------------------------

function perfWindow() {
  const end = perf.samples.length ? perf.samples[perf.samples.length - 1].t : Date.now();
  const start = end - perf.range * 60000;
  return { start, end, list: perf.samples.filter((item) => item.t > start - perf.interval) };
}

// The sample nearest to a spot across the plot (0..1).
function sampleAt(list, start, end, fraction) {
  const t = start + fraction * (end - start);
  let best = null;
  for (const item of list) if (!best || Math.abs(item.t - t) < Math.abs(best.t - t)) best = item;
  return best;
}

const timeText = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function renderPerf() {
  for (const button of document.querySelectorAll('#perf-range button')) button.classList.toggle('active', Number(button.dataset.range) === perf.range);
  const info = perf.info;
  const grid = $('perf-grid');
  const { start, end, list } = perfWindow();
  const hovered = perf.hoverX !== null && list.length ? sampleAt(list, start, end, perf.hoverX) : null;
  $('perf-sub').textContent = perf.error
    || (hovered ? `At ${timeText(hovered.t)}` : info ? [info.cpuName, info.gpuName].filter(Boolean).join(' · ') : '');
  if (!info) return;
  if (!grid.children.length) {
    grid.replaceChildren(...PERF_CHARTS.map((chart) => {
      const plot = h('div', { class: 'perf-plot' });
      plot.addEventListener('pointermove', (event) => {
        const rect = plot.getBoundingClientRect();
        perf.hoverX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        perf.hoverChart = chart.id;
        renderPerf();
      });
      plot.addEventListener('pointerleave', () => {
        perf.hoverX = null;
        perf.hoverChart = null;
        renderPerf();
      });
      return h('div', { class: 'card perf-card', dataset: { chart: chart.id } },
        h('div', { class: 'perf-head' }, h('span', { class: 'perf-label', text: chart.label }), h('span', { class: 'perf-value' })),
        h('div', { class: 'perf-sub' }),
        plot);
    }));
  }
  const latest = list.length ? list[list.length - 1] : null;
  for (const chart of PERF_CHARTS) {
    const card = grid.querySelector(`[data-chart="${chart.id}"]`);
    const shown = hovered || latest;
    const values = chart.series.map((key) => (shown && Number.isFinite(shown[key]) ? shown[key] : null));
    const none = values.every((value) => value === null);
    const value = card.querySelector('.perf-value');
    value.classList.toggle('na', none);
    value.classList.toggle('multi', chart.series.length > 1 && !none);
    if (none) value.replaceChildren('n/a');
    else if (chart.series.length > 1) {
      value.replaceChildren(...chart.series.map((key, i) => h('span', { title: chart.names[i] }, h('i', { class: `key s${i}` }), `${chart.marks[i]} ${values[i] === null ? 'n/a' : chart.format(values[i])}`)));
    } else value.replaceChildren(chart.format(values[0]));
    const from = chart.from && info.sources ? info.sources[chart.from] : null;
    card.title = from ? `From ${from}` : '';
    const sub = card.querySelector('.perf-sub');
    if (chart.series.length > 1) {
      sub.replaceChildren(...chart.series.map((key, i) => h('span', { class: 'perf-key' }, h('i', { class: `key s${i}` }), chart.names[i])),
        ...(none && !hovered ? [h('span', { text: chart.missing })] : []));
    } else {
      sub.textContent = none && !hovered ? chart.missing : chart.sub ? chart.sub(shown, info, list) : '';
    }
    drawPerfChart(card.querySelector('.perf-plot'), chart, list, start, end, hovered);
  }
}

function drawPerfChart(box, chart, list, start, end, hovered) {
  const W = Math.max(160, Math.round(box.clientWidth || 300));
  const H = 92;
  const topPad = 16;
  const plotH = H - topPad - 2;
  let peak = 0;
  for (const key of chart.series) peak = Math.max(peak, peakOf(list, key));
  const top = chart.top(Math.max(0, peak), perf.info) || 1;
  const x = (t) => ((t - start) / (end - start)) * W;
  const y = (value) => topPad + plotH - (Math.max(0, Math.min(value, top)) / top) * plotH;
  const chartSvg = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'perf-svg', role: 'img', 'aria-label': `${chart.label}, last ${perf.range} minutes` });
  chartSvg.append(
    svg('line', { x1: 0, x2: W, y1: y(top), y2: y(top), class: 'grid' }),
    svg('line', { x1: 0, x2: W, y1: y(0), y2: y(0), class: 'base' }),
    svg('text', { x: 0, y: 11, class: 'axis' }, chart.format(top)),
  );
  chart.series.forEach((key, index) => {
    // Runs of samples in a row; a missing one or a gap (server restart) breaks the line.
    const runs = [];
    let run = [];
    let before = null;
    for (const item of list) {
      const value = item[key];
      const gap = before !== null && item.t - before > perf.interval * 2.5;
      if ((gap || !Number.isFinite(value)) && run.length) { runs.push(run); run = []; }
      if (Number.isFinite(value)) run.push([x(item.t), y(value)]);
      before = item.t;
    }
    if (run.length) runs.push(run);
    for (const points of runs) {
      if (points.length === 1) {
        chartSvg.append(svg('circle', { cx: points[0][0], cy: points[0][1], r: 2, class: `perf-dot s${index}` }));
        continue;
      }
      const line = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
      if (chart.series.length === 1) {
        chartSvg.append(svg('path', { d: `${line}L${points[points.length - 1][0].toFixed(1)},${y(0)}L${points[0][0].toFixed(1)},${y(0)}Z`, class: 'perf-area' }));
      }
      chartSvg.append(svg('path', { d: line, class: `perf-line s${index}` }));
    }
  });
  let tip = null;
  if (hovered) {
    const hx = x(hovered.t);
    chartSvg.append(svg('line', { x1: hx, x2: hx, y1: topPad, y2: y(0), class: 'hover-line' }));
    chart.series.forEach((key, index) => {
      if (Number.isFinite(hovered[key])) chartSvg.append(svg('circle', { cx: hx, cy: y(hovered[key]), r: 4, class: `perf-dot ring s${index}` }));
    });
    if (perf.hoverChart === chart.id) {
      tip = h('div', { class: 'chart-tip perf-tip' },
        ...chart.series.map((key, index) => h('div', {},
          chart.series.length > 1 ? h('i', { class: `key s${index}` }) : null,
          h('b', { text: Number.isFinite(hovered[key]) ? chart.format(hovered[key]) : 'n/a' }),
          chart.series.length > 1 ? ` ${chart.names[index]}` : null)),
        h('div', { class: 'muted', text: timeText(hovered.t) }));
      const left = (hx / W) * box.clientWidth;
      tip.style.left = `${Math.max(0, Math.min(box.clientWidth - 130, left + 12))}px`;
    }
  }
  box.replaceChildren(...[chartSvg, tip].filter(Boolean));
}

views.performance = {
  show() { renderPerf(); loadPerf(!perf.samples.length); },
  tick(current) { if (current === 'performance') loadPerf(false); },
};

let perfResize = null;
window.addEventListener('resize', () => {
  clearTimeout(perfResize);
  perfResize = setTimeout(() => { if (view === 'performance') renderPerf(); }, 150);
});

document.addEventListener('DOMContentLoaded', () => {
  for (const button of document.querySelectorAll('#perf-range button')) {
    button.addEventListener('click', () => { perf.range = Number(button.dataset.range); renderPerf(); });
  }
});
