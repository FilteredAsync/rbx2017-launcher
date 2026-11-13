Web server and asset loading settings
=====================================

0. The web server (Node.js)
---------------------------
The web server is Webserver\node\server.js. It needs Node.js 18 or newer
(https://nodejs.org) and nothing else: UwAmp (Apache, PHP, MySQL) is no longer
used, and launchServer.bat stops it if it is still running.

  launchServer.bat   starts the web server in a minimized window if needed
  startWeb.bat       runs only the web server, in its own window
  killWeb.bat        stops the web server (and any old UwAmp/Apache)
  start-web.sh       the same on Linux/macOS: node Webserver/node/server.js

config\server.json:
  hosts       Addresses to listen on. The default (127.0.0.1 and ::1) only
              accepts this PC. Use ["0.0.0.0"] to let other machines connect,
              e.g. for multiplayer; anyone who can reach it can then use your
              asset credentials (section 1) through /asset.
  port        HTTP port (80). On Linux, ports below 1024 need root.
  httpsPort   HTTPS port (443, 0 = off), using the httpsCert/httpsKey files.
Environment overrides: LEGACY_WEB_PORT, LEGACY_WEB_HTTPS_PORT, LEGACY_WEB_HOSTS.

Files in Webserver\www are served as before. Endpoints that ran PHP code were
rewritten in Webserver\node\lib (asset proxy, character, join scripts and
the small game APIs); .php files that only print fixed text are served as that
text. The few PHP scripts that were broken or unsafe (e.g. ones that ran
programs on the server) answer 501 and are listed once in
Webserver\node\logs\server.log. Requests are logged in Webserver\node\logs.
Private keys (*.pem, *.key), dot-folders (.test) and folder listings are not
served. The PHP files stay in place for reference.

The launcher (Launcher.bat)
---------------------------
One window instead of the console scripts, with four tabs:
  Play        web server address + username, list of online games, Join.
  Host        game name, place ID, port, how players reach you (Tailscale or
              an address like playit); Start/Stop hosting, live player list.
              Hosting from the launcher needs no administrator prompt.
  Web server  start/stop it; shows the address to give friends (Tailscale).
  Setup       checks (hosts entries, Tailscale, firewall, API key) with
              buttons for the one-time admin steps.
It uses the same code and settings (config\client.json, config\host.json)
as playGame.bat and hostGame.bat, which keep working. Logs: Webserver\node\logs.
The app is Launcher\dist\RobloxClient Launcher-win32-x64 (Electron, no
Node.js needed). To rebuild it after changes: in Launcher, npm install, then
npm run package. share\launcher-update.zip carries it and every changed file
for other players.

Multiplayer (playit tunnels)
----------------------------
One PC runs the web server (e.g. an always-on server). Any number of PCs on
the same network host games with RCCService; players anywhere join them.

  Web server PC
    1. startWeb.bat (or launchServer.bat). The first start creates
       config\host-key.txt: the password that lets a PC host games.
    2. In playit, add a TCP tunnel to local address 127.0.0.1 port 80.
       Its address (e.g. abc.gl.at.ply.gg:12345) is the "web server address".

  Each hosting PC (runs RCCService)
    1. Run addHostsEntries.bat once (it asks for administrator). It points the
       *.localhost names RCC builds itself (api.localhost, data.localhost,
       versioncompatibility.api.localhost, ...) at this PC. Without them RCC
       never accepts players ("Player not authenticated") and loads no
       characters. addHostsEntries.bat -Remove takes them out again.
    2. In playit, add a UDP tunnel to this PC, local port 53640 (or another
       fixed port). Its address is the "public game address".
    3. hostGame.bat (asks for administrator). It asks once for the web server
       address (http://127.0.0.1 if the web server runs on this same PC), the
       host key, a game name, the place ID, the UDP port and the public game
       address, saved in config\host.json; hostGame.bat --setup asks again.
       Keep the window open while hosting; Ctrl+C or closing it ends the game.

  Players
    playGame.bat: asks for the web server address (saved in
    config\client.json; playGame.bat --setup to change it) and a username,
    lists the online games and joins the one you pick. The user ID comes from
    the username, so the same name always gets the same ID and avatar.
    While the client runs, a proxy on this PC's port 80 forwards its web
    requests to the web server, so stop any local web server first.
    The 2017 client binds its game socket to 127.0.0.1, so it can only reach
    a game server on 127.0.0.1. playGame.bat therefore also runs a small UDP
    relay on 127.0.0.1 ("Relaying the game connection to ...") that forwards
    the game traffic to the host's real address (playit, Tailscale or LAN).
    Joining without playGame.bat (e.g. launchClient.bat) only works for a
    game on the same PC.

  Notes
    - Anyone who knows the web server address can join and use /asset, which
      downloads with your Roblox API key or cookie (section 1).
    - Games stay listed while hostGame.bat checks in (every 15 s) and drop off
      45 s after it stops. GET /api/games shows the list.

Multiplayer over Tailscale (private, no tunnels)
------------------------------------------------
Tailscale (https://tailscale.com/download) puts your PCs on a private network
("tailnet"). Only people you invite can join it, and nothing is exposed to
the internet. Use it instead of the playit tunnels above.

  Host PC (runs the web server and hostGame.bat)
    1. Install Tailscale, sign in, and invite each player to your tailnet
       (admin console > Users > Invite users, or share this machine).
    2. Run tailscaleFirewall.bat once (it asks for administrator). It lets
       Tailscale addresses, and only those, reach TCP 80 and the UDP game
       port. tailscaleFirewall.bat -Remove takes the rules out again.
    3. Start the web server after Tailscale is connected (startWeb.bat).
       "tailscale" in config\server.json "hosts" makes it listen on this PC's
       Tailscale address too; it logs a note and skips it while Tailscale is
       off.
    4. hostGame.bat with public game address "tailscale:53640" (already set
       in config\host.json); it is replaced by this PC's Tailscale address.
    Your Tailscale address: run "tailscale ip -4", or see the Tailscale tray
    icon. With MagicDNS on, the machine name works too.

  Players
    Install Tailscale and accept the invite. Stop any local web server
    (UwAmp/Apache), then playGame.bat --setup with web server address
    http://<host's Tailscale address>, e.g. http://100.101.102.103.

The web server downloads assets from Roblox, converts them for the 2017
client, and caches them in RobloxClient\cache\assets.
The character endpoints (v1.1/avatar-fetch, Asset/BodyColors.ashx,
game/characterappearance.ashx) dress the player in their current Roblox avatar.
Whose avatar is used: the name in Webserver\www\game\current-user.txt
(set by launchClient.bat / detect-roblox-user.ps1), unless the join passes one.


1. Signing in for assets (optional, fixes "HTTP 401" assets)
-----------------------------------------------------------
Since April 2025 Roblox only serves many images and sounds to a signed-in
caller. Anonymous downloads are tried first; if Roblox answers 401/403 the
server retries with whichever of these exist:

  config\roblox-api-key.txt   An Open Cloud API key (recommended).
                              Create one at https://create.roblox.com/dashboard/credentials
                              with the legacy-asset:manage scope (Roblox's docs
                              list it for the asset delivery API). Paste only the
                              key into this file. Keep the file private.

  cache\.roblosecurity        Your Roblox session cookie, written by
                              detect-roblox-user.ps1 -LoadAvatar. Works, but the
                              cookie is a full login to your account; prefer the
                              API key and delete this file if you don't need it.

Neither is ever sent anywhere except Roblox, and never to the CDN that the
download redirects to. After adding one, failed assets are retried right away.

"HTTP 403 ... not authorized" means the asset is private (most often audio made
private by Roblox's 2022 audio change). Nobody but its owner can download it;
use an override file (section 3) if you have a replacement.


2. config\assets.json
---------------------
  baseUrl                   Address the client and RCC use for this web server.
  avatarType                "auto" (use the avatar's R6/R15 setting), "R6" or "R15".
  defaultFaceId             Classic face used for a dynamic head that has no
                            other mapping. 144075659 = "Smile".
  dynamicHeads              Dynamic head asset ID -> classic head and/or face:
                              "dynamicHeads": { "15093053680": { "head": "134082579", "face": "0" } }
                            "head" is a classic Head asset (type 17), "face" a
                            classic face; "0" = none. Built in: any "Headless"
                            dynamic head becomes the classic Headless Head.
  dynamicHeadFaces          Older form: dynamic head asset ID -> classic face ID.
  legacyBodyPartMaxAssetId  Empty = keep all body parts (their R6 CharacterMesh is
                            applied). A number drops body parts above that ID.
  loadGear                  true to give players their equipped gear.
  allowNamedJoins           false (the default): players join through the
                            launcher's sign-in (1.4.0 and newer), as their
                            account or as a guest; anything else joins as a
                            guest. true: also lets older launchers and
                            playGame.bat join under any typed name, as before
                            (use it only while everyone updates).
  guestAppearance           What guests wear instead of the 2016 guest look
                            (Robloxian 2.0 body, ROBLOX 'R' Baseball Cap):
                              "guestAppearance": { "bodyColors": { "HeadColor": 24, "TorsoColor": 23,
                                "LeftArmColor": 24, "RightArmColor": 24, "LeftLegColor": 119,
                                "RightLegColor": 119 }, "assets": [ { "id": "417457461", "typeId": 8 } ] }
  avatarCacheSeconds        How long an avatar is reused before asking Roblox again.
  gameAssets                rbxgameasset:// name -> asset ID, for places that use
                            named game assets, e.g.
                              "gameAssets": { "Images/Axe1Box": "1234567" }
  gameUniverseId            The Roblox universe the hosted place came from. Any
                            rbxgameasset:// name without a gameAssets entry is
                            looked up there (Lumber Tycoon 2: 2471084). The
                            place converter prints this number for you.

Kept as-is: T-shirts, shirts, pants, classic faces, hats and accessories.
Dropped:    layered clothing, makeup, emotes, moods and animation packs (the
            client's own animations are used).

Meshes: the 2017 client reads mesh versions 1.00-2.00 only. Newer meshes
(3.00-6.00, and 7.00 with Draco compression) are converted to 2.00 when they
are downloaded, keeping the highest-detail LOD. A mesh that cannot be converted
is served unchanged, logged once in cache\asset-errors.log, and marked with
"meshUnconverted" in its cache\assets\*.json file (delete that file to retry).

To check what a player gets, open in a browser while the web server runs:
  http://localhost./v1.1/avatar-fetch/?userId=1&debug=1


3. Override folder: RobloxClient\assets-override
------------------------------------------------
Files here win over Roblox and the cache. Create the folder if it is missing.

  assets-override\<assetId>.<ext>        e.g. assets-override\434584962.ogg
  assets-override\named\<name>.<ext>     for rbxgameasset names, e.g.
                                         assets-override\named\Images\Axe1Box.png


4. When an asset does not load
------------------------------
Every failed download is logged with the reason in:
  RobloxClient\cache\asset-errors.log
Failures are remembered (RobloxClient\cache\assets\*.missing) for an hour, or a
day for private/deleted assets. Delete a .missing file to retry sooner.


Always-on server and the game library
-------------------------------------
For a PC that hosts around the clock: startServer.bat runs the web server and
every game that is online in the game library, and keeps them running.

The library is managed in a browser at http://<server address>/manage (from
the server itself, or any PC on Tailscale; the launcher's "Manage games"
button opens it). Changes need the host key (config\host-key.txt).
  - Upload a game (.rbxlx): it gets the next free place ID (2000, 2001, ...),
    which never changes and is never given to another game. Places from a
    newer Studio are converted on the way in (see convertPlace.bat).
  - Turn games online or offline, restart them, rename them, change their
    description or thumbnail, upload a new version (same place ID; the
    running game saves its players and restarts), or delete them. Place
    files can be up to 1 GB.
  - Servers start on demand: a game that is online gets a server when the
    first player joins it (the launcher shows "Starting a server..."), and
    more servers when those are full ("Players per server" under Edit). A
    server nobody has played on for idleStopMinutes stops again. Tick "Keep
    one server running" under Edit to have one up all the time (games from
    before servers started on demand have it on). Each server is listed under
    its game with its own Restart and Stop.
  - Private servers: signed-in players make them in the launcher (a game's
    details). The owner, the owner's friends and anyone given its invite code
    can join; /manage lists them under their game and can delete them.
    Stored in Webserver
odedataprivate-servers.json.
  - Library: Webserver\node\data\places.json. Files: Server\content\places\
    (<placeId>.rbxlx; replaced versions in old\, deleted games in deleted\).
    Saves: Webserver\node\data\datastore-<placeId>.json. Thumbnails:
    Webserver\node\data\thumbnails\. Back up Webserver\node\data now and then.
  - On the first start the library holds Lumber Tycoon 2 as place 1818.

What the always-on server does by itself:
  - Starts a server when a player joins a game with no server that has room,
    and stops one nobody has played on for idleStopMinutes.
  - A game whose RCC stops by itself starts again after 10 seconds.
  - A game whose RCC stops answering (3 checks a minute apart) is restarted.
  - A game using more than memoryLimitMB restarts when nobody is playing, or,
    past 115% of the limit, after saving the players.
  - Every game restarts daily at restartDaily. Players are kicked with a
    message first, so the game saves their progress.
  - The web server is started again if it stops.
In its window type: status, restart, restart <place ID or job ID>, stop. Stop it with
"stop" or Ctrl+C (players are saved first); closing the window stops
everything at once. Its log: Webserver\node\logs\dedicated.log.
autostartServer.bat starts it whenever this Windows account signs in
(autostartServer.bat -Remove undoes that). While it runs, the launcher's Host
tab will not host on the same PC.

config\moved.json (only on a server that moved to another PC):
  {"to": "http://100.x.y.z"}
  Launchers 1.5.2 and newer that still use this server switch to that address
  once it answers (they check at start and every 10 minutes), keeping their
  sign-in. Never copy it to the new server. See "Moving this server to
  another PC" in README-SERVER.txt.

Server-wide settings, config\dedicated.json (every field optional):
  {
      "webServer": true,           run the web server on this PC
      "restartDaily": "05:00",     24-hour time, or "" for no daily restart
      "maxGames": 4,               game servers running at the same time
                                   (players get "try again in a few
                                   minutes" past it)
      "idleStopMinutes": 5,        stop a server nobody has played on this
                                   long; 0 = never
      "memoryLimitMB": 3000,       per game; 0 = no limit (an RCC can use 4096)
      "healthCheckSeconds": 60,
      "failedChecksBeforeRestart": 3,
      "saveWaitSeconds": 10,       time for saves after players are kicked
      "gamePortFirst": 53640,      each running server gets the next free UDP
      "gamePortCount": 20,         port from this range
      "autoUpdate": true,          install server updates once nobody plays
                                   (false: only with Install on /manage)
      "updateCheckHours": 3        how often to look for one; 0 = never
  }
tailscaleFirewall.bat opens the whole port range, so new games need no new
firewall rule. RCC's control (SOAP) ports are 64989, 64990, ... alongside.
