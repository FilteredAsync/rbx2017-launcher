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
//   directJoin   the client runs its -j address as the join script (clients
//                  before 2016): the join answer says joinMode 'direct' and the
//                  launcher passes the join script's own address (lib/joining.js).
//   placeIdArgument  RCC is started with -PlaceId:<id> (it names the process).
//                  The 2016 RCC instead calls a start() of its own with it,
//                  which fails, and exits.
//   clientConnectPort  the client connects to localhost:<port> whatever its
//                  join script says (the 2018 client does with
//                  FFlagDebugLocalRccServerConnection, which it needs to skip
//                  the version checks), so the launcher's game relay listens
//                  there (lib/relay.js).
//   jsonJobs     RCC runs only JSON jobs (2018 on): the game is its own
//                  "GameServer" job, which loads the place from the web server
//                  and starts the server itself, since the Lua calls
//                  gameserver.lua makes (game:SetPlaceID, the Set...Url calls)
//                  are gone; any other script goes through a Thumbnail job
//                  (lib/hosting.js).
//   selfHosted   no RCC survives from that year, so the client itself hosts
//                  the game (lib/hosting.js startSelfHosted): Server<year> is
//                  a copy of the client folder, started with a server script
//                  from lib/oldyears.js; players get a join script from there
//                  too. exe: the client's exe; run: 'joinScript' (the exe runs
//                  "-j <script address>", 2013) or 'script' ("-script
//                  loadfile('<address>')()", 2009). Their scripts carry the
//                  old "%signature%" form. Games of these years play only in
//                  their own year (lib/launcherapi.js yearsFor), and their
//                  places are stored as uploaded (lib/placeconvert.js).
//
// 2017 is 0.300.0.138971. 2016 is 0.254.0.80823 (July 2016): client, RCC and
// game files of that one build (tools/make-engine.py builds the folders).

const core = require('./core');

const DEFAULT_ENGINE = '2017';

const ENGINES = {
  // 2009 (RobloxApp 0.20.12.1, November 2009) and 2013 (0.98.0.31956, April
  // 2013): self-hosted. The 2009 app needs a patch for PCs with 32 or more
  // logical CPUs (tools/make-engine.py).
  2009: {
    id: '2009',
    label: '2009',
    build: '0.20.12.1',
    server: 'Server2009',
    client: 'Client2009',
    clientFiles: 'client-files-2009',
    selfHosted: { exe: 'RobloxApp.exe', run: 'script' },
    placeIdArgument: false,
    playerAuthentication: false,
    memoryPatches: [],
  },
  2013: {
    id: '2013',
    label: '2013',
    build: '0.98.0.31956',
    server: 'Server2013',
    client: 'Client2013',
    clientFiles: 'client-files-2013',
    selfHosted: { exe: 'RobloxPlayerBeta.exe', run: 'joinScript' },
    placeIdArgument: false,
    playerAuthentication: false,
    memoryPatches: [],
  },
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
  // 2015 (client 0.205.0.61876 on its RCC 0.206.0.62042; Server2015,
  // Client2015, client-files-2015, directJoin, no -PlaceId, no player
  // authentication) joins, but players can neither walk nor turn the camera:
  // that RCC hands out Lua control and camera scripts from
  // content/scripts/PlayerScripts, which no surviving 2015 RCC folder has.
  // Not offered until it has them.
  // No 2014 (0.177) game server survives, and the 2014 client crashes on the
  // 2015 one (an unknown class or property type in the first replication
  // data), so 2014 is not offered.
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
  2018: {
    id: '2018',
    label: '2018',
    build: '0.338.0.202976',
    // Its RCC is 0.338.0.202225 (May 2018, the same version number), patched
    // on disk by tools/make-engine.py.
    server: 'Server2018',
    client: 'Client2018',
    clientFiles: 'client-files-2018',
    placeIdArgument: false,
    playerAuthentication: false,
    jsonJobs: true,
    clientConnectPort: 53640,
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

// The launcher's folder for an engine's client: a known engine's, or
// Client<year> for any other year a server names (launchers since 1.19.0
// download any year's client-files-<year> without knowing the year).
function clientFolder(value) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  if (known(id)) return ENGINES[id].client;
  return /^\d{4}$/.test(id) ? `Client${id}` : ENGINES[DEFAULT_ENGINE].client;
}

// The game server's exe: RCC, or for a self-hosted year its client.
function rccExe(value) {
  const engine = get(value);
  return core.rootPath(engine.server, engine.selfHosted ? engine.selfHosted.exe : 'RCCService.exe');
}

// The client exe's name in its folder.
function clientExeName(value) {
  const id = known(value);
  return id && ENGINES[id].selfHosted ? ENGINES[id].selfHosted.exe : 'RobloxPlayerBeta.exe';
}

// True for a year whose client hosts the game itself (selfHosted).
function selfHosted(value) {
  const id = known(value);
  return Boolean(id && ENGINES[id].selfHosted);
}

// Engines whose RCC is on this PC (a game set to another one can't start here).
function installed(value) {
  return core.isFile(rccExe(value));
}

function list() {
  return Object.values(ENGINES).map((engine) => ({
    id: engine.id, label: engine.label, build: engine.build, clientFiles: engine.clientFiles,
    installed: installed(engine.id), default: engine.id === DEFAULT_ENGINE, selfHosted: Boolean(engine.selfHosted),
  }));
}

module.exports = { DEFAULT_ENGINE, ENGINES, known, get, clientFolder, clientExeName, selfHosted, rccExe, installed, list };
