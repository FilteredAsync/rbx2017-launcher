# rbx2017-launcher

A launcher, web server and hosting tools for playing a 2017-era Roblox client
(RobloxPlayerBeta 0.299 / RCCService 0.300) together over Tailscale.

- **Launcher** (`Launcher/`, Electron): an Xbox One-style home screen with
  your avatar, recently played and online games, game thumbnails and
  descriptions, menu music and controller support. Joins games (a local
  proxy and UDP relay let the 2017 client reach servers on other PCs),
  hosts games, runs the web server, and converts places.
- **Web server** (`Webserver/node/`, Node.js, no dependencies): assets
  (with mesh conversion, thumbnails and `rbxgameasset://` names), avatars,
  DataStore saves, the chat filter, LuaWebService (group and friend checks),
  join scripts, the game list and the place library.
- **Always-on server** (`Webserver/node/dedicated.js`, `startServer.bat`):
  runs every online game from the place library, restarts crashed or stuck
  games, restarts daily after saving players, and is managed in a browser
  at `http://<server>/manage` (upload games, which get permanent place IDs,
  turn them on or off, update, rename, delete).
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
`config/host.json`, or anything under `Webserver/node/data/` (saves).

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

With the small one, the launcher opens on **Setup > Game files** the first
time: the player enters your server's address and presses **Download game
files** (about 85 MB, checked against its SHA-256). When the server has newer
game files, Setup offers them as an update.

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
an older version keeps each player's settings (server address, username),
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

## Development

- Launcher: `cd Launcher && npm install && npm start`
- Web server alone: `node Webserver/node/server.js` (or `startWeb.bat`)
- Settings and how everything fits together: `config/README.txt`
- Project goals: `Requirements.txt`
