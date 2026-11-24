'use strict';

// The Roblox versions ("engines") a game can run on, chosen per game on
// /manage. Each has its own game server (RCCService) and game client: a
// client joins only a server of its own year (a 2016 client fails on the
// 2017 RCC's first game packet), so a game's players all use its engine's
// client, which the launcher downloads the first time they join one.
//
//   server       folder of the RCC (RCCService.exe, its content and DLLs)
//   client       folder the launcher keeps that year's client in
//   clientFiles  name of its game-files package in downloads/ (/download/<name>.json)
//   memoryPatches  RCC memory patches run after start (RobloxClient\patch-rcc-*.ps1),
//                  each with the host.json switch that skips it
//   playerAuthentication  gameserver.lua's SetIsPlayerAuthenticationRequired(true)
//                  stays in (lib/hosting.js); the 2016 RCC would then refuse
//                  our join tickets, so it is taken out there.
//   placeIdArgument  RCC is started with -PlaceId:<id> (it names the process).
//                  The 2016 RCC instead calls a start() of its own with it,
//                  which fails, and exits.
//
// 2017 is 0.300.0.138971. 2016 is 0.254.0.80823 (July 2016): client, RCC and
// game files of that one build (tools/make-engine-2016.py builds the folders).

const core = require('./core');

const DEFAULT_ENGINE = '2017';

const ENGINES = {
  2017: {
    id: '2017',
    label: '2017',
    build: '0.300.0.138971',
    server: 'Server',
    client: 'Client',
    clientFiles: 'client-files',
    placeIdArgument: true,
    playerAuthentication: true,
    memoryPatches: [
      { script: 'patch-rcc-place-auth.ps1', label: 'place-auth patch', skip: 'patchPlaceAuth', consequence: 'players may stay "not authenticated"' },
      { script: 'patch-rcc-http-urls.ps1', label: 'LuaWebService patch', skip: 'patchHttpUrls', consequence: 'group and friend checks in games will fail with "LuaWebService error"' },
      { script: 'patch-rcc-signature.ps1', label: 'signature-report patch', skip: 'patchSignatureCheck', consequence: '0.300 game clients will be disconnected right after joining' },
    ],
  },
  2016: {
    id: '2016',
    label: '2016',
    build: '0.254.0.80823',
    server: 'Server2016',
    client: 'Client2016',
    clientFiles: 'client-files-2016',
    placeIdArgument: false,
    playerAuthentication: false,
    memoryPatches: [],
  },
};

// '2016' / '2017' for anything that names a known engine, else null.
function known(value) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  return Object.prototype.hasOwnProperty.call(ENGINES, id) ? id : null;
}

function get(value) {
  return ENGINES[known(value) || DEFAULT_ENGINE];
}

function rccExe(value) {
  return core.rootPath(get(value).server, 'RCCService.exe');
}

// Engines whose RCC is on this PC (a game set to another one can't start here).
function installed(value) {
  return core.isFile(rccExe(value));
}

function list() {
  return Object.values(ENGINES).map((engine) => ({
    id: engine.id, label: engine.label, build: engine.build, clientFiles: engine.clientFiles,
    installed: installed(engine.id), default: engine.id === DEFAULT_ENGINE,
  }));
}

module.exports = { DEFAULT_ENGINE, ENGINES, known, get, rccExe, installed, list };
