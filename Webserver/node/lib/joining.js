'use strict';

// Joining a multiplayer game, shared by play.js (playGame.bat) and the
// launcher. The client only talks to http://localhost./, so unless the web
// server runs on this PC, a local proxy on port 80 forwards its requests to
// the central web server. Its game traffic goes through a local UDP relay
// (lib/relay.js), because this 2017 client can only reach a game server on
// 127.0.0.1.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const proxy = require('./proxy');
const relay = require('./relay');

const CONFIG = core.rootPath('config', 'client.json');
const CLIENT_EXE = core.rootPath('Client', 'RobloxPlayerBeta.exe');

function validUsername(name) {
  return /^[A-Za-z0-9_]{3,20}$/.test(String(name || ''));
}

function loadConfig() {
  return core.readJsonFile(CONFIG) || {};
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 4) + '\n');
}

async function fetchGames(centralUrl) {
  let response;
  try {
    response = await fetch(`${centralUrl}/api/games`, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw new Error(`could not reach the web server at ${centralUrl}: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
  }
  if (!response.ok) throw new Error(`the web server at ${centralUrl} answered HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.games) ? data.games : [];
}

// Asks the web server for a join ticket (lib/launcherapi.js): with a session
// token the player joins as that account, without one as a guest.
// -> { ticket, name, userId, guest }
async function joinTicket(centralUrl, gameId, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${centralUrl}/api/launcher/join`, {
      method: 'POST', headers, body: JSON.stringify({ gameId, guest: !token }), signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`could not reach the web server at ${centralUrl}: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
  }
  let data = {};
  try { data = await response.json(); } catch (error) { data = {}; }
  if (response.status === 404 && !data.error) throw new Error('this server is too old for launcher sign-in; update its server files');
  if (!response.ok) throw new Error(data.error || `the web server answered HTTP ${response.status}`);
  return data;
}

// Starts the client in game ({ id, name, address }). Resolves once the client
// is running, with { exited, stop() }; "exited" resolves when the client
// closes (proxy and relay are closed then too).
// With a ticket (from joinTicket) the server decides who joins; a bare
// username works only on servers with "allowNamedJoins" (otherwise the
// player becomes a guest).
async function joinGame({ centralUrl, username, ticket = null, name = null, game, log = console.log, dryRun = false }) {
  if (process.platform !== 'win32') throw new Error('the 2017 client runs on Windows only');
  if (!core.isFile(CLIENT_EXE)) throw new Error(`client not found at ${CLIENT_EXE}`);
  if (!ticket && !validUsername(username)) throw new Error('the username needs 3-20 letters, digits or _');
  const userId = ticket ? null : core.localUserId(username);

  // Shared with Studio (both need port 80); closed when neither runs.
  let localProxy = null;
  if (!proxy.centralIsLocalPort80(centralUrl)) {
    localProxy = await proxy.acquireProxy(centralUrl, log);
    log(`Forwarding the client's web requests to ${centralUrl}.`);
  }
  let gameRelay;
  try {
    gameRelay = await relay.startRelay(game.address, log);
  } catch (error) {
    if (localProxy) localProxy.release();
    throw new Error(`could not reach the game address ${game.address}: ${error.message}`);
  }
  log(`Relaying the game connection to ${gameRelay.target}.`);
  const closeAll = () => {
    gameRelay.close();
    if (localProxy) localProxy.release();
  };

  const who = ticket ? `ticket=${ticket}` : `username=${encodeURIComponent(username)}&id=${userId}`;
  const joinUrl = `http://localhost./game/placelauncher.ashx/?gameId=${encodeURIComponent(game.id)}&${who}&relayport=${gameRelay.port}`;
  if (dryRun) {
    log(`Would start the client with -j ${joinUrl}`);
    closeAll();
    return { userId, exited: Promise.resolve(), stop() {} };
  }

  log(`Joining "${game.name}" as ${ticket ? name || 'your account' : `${username} (user ID ${userId})`}.`);
  const child = spawn(CLIENT_EXE, ['--play', '-a', 'http://localhost./Login/Negotiate.ashx/', '-t', 'Test', '-j', joinUrl], {
    cwd: path.dirname(CLIENT_EXE),
    stdio: 'ignore',
  });
  const exited = new Promise((resolve, reject) => {
    child.on('exit', () => { closeAll(); resolve(); });
    child.on('error', (error) => { closeAll(); reject(new Error(`could not start the client: ${error.message}`)); });
  });
  return {
    userId,
    exited,
    stop() {
      if (child.exitCode === null) {
        try { child.kill(); } catch (error) { /* already gone */ }
      }
    },
  };
}

module.exports = { joinGame, joinTicket, fetchGames, validUsername, loadConfig, saveConfig, CONFIG, CLIENT_EXE };
