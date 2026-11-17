'use strict';

// The website (site/, on Cloudflare Pages) signs players in and shows their
// home page by asking this server. Its requests all come from Cloudflare's
// addresses, so it sends each visitor's own address in X-Rbx-Client-Ip, with
// this server's website key in X-Rbx-Site-Key to show the address can be
// trusted. Then wrong-password limits (lib/accounts.js) count per visitor,
// not for the whole website at once.
//
// The key is in config/site-key.txt, made on first use. /manage's Server
// page shows it, to paste into the Cloudflare project (site/README.md).

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const core = require('./core');

const FILE = core.rootPath('config', 'site-key.txt');

let cached = null;

function key() {
  if (cached) return cached;
  try {
    const text = fs.readFileSync(FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(text)) cached = text;
  } catch (error) { /* made below */ }
  if (!cached) {
    cached = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(require('path').dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${cached}\n`);
  }
  return cached;
}

function matches(given) {
  const value = Buffer.from(String(given || ''));
  const expected = Buffer.from(key());
  return value.length === expected.length && crypto.timingSafeEqual(value, expected);
}

// Only public addresses: never one that this server treats as its own or a
// game server's (loopback, LAN, Tailscale, the VPS tunnel).
function isPublic(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    return !(lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^fd7a:115c:a1e0/.test(lower));
  }
  return false;
}

// The address a request stands for: the visitor's, for the website's own
// requests, else the one the connection (or the VPS) gave.
function clientAddress(req, remote) {
  const given = req.headers['x-rbx-site-key'];
  if (!given) return remote;
  const client = String(req.headers['x-rbx-client-ip'] || '').trim();
  return matches(given) && isPublic(client) ? client : remote;
}

module.exports = { key, clientAddress, isPublic };
