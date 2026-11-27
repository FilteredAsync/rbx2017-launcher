'use strict';

// Local UDP relay for the game connection (lib/joining.js, Studio's Team
// Create in lib/proxy.js).
//
// The 2017 client before 0.300 bound its game socket to 127.0.0.1, so it
// could only reach a game server on 127.0.0.1: games on other PCs timed out
// with "Failed to connect ... Connection attempt failed". The 0.300 client
// connects where its join script says (lib/engines.js connectsDirectly), so
// the launcher relays only other years' games (the 2018 client always
// connects to localhost, clientConnectPort), servers that don't offer a
// direct connection, and playGame.bat. The relay listens on 127.0.0.1, the
// join script points the client there, and it forwards every packet to the
// real game server and the replies back.

const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const os = require('os');

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

// 127.x or one of this PC's own addresses (a game server here).
function isThisPc(ip) {
  if (/^127\./.test(ip)) return true;
  return Object.values(os.networkInterfaces()).some((list) => (list || []).some((entry) => entry.address === ip));
}

// Is a UDP port free on every address of this PC? (A game server binds
// 0.0.0.0, so binding the same port there fails.)
async function udpPortFree(port) {
  const probe = dgram.createSocket('udp4');
  try {
    await bind(probe, port, '0.0.0.0');
    return true;
  } catch (error) {
    return false;
  } finally {
    try { probe.close(); } catch (error) { /* never bound */ }
  }
}

// Starts a relay from 127.0.0.1:<random port> to serverAddress ("host:port").
// options.port: listen on that port instead, for a client that always
// connects to localhost:<port> whatever its join script says (the 2018
// client, lib/engines.js clientConnectPort). A server on this PC on that
// very port needs no relay; any other program on it is an error (code
// 'EADDRINUSE'). Returns { port, target, close() }.
async function startRelay(serverAddress, log = () => {}, options = {}) {
  const { host, port } = parseAddress(serverAddress);
  const ip = net.isIPv4(host) ? host : (await dns.promises.lookup(host, { family: 4 })).address;
  const fixed = Number(options.port) || 0;
  if (fixed && port === fixed && isThisPc(ip)) {
    return { port: fixed, target: `${ip}:${port}`, stats: () => ({ sent: 0, received: 0 }), close() {} };
  }
  if (fixed && !(await udpPortFree(fixed))) {
    throw Object.assign(new Error(`UDP port ${fixed} is in use on this PC (a game server or another game), and this year's client only connects there`), { code: 'EADDRINUSE' });
  }

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

  await bind(front, fixed, '127.0.0.1');
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
