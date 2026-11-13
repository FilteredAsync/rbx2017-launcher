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
restartServer.bat restarts the whole server (players are saved first) and
picks up new server files; restartServer.bat -StopOnly only stops it.
Double-click it as the account that runs the server, not as administrator.
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

Accounts, guests and avatars
----------------------------
Players sign in to this server from the launcher (1.4.0 and newer) with a
username and password; "Sign up" there makes the account. The same accounts
log in to Roblox Studio. Joining a game uses the account's name, so nobody
can play under someone else's name. Without an account players can "Play as
a guest": they join as "Guest_1234" with the 2016 guest look and cannot use
Studio, the avatar editor or the chat (as guests could not in 2016).
Each account has its own avatar, made in the launcher's Avatar tab (hats,
hair, faces, heads, shirts, pants, t-shirts, packages, body colors). A new
account starts with what the Roblox account with the same name wears. The
avatars and their pictures are kept in Webserver\node\data\avatars.json and
data\avatar-images\; the catalog comes from Roblox (this PC needs internet).
Friends: players add each other in the launcher's Friends tab (by name, or
from the players in games right now) or with "Send Friend Request" in a
game's player list, and see which game their friends are in. Games that check
friendship (IsFriendsWith, GetFriendsAsync) use these friends; they are kept
in Webserver\node\data\friends.json.
Older launchers (1.3.0 and before) join as guests until they update; while
everyone updates, "allowNamedJoins": true in config\assets.json lets them in
under their typed name again.

Roblox Studio and Team Create
-----------------------------
Roblox Studio 2017 (Studio\RobloxStudioBeta.exe) uses this server: its start
page lists the games here. Log in on that page with your launcher account
(on Studio's page the first login with a new name also creates an account).
The first account made on this PC is an
admin: admins may open and publish over every game. /manage, "Studio
accounts", changes who is an admin and resets a forgotten password (delete the
account; the next login with that name makes it again).
  - Edit opens a game from the start page; New place starts a baseplate.
  - FILE > Publish to ROBLOX As...: publish as a new game (it gets the next
    place ID and goes online right away if ticked) or over a game you may
    edit. FILE > Publish to ROBLOX updates the game the place came from.
  - Everyone else edits only their own games and the ones whose owner added
    them as editors ("Editors" on the start page, or the game's Edit form on
    /manage).
Team Create (building together):
  - The owner or an admin turns it on in Studio: VIEW > Team Create > Turn
    ON (or tick Team Create in the game's Edit form on /manage).
  - From then on the game opens in Team Create for its owner and editors:
    everyone builds in the same place and sees the others' changes at once.
  - This server starts a Team Create server for the game when the first person
    opens it (UDP ports from 53659 down) and stops it, after saving, 3 minutes
    after the last person leaves. It also saves every 5 minutes.
  - Saved changes go live when nobody is playing that game, at the daily
    restart, or when you press Restart on /manage.
  - It needs this always-on server (startServer.bat), not the launcher's
    Host tab.
Players get Studio from the launcher (1.3.0 and newer): GAMES > Open Studio
downloads it from this server the first time (downloads\studio-files.zip,
about 120 MB) and starts it; their launcher forwards Studio's requests and
Team Create's connection here, so nothing else needs opening. If Studio ever
changes, build its download again on the PC that has it (python
tools/build-client-files.py studio) and copy downloads\ here; launchers
update Studio the next time it is opened.
Log: Webserver\node\logs\studio.log.

Managing games
--------------
Only admins manage games. Admins press "Manage games" in the launcher (1.5.4
and newer; the button shows only for admin accounts): the page opens
unlocked for 12 hours. Or open http://<this PC's Tailscale address>/manage
(on this PC: http://127.0.0.1/manage) and type the host key from
config\host-key.txt once; give the key only to people who may manage games.
Without either the page stays locked. Who is an admin: /manage, "Studio
accounts" (the first account made on this PC is one).
  - Creator ("By ..." in the game's loading screen and the launcher): for a
    game made in Studio its owner; for an imported Roblox game the original
    creator, looked up from its Roblox universe ID. Type another name in the
    game's Edit form, or set the universe ID there.
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

Announcements: /manage, "Announcements", posts a notice to every player's
launcher (1.5.2 and newer). It shows on their Home screen within two minutes
and stays until it expires (6 hours to a week, or until you remove it) or
the player dismisses it; one marked important also pops up. They are kept in
Webserver\node\data\announcements.json.

Optional: config\roblox-api-key.txt with your own Roblox Open Cloud API key
lets the web server download some assets Roblox otherwise refuses (see
config\README.txt). Use your own key; never copy someone else's.


Updates
-------
The server keeps its own files up to date: a few minutes after it starts,
and then every 3 hours, it looks for a newer server update in the project's
GitHub releases, downloads it and installs it once nobody has played or
built for 3 minutes (or at the daily restart). Installing saves the players,
stops everything, swaps the files and starts the server again, in about a
minute. The replaced files are kept in updates\backup\, and if the new
version does not start, the old one is put back by itself.
Updates only ever change the server's program files: games, saves,
accounts, avatars, friends, settings, keys and logs are never touched.
Only updates signed with the project's key are installed.
/manage, "Server", shows the version, any waiting update and how the last
one went, and has buttons to check now, install now, restart the whole
server, and read the logs. Files that cannot be published (game-server
scripts, the client download) come as a private update file
(.rbxupd) from whoever builds the project: "Install an update file" there.
RobloxServer-Update-<date>.exe does the same without /manage: run it on
this PC (no administrator needed), and it stops, updates and starts the
server.
To install updates only when you press Install, add "autoUpdate": false to
config\dedicated.json; "updateCheckHours": 0 stops the checks.
The update log is updates\update.log.


Moving this server to another PC
--------------------------------
Everything moves: games and their saves, accounts and their sign-ins,
avatars, friends, announcements, the host key and settings. Players' launchers
(1.5.2 and newer) follow by themselves and stay signed in.
1. On the old PC, stop the server (type stop in the startServer window), so
   the saves are complete.
2. On the PC with the project: python tools/build-server-installer.py makes
   share\RobloxServer-Setup-<date>.exe. It holds every account and the keys:
   hand it only to whoever runs the new server, never publish it.
3. On the new PC: install Tailscale and sign in, then run the installer. It
   copies the server to C:\RobloxServer, sets up the hosts entries and the
   Tailscale firewall rules, can keep the PC awake and start the server with
   Windows, and lists what is left to do (setup-notes.txt), including the
   new Tailscale address. Run setup-server.ps1 -CheckOnly there to check port
   80 and Tailscale again later.
4. Give the players access to the new PC in Tailscale (share it, or adjust
   the ACLs), and check that one of them can open http://<new address>/manage.
5. On the old PC, put the new address in config\moved.json:
     {"to": "http://100.x.y.z"}
   and keep only its web server running (startWeb.bat in a full project
   folder; here, turn every game offline on /manage and keep
   startServer.bat running). Launchers check it at start and every 10
   minutes, switch once the new server answers, and say so.
   Leave it running until everyone has switched; older launchers still need
   the new address typed in Settings.
