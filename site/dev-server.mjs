// Local preview of the site, close to how Cloudflare Pages serves it:
// public/ with clean URLs (/games -> games.html), _headers for every static
// file, 404.html for missing pages, and the functions/ routes run in Node.
// The functions talk to the live game server unless GAME_SERVER says
// otherwise. There is no edge cache here, so every /api call goes through.
//
//   node site/dev-server.mjs [port]        (default 8788)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.argv[2]) || 8788;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp',
};

// Only the "/*" block of _headers: the site has no other.
function staticHeaders() {
  const headers = {};
  let on = false;
  for (const line of fs.readFileSync(path.join(PUBLIC, '_headers'), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { on = line.trim() === '/*'; continue; }
    const at = line.indexOf(':');
    if (on && at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

function fileFor(pathname) {
  const clean = decodeURIComponent(pathname).replace(/\\/g, '/');
  if (clean.split('/').some((part) => part === '..' || part.startsWith('_'))) return null;
  const candidates = clean === '/' ? ['index.html'] : clean.endsWith('/') ? [] : [clean.slice(1), `${clean.slice(1)}.html`];
  for (const candidate of candidates) {
    const file = path.join(PUBLIC, candidate);
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function serveStatic(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('.html') && url.pathname !== '/404.html') {
    return new Response(null, { status: 308, headers: { Location: url.pathname.slice(0, -5) || '/' } });
  }
  const file = fileFor(url.pathname);
  const status = file ? 200 : 404;
  const chosen = file || path.join(PUBLIC, '404.html');
  return new Response(fs.readFileSync(chosen), {
    status,
    headers: Object.assign({ 'Content-Type': TYPES[path.extname(chosen)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, staticHeaders()),
  });
}

const ROUTES = [
  [/^\/api\/(.+)$/, 'functions/api/[[path]].js'],
  [/^\/games\/(.+)$/, 'functions/games/[[path]].js'],
  [/^\/download\/latest$/, 'functions/download/latest.js'],
];

async function handle(request) {
  const url = new URL(request.url);
  for (const [pattern, file] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const module = await import(pathToFileURL(path.join(ROOT, file)).href);
    const context = {
      request,
      params: { path: match[1] ? match[1].split('/') : [] },
      env: {
        GAME_SERVER: process.env.GAME_SERVER,
        ASSETS: { fetch: (target) => serveStatic(new Request(new URL(String(target.url || target), url))) },
      },
      waitUntil() {},
      next: () => serveStatic(request),
    };
    return module.onRequest(context);
  }
  return serveStatic(request);
}

http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers });
    const response = await handle(request);
    const body = req.method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(body);
    console.log(`${req.method} ${req.url} ${response.status} ${Date.now() - started}ms`);
  } catch (error) {
    console.error(`${req.method} ${req.url} failed:`, error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('dev server error');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`rbx2017 site preview: http://localhost:${PORT}`));
