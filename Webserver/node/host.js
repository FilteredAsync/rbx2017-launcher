#!/usr/bin/env node
'use strict';

// RCC host launcher (hostGame.bat): hosts a multiplayer game. The work is in
// lib/hosting.js (shared with the launcher app); this file asks for the
// settings and keeps the console window open while hosting.
// Ctrl+C (or closing the window) takes the game off the list and stops RCC.
//
//   node Webserver/node/host.js           ask for anything not saved yet
//   node Webserver/node/host.js --setup   ask for every setting again
//   node Webserver/node/host.js --no-rcc  list the game without starting RCC (testing)
//
// Saved in config/host.json.

const os = require('os');
const path = require('path');
const core = require('./lib/core');
const hosting = require('./lib/hosting');
const { createPrompter } = require('./lib/prompt');
const proxy = require('./lib/proxy');

const SETUP = process.argv.includes('--setup');
const NO_RCC = process.argv.includes('--no-rcc');

// Printed and kept in Webserver/node/logs/host.log, so a failure can still be
// read after the window is closed.
function log(message) {
  const now = new Date();
  console.log(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}  ${message}`);
  core.appendLog(path.join(__dirname, 'logs', 'host.log'), `${core.gmdate(now)}  ${message}`, 1048576);
}

async function settings(rl) {
  const config = hosting.loadConfig();
  const ask = (question, fallback) => rl.ask(question, fallback);

  if (SETUP || proxy.normalizeCentralUrl(config.centralUrl) === null) {
    console.log('Web server address: http://127.0.0.1 when the web server runs on this PC,');
    console.log('otherwise its address (Tailscale IP, or playit TCP address like abc.gl.at.ply.gg:12345).');
    for (;;) {
      const value = proxy.normalizeCentralUrl(await ask('Web server address', config.centralUrl || 'http://127.0.0.1'));
      if (value !== null) {
        config.centralUrl = value;
        break;
      }
      console.log('  That does not look like host:port or http://host:port.');
    }
  }
  config.centralUrl = proxy.normalizeCentralUrl(config.centralUrl);
  const local = proxy.centralIsLocalPort80(config.centralUrl);

  if (!local && (SETUP || !config.hostKey)) {
    config.hostKey = await ask('Host key (from config/host-key.txt on the web server PC)', config.hostKey);
  }
  if (SETUP || !config.gameName) config.gameName = await ask('Game name', config.gameName || `${os.hostname()}'s Lumber Tycoon 2`);
  if (SETUP || !config.placeId) config.placeId = await ask('Place ID', config.placeId || '1818');
  if (SETUP || !config.gamePort) {
    for (;;) {
      const port = Number(await ask('Local UDP game port', config.gamePort || 53640));
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
        config.gamePort = port;
        break;
      }
      console.log('  A number from 1024 to 65535 please.');
    }
  }
  if (SETUP || !config.publicAddress) {
    console.log('Public game address: where players reach this PC\'s game port.');
    console.log(`  Tailscale: tailscale:${config.gamePort} (this PC's Tailscale address, found automatically)`);
    console.log('  playit: the address of your UDP tunnel (e.g. abc.gl.at.ply.gg:23456)');
    console.log('  LAN only: this PC\'s address on your network');
    for (;;) {
      const value = await ask('Public game address', config.publicAddress || `${hosting.lanAddress()}:${config.gamePort}`);
      if (/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/.test(value)) {
        config.publicAddress = value;
        break;
      }
      console.log('  Use host:port.');
    }
  }
  if (!core.decimal(String(config.placeId))) config.placeId = '1818';
  hosting.saveConfig(config);
  return config;
}

async function main() {
  const rl = createPrompter();
  const config = await settings(rl);
  rl.close();

  const game = await hosting.startHosting(config, { log, startRcc: !NO_RCC });
  log('Hosting. Press Ctrl+C (or close this window) to stop.');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => game.stop('stopping...'));
  }
  await game.stopped;
  process.exit(0);
}

main().catch((error) => {
  console.error('');
  log(`Error: ${error.message}`);
  process.exit(1);
});
