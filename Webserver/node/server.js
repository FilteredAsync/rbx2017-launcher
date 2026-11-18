#!/usr/bin/env node
'use strict';

// Local web server for the 2017 Roblox client, RCC and Studio.
// Replaces UwAmp (Apache + PHP + MySQL): no dependencies, Node.js 18+,
// runs on Windows and Linux.
//
//   node Webserver/node/server.js
//
// Settings: RobloxClient/config/server.json (see config/README.txt).
// Environment overrides: LEGACY_WEB_PORT, LEGACY_WEB_HTTPS_PORT (0 = off),
// LEGACY_WEB_HOSTS (comma-separated).

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const core = require('./lib/core');
const datastore = require('./lib/datastore');
const games = require('./lib/games');
const publicnet = require('./lib/publicnet');
const sitekey = require('./lib/sitekey');
const routes = require('./lib/routes');
const www = require('./lib/www');

const LOG_DIR = path.join(__dirname, 'logs');
const PID_FILE = path.join(__dirname, 'server.pid');
// ctx.body(limit): each route passes its own; only place uploads take up to 1 GB.
const DEFAULT_BODY_LIMIT = 1024 * 1024;
// After a 413, what is still coming is read and dropped, up to these.
const DRAIN_BYTES = 32 * 1024 * 1024;
const DRAIN_MS = 10 * 1000;

const SERVER_DEFAULTS = {
  hosts: ['127.0.0.1', '::1'],
  port: 80,
  httpsPort: 443,
  httpsCert: 'Webserver/bin/apache/certificats/main-server.com.cert',
  httpsKey: 'Webserver/bin/apache/certificats/main-server.com.key',
};

function settings() {
  const value = core.settingsFile(core.rootPath('config', 'server.json'), SERVER_DEFAULTS);
  const result = Object.assign({}, value);
  if (process.env.LEGACY_WEB_PORT) result.port = Number(process.env.LEGACY_WEB_PORT);
  if (process.env.LEGACY_WEB_HTTPS_PORT !== undefined) result.httpsPort = Number(process.env.LEGACY_WEB_HTTPS_PORT);
  if (process.env.LEGACY_WEB_HOSTS) result.hosts = process.env.LEGACY_WEB_HOSTS.split(',').map((host) => host.trim()).filter(Boolean);
  if (!Array.isArray(result.hosts) || result.hosts.length === 0) result.hosts = SERVER_DEFAULTS.hosts;
  return result;
}

function log(message) {
  const line = `${core.gmdate()}  ${message}`;
  console.log(line);
  core.appendLog(path.join(LOG_DIR, 'server.log'), line, 5 * 1024 * 1024);
}

// Login tickets and Studio edit tokens stay out of the log.
function loggedUrl(url) {
  // password: the Xbox app signs in with ?username=&password= (lib/xbox.js).
  return String(url).replace(/([?&](?:t|suggest|ticket|password)=)[^&#]*/gi, '$1…');
}

function accessLog(ctx, status, bytes, started) {
  const line = `${ctx.remote} "${ctx.method} ${loggedUrl(ctx.req.url)} HTTP/${ctx.req.httpVersion}" ${status} ${bytes} ${Date.now() - started}ms`;
  core.appendLog(path.join(LOG_DIR, 'access.log'), `${core.gmdate()}  ${line}`, 5 * 1024 * 1024);
}

function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

function bodyError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.requestBody = true;
  return error;
}

// ctx.body(limit): the request body, read once. Past `limit` bytes (by
// Content-Length or as it arrives) it rejects with 413, which handle()
// answers. A body cut off midway rejects too.
function readBody(req) {
  let promise = null;
  return (limit = DEFAULT_BODY_LIMIT) => {
    if (promise === null) {
      promise = new Promise((resolve, reject) => {
        const tooLarge = () => bodyError(413, `That is too large to send here (the limit is ${sizeText(limit)}).`);
        if (Number(req.headers['content-length']) > limit) {
          reject(tooLarge());
          return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        };
        req.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > limit) {
            chunks.length = 0;
            finish(tooLarge());
          } else chunks.push(chunk);
        });
        req.on('end', () => finish(null, Buffer.concat(chunks)));
        req.on('error', () => finish(bodyError(400, 'The request was cut off.')));
        req.on('close', () => finish(bodyError(400, 'The request was cut off.')));
      });
    }
    return promise;
  };
}

