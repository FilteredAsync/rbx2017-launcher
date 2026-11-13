#!/usr/bin/env node
'use strict';

// Client launcher (playGame.bat): pick a username and one of the games that
// are online on the central web server, then start the 2017 client in it.
// The work is in lib/joining.js (shared with the launcher app): a local proxy
// forwards the client's web requests to the central web server when it is on
// another PC, and a local relay carries the game connection.
//
//   node Webserver/node/play.js           ask for anything not saved yet
//   node Webserver/node/play.js --setup   ask for the web server address again
//   node Webserver/node/play.js --dry-run do everything except start the client
//
// Saved in config/client.json: the web server address and last username.

const core = require('./lib/core');
const joining = require('./lib/joining');
const { createPrompter } = require('./lib/prompt');
const proxy = require('./lib/proxy');

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function main() {
  if (!core.isFile(joining.CLIENT_EXE)) throw new Error(`client not found at ${joining.CLIENT_EXE}`);
  const rl = createPrompter();
  const ask = (question, fallback) => rl.ask(question, fallback);
  let game;
  let centralUrl;
  let username;
  try {
    const saved = joining.loadConfig();
    centralUrl = proxy.normalizeCentralUrl(saved.centralUrl);
    if (centralUrl === null || process.argv.includes('--setup')) {
      console.log('Web server address: the host\'s Tailscale IP or playit TCP address (e.g. http://100.101.102.103),');
      console.log('or http://127.0.0.1 when the web server runs on this PC.');
      for (;;) {
        centralUrl = proxy.normalizeCentralUrl(await ask('Web server address', saved.centralUrl || 'http://127.0.0.1'));
        if (centralUrl !== null) break;
        console.log('  That does not look like host:port or http://host:port.');
      }
    }

    for (;;) {
      username = await ask('Username', saved.username);
      if (joining.validUsername(username)) break;
      console.log('  3-20 letters, digits or _ please.');
    }

    console.log(`\nAsking ${centralUrl} for online games...`);
    const games = await joining.fetchGames(centralUrl);
    if (games.length === 0) {
      console.log('No games are online right now. Ask someone to start hosting, then try again.');
      return 0;
    }
    games.forEach((entry, index) => {
      console.log(`  ${index + 1}. ${entry.name}  (place ${entry.placeId}, up ${formatUptime(entry.upSeconds)})`);
    });
    let choice;
    for (;;) {
      choice = Number(await ask('Join which game', '1'));
      if (Number.isInteger(choice) && choice >= 1 && choice <= games.length) break;
      console.log(`  Type a number from 1 to ${games.length}.`);
    }
    game = games[choice - 1];
    joining.saveConfig({ centralUrl, username });
  } finally {
    rl.close();
  }

  const session = await joining.joinGame({ centralUrl, username, game, log: console.log, dryRun: process.argv.includes('--dry-run') });
  if (process.argv.includes('--dry-run')) return 0;
  console.log('Keep this window open while you play.');
  await session.exited;
  console.log('The client closed.');
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
