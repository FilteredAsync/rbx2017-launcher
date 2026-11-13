RobloxServer - always-on server for the 2017 RobloxClient
==========================================================

This folder runs the web server and the games for everyone, around the
clock. It has no game client: play from your own PC's launcher.

What it does by itself
  - Starts the web server and every game that is online in the game library
    (managed at http://<this PC>/manage, see "Managing games" below).
  - Starts a game again if it crashes, and restarts one that stops answering.
  - Restarts every game daily at 05:00. Players are kicked with a message
    first, so their progress saves.
  - Restarts a game that uses too much memory once nobody is playing.
  - Starts the web server again if it stops.

Needs: Windows 10 or 11 (64-bit), 4+ CPU cores, 8 GB RAM (16 GB for several
games), a wired network connection, Tailscale. Nothing else to install: the
launcher in this folder brings its own runtime.


Setup (once)
------------
1. Copy this RobloxServer folder somewhere permanent, e.g. C:\RobloxServer.

2. Install Tailscale (https://tailscale.com/download) and sign in so this PC
   is on the same tailnet as the players (or share this machine with them
   from the Tailscale admin page). Note this PC's Tailscale address
   (100.x.y.z) from the Tailscale icon.

3. Run as administrator (each asks Windows for permission):
     addHostsEntries.bat      lets RCC find the web server's names
     tailscaleFirewall.bat    lets Tailscale players reach TCP 80 and the
                              game ports (only Tailscale addresses)

4. Port 80 must be free: no IIS, Apache/UwAmp or other web server running.

5. Keep the PC awake: Settings > System > Power > Screen and sleep >
   "Never" for sleep. Set Windows Update active hours around play time.

6. Double-click startServer.bat. The first start creates config\host-key.txt.
   The window shows "running; players join at 100.x.y.z:53640" when the game
   is up.

7. Start it with Windows: double-click autostartServer.bat (no admin). It
   starts when this account signs in; for a PC nobody signs in to, turn on
   automatic sign-in (Win+R, netplwiz) or it waits for a sign-in.


Players
-------
Players install the launcher with RobloxClient-Setup-<version>.exe (from the
GitHub release, or from you). On its first start they paste the join code
you gave them (see "Join codes" below), or, if they are already on your
Tailscale network, enter this server's address; it then downloads the game
files from here:
  http://<this PC's Tailscale address>       e.g. http://100.101.102.103
The files it hands out are in downloads\ (client-files.zip, about 85 MB).
If the game client ever changes, build them again on the PC that has the
client (python tools/build-client-files.py) and copy its downloads\ folder
here; launchers then offer the update. Players with an older full installer
just set the same address in the GAMES tab. Nobody else runs the web server
or hosts.


Running it
----------
In the startServer window type:
  status                 players, memory and uptime of each game
  restart                restart every game (players are saved first)
  restart 1818           restart one game by place ID
  stop                   save players and stop everything (or press Ctrl+C)
Closing the window stops everything at once without saving players: use
"stop" or Ctrl+C instead.
Log: Webserver\node\logs\dedicated.log (web requests: access.log).


Join codes (players without invites)
------------------------------------
Players can join with one code instead of being invited to Tailscale: their
launcher installs Tailscale, signs in with a key made for players, and can
then reach this server only. Set it up once in the Tailscale admin console
(login.tailscale.com) with the account that owns this server:

1. Access controls: tags for the server and for players, and a rule that lets
   players reach the server's web server and game ports and nothing else.
   Add to the policy file:

     "tagOwners": {
       "tag:rbx-server": ["autogroup:admin"],
       "tag:rbx-player": ["autogroup:admin"]
     },

   and in "acls", next to your own rules:

     {"action": "accept", "src": ["tag:rbx-player"], "dst": ["tag:rbx-server:80,53640-53659"]}

   Important: if your policy still has the default rule that lets everyone
   reach everything ("src": ["*"], "dst": ["*:*"]), change its "src" to
   ["autogroup:member"]. Otherwise players could reach all your devices.

2. Machines: on this server PC, "Edit ACL tags" and add tag:rbx-server.

3. Settings > Keys > Generate auth key: Reusable on, Ephemeral off,
   Pre-approved on (if device approval is on), Tags: tag:rbx-player.
   Copy the key (tskey-auth-...). It works for up to 90 days; players who
   joined keep working after that, new players need a new key and code.

4. On http://127.0.0.1/manage, "Join code for players": paste the key and
   press Make join code. Share the code privately (it contains the key).
   To cut off a code, revoke its key in Settings > Keys.

Players' PCs show up in Machines as rbx-<username>; remove any you do not
recognize. Tagged players do not count as Tailscale users.

Managing games
--------------
Open http://<this PC's Tailscale address>/manage in a browser (on this PC:
http://127.0.0.1/manage), or press "Manage games" in the launcher. Anyone
can look; changes need the host key from config\host-key.txt on this PC
(type it into the page once; give it only to people who may manage games).
  - Upload a game: pick a .rbxlx, give it a name. It gets the next free
    place ID (2000, 2001, ...), and that ID is permanent: saves and the
    thumbnail stay with it, and it is never given to another game. Places
    from a newer Roblox Studio are converted on the way in; the page shows
    what was changed and what needs a hand edit. Binary .rbxl files must be
    saved as .rbxlx in Studio first.
  - Online switch: the server starts or stops the game within seconds
    (players are saved first). Up to 4 games run at once (maxGames).
  - Restart, rename, description, thumbnail: right on the game's card.
    Renames show in everyone's game list at once.
  - Replace file: uploads a new version under the same place ID. If the
    game is online it saves its players and restarts on the new version.
    The last 3 old versions stay in Server\content\places\old.
  - Delete: the file moves to Server\content\places\deleted; saves and the
    thumbnail are kept, and the place ID is never reused.
Lumber Tycoon 2 is in the library as place 1818 (its saves came along).
Back up Webserver\node\data now and then: it holds the library, every
game's saves and the thumbnails.
Server-wide settings (daily restart time, memory limit, games at once,
port range): config\dedicated.json, explained in config\README.txt.

Optional: config\roblox-api-key.txt with your own Roblox Open Cloud API key
lets the web server download some assets Roblox otherwise refuses (see
config\README.txt). Use your own key; never copy someone else's.
