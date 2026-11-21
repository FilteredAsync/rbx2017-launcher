'use strict';

// Compares runs of the API test place (tools/make-api-test-place.js) and
// writes one HTML page: counts per run, the newer APIs and classes with what
// each run said, and every 2017-API check whose answer differs between runs.
//
//   node tools/api-test-report.js <out.html> <results.json> [<results.json> ...]
//
// Each results file is the JSON a run left in ReplicatedStorage.ApiTestResults
// (Server / Client) or warn()ed as APITEST chunks: { where, version, seconds, results }.

const fs = require('fs');
const path = require('path');

const [outFile, ...inputs] = process.argv.slice(2);
if (!outFile || !inputs.length) {
  console.error('usage: node tools/api-test-report.js <out.html> <results.json> ...');
  process.exit(1);
}
const runs = inputs.map((file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { name: String(data.where || path.basename(file, '.json')), version: String(data.version || '?').replace(/\s+/g, ''), seconds: data.seconds, results: data.results };
});

const KINDS = [
  ['modern', 'Newer APIs'], ['newClasses', 'Newer classes'], ['classes', '2017 classes'],
  ['properties', '2017 properties'], ['functions', '2017 functions'], ['events', '2017 events'],
];
const passed = (value) => value === true || value === 'service' || (typeof value === 'string' && value.startsWith('via '));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cell(value) {
  if (value === undefined) return '<td class="na" title="Not checked here">–</td>';
  if (passed(value)) return `<td class="ok" title="${esc(value === true ? 'Works' : value)}">✓</td>`;
  return `<td class="bad" title="${esc(value)}">✗<span>${esc(value)}</span></td>`;
}

function summary() {
  const head = `<tr><th>Run</th>${KINDS.map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
  const rows = runs.map((run) => `<tr><th>${esc(run.name)}<small>${esc(run.version)}${run.seconds ? ` · ${Number(run.seconds).toFixed(1)} s` : ''}</small></th>${KINDS.map(([kind]) => {
    const entries = Object.values(run.results[kind] || {});
    const ok = entries.filter(passed).length;
    return `<td><b>${ok}</b> / ${entries.length}</td>`;
  }).join('')}</tr>`).join('');
  return `<table class="summary">${head}${rows}</table>`;
}

function keysOf(kind) {
  const keys = new Set();
  for (const run of runs) for (const key of Object.keys(run.results[kind] || {})) keys.add(key);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

// The newer APIs: everything, missing ones first.
function newer(kind, title, note) {
  const keys = keysOf(kind);
  const score = (key) => runs.filter((run) => passed((run.results[kind] || {})[key])).length;
  keys.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  const working = keys.filter((key) => runs.every((run) => (run.results[kind] || {})[key] === undefined || passed(run.results[kind][key]))).length;
  const rows = keys.map((key) => `<tr><th>${esc(key)}</th>${runs.map((run) => cell((run.results[kind] || {})[key])).join('')}</tr>`).join('');
  return `<section><h2>${title}</h2><p>${note} ${working} of ${keys.length} work in every run.</p>
<table class="grid"><tr><th></th>${runs.map((run) => `<th>${esc(run.name)}</th>`).join('')}</tr>${rows}</table></section>`;
}

// 2017-API checks whose answers differ between runs.
function differences() {
  const rows = [];
  for (const [kind, label] of KINDS.slice(2)) {
    for (const key of keysOf(kind)) {
      const values = runs.map((run) => (run.results[kind] || {})[key]);
      const states = new Set(values.filter((v) => v !== undefined).map((v) => (passed(v) ? 'ok' : 'bad')));
      if (states.size > 1) rows.push(`<tr><th>${esc(key)}<small>${label}</small></th>${values.map(cell).join('')}</tr>`);
    }
  }
  return `<section><h2>Where the 2017 API answers differently</h2><p>${rows.length} checks from the 2017 client's API dump work in some runs and not in others.</p>
<table class="grid"><tr><th></th>${runs.map((run) => `<th>${esc(run.name)}</th>`).join('')}</tr>${rows.join('')}</table></section>`;
}

// 2017-API checks that fail everywhere (in the dump, but not usable from a game script).
function failingEverywhere() {
  const rows = [];
  for (const [kind, label] of KINDS.slice(2)) {
    for (const key of keysOf(kind)) {
      const values = runs.map((run) => (run.results[kind] || {})[key]).filter((v) => v !== undefined);
      if (values.length && values.every((v) => !passed(v)) && !values.every((v) => v === 'notCreatable')) {
        rows.push(`<tr><th>${esc(key)}<small>${label}</small></th><td class="msg">${esc(values[0])}</td></tr>`);
      }
    }
  }
  return `<section><h2>In the 2017 dump but failing everywhere</h2><p>${rows.length} checks. Mostly abstract classes, which are tried on a subclass instead.</p>
<table class="grid"><tr><th></th><th>First answer</th></tr>${rows.join('')}</table></section>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>API test report</title>
<style>
:root { --bg: #f4f5f7; --panel: #fff; --text: #1d2125; --muted: #6b7280; --line: #e3e5e8; --ok: #12805c; --okbg: #e6f6ee; --bad: #b42318; --badbg: #fdecea; }
@media (prefers-color-scheme: dark) { :root { --bg: #15181c; --panel: #1e2227; --text: #e8eaed; --muted: #9aa0a6; --line: #30353b; --ok: #4cc38a; --okbg: #15352a; --bad: #ff7b72; --badbg: #3d1d1d; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 60px; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 0 0 6px; }
p { color: var(--muted); margin: 0 0 12px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-top: 16px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; font-size: 13px; }
th small { display: block; color: var(--muted); font-weight: 400; }
.summary td { font-size: 14px; } .summary td b { font-size: 16px; }
.grid th:first-child { width: 34%; font-weight: 500; }
td.ok { color: var(--ok); background: var(--okbg); text-align: center; width: 1%; }
td.bad { color: var(--bad); background: var(--badbg); min-width: 120px; }
td.bad span { display: block; font-size: 11px; opacity: .85; }
td.na { color: var(--muted); text-align: center; }
td.msg { color: var(--bad); }
</style></head><body><main>
<h1>API test report</h1>
<p>${runs.length} runs of the API test place. ✓ works, ✗ failed (the answer is under it), – not checked in that run (client-only or server-only checks).</p>
<section><h2>Counts</h2>${summary()}</section>
${newer('modern', 'Newer APIs', 'APIs from 2018 on that converted games use.')}
${newer('newClasses', 'Newer classes', 'Instance.new of classes added after 2017.')}
${differences()}
${failingEverywhere()}
</main></body></html>
`;
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`${outFile}: ${runs.map((run) => run.name).join(', ')}`);
