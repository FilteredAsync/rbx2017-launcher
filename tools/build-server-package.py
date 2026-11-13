"""Builds share/RobloxServer.zip: the always-on server for a dedicated PC.

    python tools/build-server-package.py

It takes this RobloxClient folder's server files (Server/, the web server,
its web root, scripts, the launcher build for its runtime, the image cache
and the saves in Webserver/node/data) plus packaging/server/ (README and
default config), and leaves out everything personal or temporary: keys,
cookies, your client/host settings, menu music, logs, crash dumps, test
uploads. Build the launcher first (cd Launcher && npm run package).
"""

import fnmatch
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(ROOT, 'packaging', 'server')
OUT = os.path.join(ROOT, 'share', 'RobloxServer.zip')
PREFIX = 'RobloxServer/'
# Never packaged, wherever they are.
PERSONAL = {'host-key.txt', 'roblox-api-key.txt', '.roblosecurity', 'client.json', 'host.json',
            'menu-music.mp3', 'server.pid', 'dedicated.pid'}

# Moving this server to another PC (tools/build-server-installer.py): these
# come along too, with the games, accounts and saves.
MOVED_TOO = {'host-key.txt', 'roblox-api-key.txt', 'menu-music.mp3'}

entries = {}  # name in the zip -> file on disk
generated = {}  # name in the zip -> bytes made here
dirs = set()
moving = False


def add_file(src, rel):
    name = os.path.basename(rel)
    if (name in PERSONAL and not (moving and name in MOVED_TOO)) or name.startswith('.') or name.endswith('.log'):
        return
    entries[PREFIX + rel.replace(os.sep, '/')] = src


def add_tree(rel_dir, exclude=()):
    base = os.path.join(ROOT, rel_dir)
    for directory, subdirs, files in os.walk(base):
        rel = os.path.relpath(directory, ROOT).replace(os.sep, '/')
        subdirs[:] = [s for s in subdirs
                      if not any(fnmatch.fnmatch(f'{rel}/{s}', pattern) for pattern in exclude)
                      and (not s.startswith('.') or s in ('.test', '.127.0.0.1'))]
        for name in files:
            rel_file = f'{rel}/{name}'
            if not any(fnmatch.fnmatch(rel_file, pattern) for pattern in exclude):
                add_file(os.path.join(directory, name), rel_file)


