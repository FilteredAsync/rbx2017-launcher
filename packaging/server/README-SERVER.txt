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
In the launcher's GAMES tab, set the web server address to
  http://<this PC's Tailscale address>       e.g. http://100.101.102.103
and press Find games. Nothing else changes on their PCs; they do not run the
web server or host any more.


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
