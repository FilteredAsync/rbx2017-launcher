'use strict';

// Local UDP relay for the game connection (used by play.js).
//
// This 2017 client binds its game socket to 127.0.0.1, so it can only reach
// a game server on 127.0.0.1. Games on other PCs (Tailscale, playit, LAN)
// time out with "Failed to connect ... Connection attempt failed": the
// packets can never leave the loopback socket. The relay listens on
// 127.0.0.1, the join script points the client there, and it forwards every
// packet to the real game server and the replies back.

const dgram = require('dgram');
const dns = require('dns');
const net = require('net');

function parseAddress(address) {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(address || ''));
  if (!match) throw new Error(`not a host:port address: ${address}`);
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error(`bad port in ${address}`);
  return { host: match[1], port };
}

function bind(socket, port, host) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  });
}

// Starts a relay from 127.0.0.1:<random port> to serverAddress ("host:port").
// Returns { port, target, close() }.
async function startRelay(serverAddress, log = () => {}) {
  const { host, port } = parseAddress(serverAddress);
  const ip = net.isIPv4(host) ? host : (await dns.promises.lookup(host, { family: 4 })).address;

  const front = dgram.createSocket('udp4'); // the client talks to this one
  const back = dgram.createSocket('udp4');  // this one talks to the server
  let client = null;
  let sent = 0;
  let received = 0;

  front.on('message', (message, from) => {
    client = from;
    sent++;
    back.send(message, port, ip);
  });
  back.on('message', (message) => {
    if (client === null) return;
    received++;
    front.send(message, client.port, client.address);
  });
  front.on('error', (error) => log(`game relay (client side): ${error.message}`));
  back.on('error', (error) => log(`game relay (server side): ${error.message}`));

  await bind(front, 0, '127.0.0.1');
  await bind(back, 0, '0.0.0.0');

  return {
    port: front.address().port,
    target: `${ip}:${port}`,
    stats: () => ({ sent, received }),
    close() {
      try { front.close(); } catch (error) { /* already closed */ }
      try { back.close(); } catch (error) { /* already closed */ }
    },
  };
}

module.exports = { startRelay, parseAddress };
