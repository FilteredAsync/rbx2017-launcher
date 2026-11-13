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
const routes = require('./lib/routes');
const www = require('./lib/www');

const LOG_DIR = path.join(__dirname, 'logs');
const PID_FILE = path.join(__dirname, 'server.pid');
const MAX_BODY = 256 * 1024 * 1024; // place uploads can be large

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
  return String(url).replace(/([?&](?:t|suggest|ticket)=)[^&#]*/gi, '$1…');
}

function accessLog(ctx, status, bytes, started) {
  const line = `${ctx.remote} "${ctx.method} ${loggedUrl(ctx.req.url)} HTTP/${ctx.req.httpVersion}" ${status} ${bytes} ${Date.now() - started}ms`;
  core.appendLog(path.join(LOG_DIR, 'access.log'), `${core.gmdate()}  ${line}`, 5 * 1024 * 1024);
}

function readBody(req) {
  let promise = null;
  return () => {
    if (promise === null) {
      promise = new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_BODY) chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(Buffer.concat(chunks)));
      });
    }
    return promise;
  };
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
  const ctx = {
    req,
    res,
    method: req.method,
    // "//game/players/1/" and "\" separators are treated like Apache did.
    path: decodedPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\//, ''),
    query,
    queryLower: core.lowerKeys(query),
    body: readBody(req),
    remote: req.socket.remoteAddress || '-',
  };

  res.on('finish', () => accessLog(ctx, res.statusCode, ctx.method === 'HEAD' ? 0 : (ctx.bytes || 0), started));

  try {
    for (const [pattern, handler] of routes.ROUTES) {
      const match = pattern.exec(ctx.path);
      if (match) {
        await handler(ctx, match);
        return;
      }
    }
    if (!www.serve(ctx, routes.send, routes.sendFile, log)) {
      routes.send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    }
  } catch (error) {
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