// A body over its limit: answered at once (JSON for /api). A client still
// sending only sees that answer if the connection is not reset under it, so
// the rest is read and dropped, up to DRAIN_BYTES for DRAIN_MS; past that the
// connection closes. A body cut off midway: the connection is gone already.
function bodyFailed(ctx, error) {
  const { req, res } = ctx;
  if (error.status !== 413 || res.headersSent || res.destroyed || !req.socket || req.socket.destroyed) {
    res.destroy();
    return;
  }
  let dropped = 0;
  const timer = setTimeout(() => req.destroy(), DRAIN_MS);
  const stop = () => clearTimeout(timer);
  req.on('data', (chunk) => {
    dropped += chunk.length;
    if (dropped > DRAIN_BYTES) {
      stop();
      req.destroy();
    }
  });
  req.on('end', stop);
  req.on('close', stop);
  req.resume();
  const json = /^api\//i.test(ctx.path);
  routes.send(ctx, 413, {
    'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, json ? JSON.stringify({ error: error.message }) : error.message);
}

async function handle(req, res) {
  const started = Date.now();
  const url = req.url || '/';
  const queryAt = url.indexOf('?');
  const rawPath = queryAt < 0 ? url : url.slice(0, queryAt);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch (error) {
    decodedPath = rawPath;
  }
  const query = core.parseQuery(queryAt < 0 ? '' : url.slice(queryAt + 1));
  // Through the VPS relay: the player's own address and the public name (lib/publicnet.js).
  const via = publicnet.requestInfo(req);
  const ctx = {
    req,
    res,
    method: req.method,
    // "//game/players/1/" and "\" separators are treated like Apache did.
    path: decodedPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\//, ''),
    query,
    queryLower: core.lowerKeys(query),
    body: readBody(req),
    // The website's requests stand for its visitor (lib/sitekey.js).
    remote: sitekey.clientAddress(req, via.remote),
    publicHost: via.publicHost,
  };

  res.on('finish', () => accessLog(ctx, res.statusCode, ctx.method === 'HEAD' ? 0 : (ctx.bytes || 0), started));

  try {
    // The Android app (m.<domain>) gets its own pages first (lib/mobile.js).
    const mobile = routes.isMobile(ctx);
    for (const [pattern, handler] of mobile ? routes.MOBILE_ROUTES.concat(routes.ROUTES) : routes.ROUTES) {
      const match = pattern.exec(ctx.path);
      if (match) {
        await handler(ctx, match);
        return;
      }
    }
    if (!www.serve(ctx, routes.send, routes.sendFile, log)) {
      if (mobile && ctx.method === 'GET' && /text\/html/.test(String(req.headers.accept || ''))) routes.mobileNotHere(ctx);
      else routes.send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    }
  } catch (error) {
    if (error && error.requestBody) {
      bodyFailed(ctx, error);
      return;
    }
    log(`error handling ${ctx.method} ${url}: ${error && error.stack ? error.stack : error}`);
    if (!res.headersSent) routes.send(ctx, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
    else res.destroy();
  }
}

// Requests Node refuses to parse never reach handle(); log them so a client
// that silently gets "400 Bad Request" is visible.
function watchClientErrors(server) {
  server.on('clientError', (error, socket) => {
    const raw = error && error.rawPacket ? error.rawPacket.toString('latin1').slice(0, 400) : '';
    if (error && error.code !== 'ECONNRESET') {
      log(`rejected request from ${socket.remoteAddress || '-'}: ${error.code || error.message} ${JSON.stringify(raw)}`);
    }
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
}

function listen(server, port, host, label) {
  watchClientErrors(server);
  return new Promise((resolve) => {
    server.once('error', (error) => resolve(error));
    server.listen({ port, host, ipv6Only: host.includes(':') }, () => resolve(null));
  }).then((error) => {
    if (error === null) log(`listening on ${label}://${host.includes(':') ? `[${host}]` : host}:${port}`);
    return error;
  });
}

// "tailscale" in the hosts list means this PC's Tailscale address, so
// friends on your tailnet can reach the server. Skipped (with a note) while
// Tailscale is not connected; restart the web server after connecting.
function resolveHosts(hosts) {
  const resolved = [];
  for (const host of hosts) {
    if (String(host).toLowerCase() !== 'tailscale') {
      resolved.push(host);
      continue;
    }
    const address = core.tailscaleIPv4();
    if (address) resolved.push(address);
    else log('tailscale: not connected, so not listening on it (connect Tailscale, then restart the web server)');
  }
  // The VPS relay's WireGuard tunnel (tools/vps), when this PC has one.
  const tunnel = publicnet.tunnelAddress();
  if (tunnel) resolved.push(tunnel);
  return [...new Set(resolved)];
}

async function main() {
  const config = settings();
  config.hosts = resolveHosts(config.hosts);
  const servers = [];
  let primaryBound = false;

  for (const host of config.hosts) {
    const server = http.createServer(handle);
    server.keepAliveTimeout = 5000;
    const error = await listen(server, config.port, host, 'http');
    if (error) {
      const hint = error.code === 'EADDRINUSE'
        ? ' (port in use: is UwAmp/Apache still running? Run killWeb.bat)'
        : error.code === 'EACCES' ? ' (no permission for this port; on Linux use a port above 1023 or run as root)' : '';
      log(`could not listen on http ${host}:${config.port}: ${error.code || error.message}${hint}`);
      continue;
    }
    primaryBound = true;
    servers.push(server);
  }
  if (!primaryBound) {
    log('no HTTP listener could be started; exiting');
    process.exit(1);
  }

  if (config.httpsPort > 0) {
    const certFile = path.resolve(core.ROOT, config.httpsCert);
    const keyFile = path.resolve(core.ROOT, config.httpsKey);
    if (core.isFile(certFile) && core.isFile(keyFile)) {
      for (const host of config.hosts) {
        const server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handle);
        // A client that rejects the certificate never sends a request, so
        // log failed handshakes (with the host name it asked for).
        server.on('tlsClientError', (error, socket) => {
          log(`https handshake failed from ${socket.remoteAddress || '-'} for "${socket.servername || ''}": ${error.code || error.message}`);
        });
        const error = await listen(server, config.httpsPort, host, 'https');
        if (error) log(`https on ${host}:${config.httpsPort} not available: ${error.code || error.message}`);
        else servers.push(server);
      }
    } else {
      log('https is off: certificate or key file not found');
    }
  }

  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (error) { /* read-only folder */ }
  log(`web root ${core.WWW}`);
  try {
    games.ensureHostKey();
    log('multiplayer: hosts register games with the key in config/host-key.txt');
  } catch (error) {
    log(`multiplayer: could not create config/host-key.txt (${error.message}); hosting is disabled`);
  }

  const shutdown = () => {
    log('stopping');
    datastore.flushAll();
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch (error) { /* already gone */ }
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`Node.js 18 or newer is required (this is ${process.version}).`);
  process.exit(1);
}
main();
