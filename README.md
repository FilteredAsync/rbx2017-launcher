# rbx2017-launcher

A launcher, web server and hosting tools for playing a 2017-era Roblox client
(RobloxPlayerBeta 0.299 / RCCService 0.300) together over Tailscale.

- **Launcher** (`Launcher/`, Electron): laid out like the 2016-2017 Xbox One
  app, with a "press A" start screen, sign-in (accounts on your server, or
  play as a guest), Home with your avatar, recently played and online games,
  a 3D avatar editor (hats, faces, clothes, packages and body colors from
  the Roblox catalog), friends (and which game they are in), menu music and
  controller support. Joins games (a local proxy and UDP relay let the 2017 client
  reach servers on other PCs), opens Roblox Studio, hosts games, runs the
  web server, and converts places.
- **Web server** (`Webserver/node/`, Node.js, no dependencies): accounts,
  guests, friends and each account's avatar, assets
  (with mesh conversion, thumbnails and `rbxgameasset://` names),
  DataStore saves, the chat filter, LuaWebService (group and friend checks),
  join scripts, the game list and the place library.
- **Always-on server** (`Webserver/node/dedicated.js`, `startServer.bat`):
  runs every online game from the place library, restarts crashed or stuck
  games, restarts daily after saving players, and is managed in a browser
  at `http://<server>/manage` by its admins (upload games, which get
  permanent place IDs, turn them on or off, update, rename, delete). The
  page needs the host key or an admin account (the launcher's Manage games
  opens it for admins).
- **Place converter** (`Webserver/node/convert-place.js`): makes places saved
  by a newer Roblox Studio load in the 2017 engine.
- **RCC fixes in memory** (`patch-rcc-*.ps1`): local place authorization,
  and http addresses for LuaWebService. `RCCService.exe` on disk is never
  changed.

## What is not in this repository

Git tracks only this project's own code (see `.gitignore`, an allow-list).
These come from the original RobloxClient bundle and stay local:

| Folder / file | What it is |
| --- | --- |
| `Client/` | the 2017 game client (Roblox's) |
| `Server/` | RCCService and its content, including `Server/content/place.rbxlx` |
| `Webserver/www/`, `Webserver/bin/` | the bundle's web root (templates the web server serves) and its HTTPS certificate |
| `Launcher/renderer/roblox-logo.png` | the old logo (the launcher shows text without it) |
| `config/menu-music.mp3` | optional menu music |

Never commit keys or personal files: `config/host-key.txt`,
`config/roblox-api-key.txt`, `cache/.roblosecurity`, `config/client.json`,
`config/host.json`, `config/session.json`, or anything under
`Webserver/node/data/` (saves, accounts and avatars).

The launcher's 3D avatar uses [three.js](https://threejs.org/) r149 (MIT,
`Launcher/renderer/vendor/`).

## Players: Setup.exe

There are two installers. Both install per user (no administrator rights),
let the player pick a folder, and add a Desktop and Start menu shortcut and
an entry in Apps & features.

| | `RobloxClient-Setup-<version>.exe` | `RobloxClient-Setup-Full-<version>.exe` |
| --- | --- | --- |
| Build | `npm run dist` | `npm run dist:full` |
| Size | about 120 MB | about 190 MB |
| Game client | downloaded on first run from your server | inside |
| Share on | GitHub Releases | privately only (it contains Roblox's client) |

With the small one, the launcher opens on **Settings > Network** the first
time: the player enters your server's address and presses **Download game
files** (about 85 MB, checked against its SHA-256). When the server has newer
game files, Settings > Setup offers them as an update.

The server hands out the game files once you build them (and again whenever
`Client/` changes):

```
python tools/build-client-files.py
```

This writes `downloads/client-files.zip` and `.json`, which the web server
serves at `/download/client-files.zip` and `tools/build-server-package.py`
includes in the server package.

Build the installers on a PC that has the full RobloxClient folder:

```
cd Launcher
npm install
npm run dist        # small Setup.exe (Launcher/dist-installer/)
npm run dist:full   # full Setup.exe
```

The installers are not code-signed, so Windows SmartScreen may say "Windows
protected your PC": choose **More info > Run anyway**. To ship an update,
raise `version` in `Launcher/package.json` and build again. Installing over
an older version keeps each player's settings (server address, sign-in),
cache and downloaded game files.

Players also need [Tailscale](https://tailscale.com/download), signed in to
your tailnet.

## The always-on server: RobloxServer.zip

```
cd Launcher && npm run package && cd ..
python tools/build-server-package.py
```

This makes `share/RobloxServer.zip` from this folder's server files, the
saves in `Webserver/node/data` and `packaging/server/` (its README and
default settings), leaving out keys and personal settings. Setup on the
server PC is in `packaging/server/README-SERVER.txt`.

Server updates: always-on servers update their own program files
(`Webserver/node/lib/updates.js`, `Webserver/node/apply-update.js`), never
their data. Packages are signed with `config/update-signing-key.pem`, which
exists only on the developer's PC; keep a backup of it, since servers accept
only updates signed with it.

```
node tools/build-server-update.js public                 # the committed server code
node tools/publish-server-update.js share/RobloxServer-update-<build>.rbxupd
node tools/build-server-update.js private Server/appearance-hook.lua downloads   # never published
```

A public update goes out as a GitHub pre-release (`server-<build>`): servers
find it within a few hours and install it once nobody is playing; launchers
ignore pre-releases. A private update is uploaded on the server's `/manage`
page ("Server" > "Install an update file"). `--exe` also makes a
`RobloxServer-Update-<build>.exe` that installs the same files on the server
PC without `/manage`, for servers set up before the updater.

To move a running server to another PC with everything it has (games,
saves, accounts, avatars, friends, keys), `python tools/build-server-installer.py`
makes `share/RobloxServer-Setup-<date>.exe`, an installer that also sets
Windows up for the server (`packaging/server/setup-server.ps1`). It contains
the accounts and keys, so it is never published. Players' launchers follow
the move through `config/moved.json` on the old server ("Moving this server to
another PC" in README-SERVER.txt). The host posts announcements to every
launcher from the server's `/manage` page; `announcements.json` in this
repository's main branch, if present, reaches every launcher too, even while
a server is down:

```json
{ "announcements": [{ "id": "2026-11-move", "title": "Server moving", "text": "...",
  "level": "important", "postedAt": "2026-11-13T18:00:00Z", "expiresAt": "2026-11-20T00:00:00Z" }] }
```

## Development

- Launcher: `cd Launcher && npm install && npm start`
- Web server alone: `node Webserver/node/server.js` (or `startWeb.bat`)
- Settings and how everything fits together: `config/README.txt`
- Project goals: `Requirements.txt`
