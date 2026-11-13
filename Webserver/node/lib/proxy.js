'use strict';

// Local forwarding proxy for multiplayer. The 2017 client, RCC and Studio only
// ever talk to localhost. names (http://localhost./, http://www.localhost./,
// and Studio also https://localhost/), so on a player's or host's PC this
// listens on port 80 (and 443 for Studio) and forwards every request to the
// central web server, for example http://100.101.102.103.
//
// It passes the name the program used as X-Forwarded-Host (Studio's links
// and cookies must stay on localhost.), and for Team Create it points Studio
// at a local UDP relay to the server's Team Create game port (the 2017
// engine only connects to game servers on 127.0.0.1; see relay.js).
//
//   startProxy(centralUrl, log, port, { https: true })  -> { close() }
//   acquireProxy(centralUrl, log)  -> { release() }  one shared proxy for the
//       game client and Studio, closed when the last one lets go

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

function listen(server, port, host) {
  return new Promise((resolve) => {
    server.once('error', resolve);
    server.listen({ port, host, ipv6Only: host.includes(':') }, () => resolve(null));
  });
}

// Studio asking for its Team Create server.
function isCloudEditLaunch(url) {
  return /placelauncher\.ashx/i.test(url) && /[?&]request=cloudedit(?:&|$)/i.test(url);
}

// Starts the proxy on 127.0.0.1 and [::1] (port 80 unless testing with
// LEGACY_PROXY_PORT; https on 443, or LEGACY_PROXY_HTTPS_PORT, when asked).
async function startProxy(centralUrl, log, listenPort, options = {}) {
  const port = listenPort || Number(process.env.LEGACY_PROXY_PORT) || 80;
  const httpsPort = Number(process.env.LEGACY_PROXY_HTTPS_PORT) || 443;
  const target = new URL(centralUrl);
  const client = target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 32 });
  const targetPort = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port);
  const relays = new Map(); // "ip:port" -> relay, for Team Create

  async function relayFor(address) {
    let entry = relays.get(address);
    if (!entry) {
      entry = require('./relay').startRelay(address, log);
      relays.set(address, entry);
      entry.catch(() => relays.delete(address));
    }
    return entry;
  }

  // Points the Team Create join details ("settings", and the join script
  // address) at a local relay. Returns the new body, or null to pass as is.
  async function rewriteCloudEdit(body) {
    let data;
    try { data = JSON.parse(body.toString('utf8')); } catch (error) { return null; }
    const settings = data && data.settings;
    if (!data || data.status !== 2 || !settings || !settings.MachineAddress || !settings.ServerPort) return null;
    const relay = await relayFor(`${settings.MachineAddress}:${settings.ServerPort}`);
    settings.MachineAddress = '127.0.0.1';
    settings.ServerPort = relay.port;
    if (typeof data.joinScriptUrl === 'string') {
      data.joinScriptUrl = data.joinScriptUrl.replace(/([?&]ip=)[^&]*/i, '$1127.0.0.1').replace(/([?&]port=)\d+/i, `$1${relay.port}`);
    }
    if (log) log(`Team Create: relaying 127.0.0.1:${relay.port} to ${relay.target}`);
    return Buffer.from(JSON.stringify(data), 'utf8');
  }

  const handlerFor = (secure) => (req, res) => {
    const headers = Object.assign({}, req.headers, {
      host: target.host,
      'x-forwarded-host': req.headers.host || 'localhost.',
      'x-forwarded-proto': secure ? 'https' : 'http',
    });
    delete headers.connection;
    const cloudEdit = isCloudEditLaunch(req.url || '');
    const upstream = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
      agent,
    }, (response) => {
      if (!cloudEdit || response.statusCode !== 200) {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', async () => {
        let body = Buffer.concat(chunks);
        try {
          body = (await rewriteCloudEdit(body)) || body;
        } catch (error) {
          if (log) log(`Team Create: could not start the relay: ${error.message}`);
        }
        const out = Object.assign({}, response.headers, { 'content-length': body.length });
        delete out['transfer-encoding'];
        res.writeHead(200, out);
        res.end(body);
      });
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
    const server = http.createServer(handlerFor(false));
    const error = await listen(server, port, host);
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

  // Studio also uses https://localhost/; it accepts any certificate.
  if (options.https) {
    let tlsFiles = null;
    try {
      tlsFiles = require('./selfcert').load(options.certDir || require('./core').rootPath('config'));
    } catch (error) {
      if (log) log(`proxy: no https (could not make a certificate: ${error.message}); Studio will not work`);
    }
    if (tlsFiles) {
      for (const host of ['127.0.0.1', '::1']) {
        const server = https.createServer({ cert: tlsFiles.cert, key: tlsFiles.key }, handlerFor(true));
        const error = await listen(server, httpsPort, host);
        if (error) {
          if (host === '127.0.0.1' && log) log(`proxy: https port ${httpsPort} is in use, so Studio cannot reach the server (${error.code || error.message})`);
          continue;
        }
        servers.push(server);
      }
    }
  }

  return {
    close() {
      for (const server of servers) server.close();
      agent.destroy();
      for (const entry of relays.values()) entry.then((relay) => relay.close(), () => {});
      relays.clear();
    },
  };
}

// --- one shared proxy --------------------------------------------------------------------
// The game client and Studio can run at the same time and both need port 80.

let shared = null; // { url, ready: Promise<proxy>, holders }

async function acquireProxy(centralUrl, log) {
  if (shared && shared.url !== centralUrl) {
    throw new Error(`already connected to ${shared.url}; close the game and Studio first`);
  }
  if (!shared) {
    const entry = { url: centralUrl, holders: 0, ready: startProxy(centralUrl, log, undefined, { https: true }) };
    shared = entry;
    entry.ready.catch(() => { if (shared === entry) shared = null; });
  }
  const entry = shared;
  entry.holders++;
  try {
    await entry.ready;
  } catch (error) {
    entry.holders--;
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      entry.holders--;
      if (entry.holders === 0 && shared === entry) {
        shared = null;
        entry.ready.then((proxy) => proxy.close(), () => {});
      }
    },
  };
}

module.exports = { normalizeCentralUrl, centralIsLocalPort80, isLoopbackHost, portFree, startProxy, acquireProxy, isCloudEditLaunch };
