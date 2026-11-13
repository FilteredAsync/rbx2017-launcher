'use strict';

// Local forwarding proxy for multiplayer. The 2017 client and RCC only ever
// talk to http://localhost./ (and RCC to http://www.localhost./), so on a
// player's or host's PC this listens on port 80 and forwards every request
// to the central web server (for example its playit TCP address).

const http = require('http');
const https = require('https');
const net = require('net');

function normalizeCentralUrl(text) {
  let value = String(text || '').trim();
  if (value === '') return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    return null;
  }
}

function isLoopbackHost(host) {
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127\./.test(bare);
}

// One of this PC's own addresses (e.g. its Tailscale or LAN IP)?
function isOwnAddress(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!net.isIP(bare)) return false;
  const os = require('os');
  return Object.values(os.networkInterfaces()).some((addresses) =>
    (addresses || []).some((address) => address.address.toLowerCase() === bare));
}

// True when the central server is this PC's own web server on port 80, in
// which case no proxy is needed (and port 80 is already taken by it). That
// includes this PC's own Tailscale/LAN address, as used on the hosting PC.
function centralIsLocalPort80(centralUrl) {
  const url = new URL(centralUrl);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return url.protocol === 'http:' && port === 80 && (isLoopbackHost(url.hostname) || isOwnAddress(url.hostname));
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen({ port, host, ipv6Only: host.includes(':') });
  });
}

// Starts the proxy on 127.0.0.1 and [::1] (port 80 unless testing with
// LEGACY_PROXY_PORT). Resolves to { close() }.
async function startProxy(centralUrl, log, listenPort) {
  const port = listenPort || Number(process.env.LEGACY_PROXY_PORT) || 80;
  const target = new URL(centralUrl);
  const client = target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 32 });
  const targetPort = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port);

  const handler = (req, res) => {
    const headers = Object.assign({}, req.headers, { host: target.host });
    delete headers.connection;
    const upstream = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
      agent,
    }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', (error) => {
      if (log) log(`proxy: ${req.method} ${req.url} failed: ${error.code || error.message}`);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Could not reach the web server at ${centralUrl}: ${error.code || error.message}`);
    });
    req.pipe(upstream);
  };

  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const server = http.createServer(handler);
    const error = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen({ port, host, ipv6Only: host.includes(':') }, () => resolve(null));
    });
    if (error) {
      if (host === '127.0.0.1') {
        for (const started of servers) started.close();
        const reason = error.code === 'EADDRINUSE'
          ? `port ${port} is already in use on this PC (a local web server? run killWeb.bat)`
          : error.code || error.message;
        throw new Error(`could not start the local proxy: ${reason}`);
      }
      continue; // IPv6 loopback unavailable: IPv4 is enough.
    }
    servers.push(server);
  }
  return {
    close() {
      for (const server of servers) server.close();
      agent.destroy();
    },
  };
}

module.exports = { normalizeCentralUrl, centralIsLocalPort80, isLoopbackHost, portFree, startProxy };