def collect(move=False):
    """Fills entries/generated/dirs. move=True: everything this server has
    (games, accounts, avatars, friends, saves, keys, music, settings), for
    moving it to another PC; False: a fresh server (RobloxServer.zip)."""
    global moving
    moving = move
    launcher = os.path.join(ROOT, 'Launcher', 'dist', 'RobloxClient Launcher-win32-x64')
    if not os.path.isdir(launcher):
        sys.exit('Build the launcher first: cd Launcher && npm run package')

    library = [] if move else ['Server/content/places/[0-9]*.rbxlx']
    add_tree('Server', exclude=[
        'Server/Regshot-1.9.0', 'Server/battest.bat', 'Server/roblox-auto-patcher.exe', 'Server/gameserver - Copy.lua',
        'Server/content/place.before-localhost.rbxlx', 'Server/content/place.rbxlx.orig', 'Server/content/*.bak',
        'Server/content/places/old', 'Server/content/places/deleted', *library])
    dirs.add(PREFIX + 'Server/content/places/')
    add_tree('Webserver/node', exclude=['Webserver/node/logs', 'Webserver/node/data', 'Webserver/node/node_modules'])
    dirs.add(PREFIX + 'Webserver/node/logs/')
    personal_data = [] if move else [
        'Webserver/node/data/places.json',
        # Studio accounts and the secret behind Studio's edit tokens belong to
        # this PC; the server makes its own (people log in there again).
        'Webserver/node/data/accounts.json', 'Webserver/node/data/studio-secret.txt',
        # Players' avatars and pictures go with their accounts.
        'Webserver/node/data/avatars.json', 'Webserver/node/data/avatar-images', 'Webserver/node/data/friends.json']
    add_tree('Webserver/node/data', exclude=[
        'Webserver/node/data/control.json', 'Webserver/node/data/runner-status.json', *personal_data])
    add_tree('Webserver/www', exclude=['Webserver/www/v1/dump', 'Webserver/www/Error/captures'])
    add_tree('Webserver/bin/apache/certificats')
    for name in ('server.json', 'README.txt'):
        add_file(os.path.join(ROOT, 'config', name), 'config/' + name)
    # assets.json without "allowNamedJoins": that is for this PC's players
    # while they update; a new server starts with sign-in required.
    with open(os.path.join(ROOT, 'config', 'assets.json'), encoding='utf-8-sig') as source:
        settings = json.load(source)
    settings.pop('allowNamedJoins', None)
    generated[PREFIX + 'config/assets.json'] = (json.dumps(settings, indent=4) + chr(10)).encode('utf-8')
    if move:
        # This PC's settings and keys; never moved.json (that would send the
        # new server's players on to another address).
        for name in ('dedicated.json', 'host-key.txt', 'roblox-api-key.txt', 'menu-music.mp3'):
            if os.path.isfile(os.path.join(ROOT, 'config', name)):
                add_file(os.path.join(ROOT, 'config', name), 'config/' + name)
        for name in ('asset-details.json', 'local-users.json'):
            if os.path.isfile(os.path.join(ROOT, 'cache', name)):
                add_file(os.path.join(ROOT, 'cache', name), 'cache/' + name)
        if os.path.isdir(os.path.join(ROOT, 'cache', 'wearables')):
            add_tree('cache/wearables')
    else:
        add_file(os.path.join(TEMPLATES, 'dedicated.json'), 'config/dedicated.json')
    for sub in ('assets', 'thumbs', 'avatars'):
        add_tree('cache/' + sub)
    # Replacement files for assets Roblox will not hand out (the /manage page).
    if os.path.isdir(os.path.join(ROOT, 'assets-override')):
        add_tree('assets-override')
    add_file(os.path.join(ROOT, 'cache', 'roblox-users.json'), 'cache/roblox-users.json')
    add_file(os.path.join(ROOT, 'Client', 'apidump.txt'), 'Client/apidump.txt')
    for name in ('patch-rcc-place-auth.ps1', 'patch-rcc-http-urls.ps1', 'add-hosts-entries.ps1', 'addHostsEntries.bat',
                 'tailscale-firewall.ps1', 'tailscaleFirewall.bat', 'startServer.bat', 'autostart.ps1',
                 'autostartServer.bat', 'convertPlace.bat', 'Launcher.bat'):
        add_file(os.path.join(ROOT, name), name)
    add_tree('Launcher/dist/RobloxClient Launcher-win32-x64')
    # The ROBLOX logo players' launchers download from the server.
    for name in ('roblox-logo.png', 'roblox-logo-tagline.png'):
        if os.path.isfile(os.path.join(ROOT, 'Launcher', 'renderer', name)):
            add_file(os.path.join(ROOT, 'Launcher', 'renderer', name), 'Launcher/renderer/' + name)
    add_file(os.path.join(TEMPLATES, 'README-SERVER.txt'), 'README-SERVER.txt')
    add_file(os.path.join(TEMPLATES, 'setup-server.ps1'), 'setup-server.ps1')
    # The game files the server hands to new players (tools/build-client-files.py).
    if os.path.isfile(os.path.join(ROOT, 'downloads', 'client-files.zip')):
        for name in ('client-files.zip', 'client-files.json'):
            add_file(os.path.join(ROOT, 'downloads', name), 'downloads/' + name)
    else:
        print('note: no downloads/client-files.zip (run tools/build-client-files.py); players with the small Setup.exe cannot get game files from this server')
    # Roblox Studio for players' launchers (tools/build-client-files.py studio).
    if os.path.isfile(os.path.join(ROOT, 'downloads', 'studio-files.zip')):
        for name in ('studio-files.zip', 'studio-files.json'):
            add_file(os.path.join(ROOT, 'downloads', name), 'downloads/' + name)
    else:
        print('note: no downloads/studio-files.zip (run tools/build-client-files.py studio); players cannot get Studio from this server')

    missing = [name for name, src in entries.items() if not os.path.isfile(src)]
    if missing:
        sys.exit('missing: ' + ', '.join(missing))


def main():
    collect(move=False)
    total = sum(os.path.getsize(src) for src in entries.values())
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT + '.new', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        written = set()
        for name in sorted(set(entries) | set(generated) | dirs):
            parts = name.rstrip('/').split('/')
            for i in range(1, len(parts)):
                folder = '/'.join(parts[:i]) + '/'
                if folder not in written:
                    archive.writestr(folder, b'')
                    written.add(folder)
            if name.endswith('/'):
                if name not in written:
                    archive.writestr(name, b'')
                    written.add(name)
            elif name in generated:
                archive.writestr(name, generated[name])
            else:
                archive.write(entries[name], name)
    os.replace(OUT + '.new', OUT)
    print(f'{OUT}: {len(entries)} files, {round(total / 1e6)} MB unpacked, {round(os.path.getsize(OUT) / 1e6)} MB zipped')


if __name__ == '__main__':
    main()
