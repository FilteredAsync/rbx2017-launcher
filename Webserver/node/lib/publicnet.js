'use strict';

// Players over the internet, through a VPS relay (tools/vps/setup-vps.sh): a
// small cloud server forwards the web (Caddy, HTTPS) and the game ports (UDP
// 53640-53659) to this PC over WireGuard, so players need no Tailscale and
// no join code. This PC is 10.66.0.2 on the tunnel, the VPS 10.66.0.1.
//
// Requests from the VPS carry the player's address in X-Forwarded-For and
// the public name they used in X-Rbx-Public-Host. Game addresses this server
// hands them ("host:port" of its own game servers) then use that name, so
// their launcher's game relay sends UDP to the VPS, which forwards it here.
//
//   requestInfo(req) -> { remote, publicHost }   (publicHost null: not relayed)
//   rewriteAddresses(ctx, value) -> value with own game addresses made public
//   tunnelAddress() -> this PC's WireGuard address, or null

const net = require('net');
const os = require('os');
const core = require('./core');

const TUNNEL_PREFIX = '10.66.0.';
const plain = (address) => String(address || '').replace(/^::ffff:/i, '');

let cache = null;
function ownAddresses() {
  if (cache && Date.now() - cache.at < 30000) return cache.set;
  const set = new Set(['127.0.0.1', '::1', 'localhost']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) set.add(plain(item.address).toLowerCase());
  }
  const tailscale = core.tailscaleIPv4();
  if (tailscale) set.add(tailscale);
  cache = { at: Date.now(), set };
  return set;
}

function tunnelAddress() {
  for (const address of ownAddresses()) if (address.startsWith(TUNNEL_PREFIX)) return address;
  return null;
}

// Is the connection from the VPS (the other end of the WireGuard tunnel)?
function fromRelay(peer) {
  const address = plain(peer);
  const own = tunnelAddress();
  return own !== null && address.startsWith(TUNNEL_PREFIX) && address !== own;
}

function requestInfo(req) {
  const peer = req.socket.remoteAddress || '-';
  if (!fromRelay(peer)) return { remote: peer, publicHost: null };
  // Caddy adds the player's address last (and ignores what clients send).
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
  const client = forwarded.length > 0 ? forwarded[forwarded.length - 1] : '';
  const host = String(req.headers['x-rbx-public-host'] || '').replace(/:\d+$/, '').toLowerCase();
  return {
    remote: net.isIP(client) ? client : peer,
    publicHost: /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null,
  };
}

// "host:port" of a game server on this PC -> "<public name>:port".
function publicAddress(ctx, address) {
  const match = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(address);
  if (!match || !ownAddresses().has(plain(match[1]).toLowerCase())) return address;
  return `${ctx.publicHost}:${match[2]}`;
}

// Every "address" field in a JSON answer, for players coming through the VPS.
function rewriteAddresses(ctx, value, depth = 0) {
  if (!ctx || !ctx.publicHost || depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => rewriteAddresses(ctx, item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === 'address' && typeof item === 'string' ? publicAddress(ctx, item) : rewriteAddresses(ctx, item, depth + 1);
  }
  return out;
}

module.exports = { requestInfo, rewriteAddresses, publicAddress, tunnelAddress, fromRelay };
