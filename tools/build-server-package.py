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

entries = {}  # name in the zip -> file on disk
dirs = set()


def add_file(src, rel):
    name = os.path.basename(rel)
    if name in PERSONAL or name.startswith('.') or name.endswith('.log'):
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


def main():
    launcher = os.path.join(ROOT, 'Launcher', 'dist', 'RobloxClient Launcher-win32-x64')
    if not os.path.isdir(launcher):
        sys.exit('Build the launcher first: cd Launcher && npm run package')

    add_tree('Server', exclude=[
        'Server/Regshot-1.9.0', 'Server/battest.bat', 'Server/roblox-auto-patcher.exe', 'Server/gameserver - Copy.lua',
        'Server/content/place.before-localhost.rbxlx', 'Server/content/place.rbxlx.orig', 'Server/content/*.bak',
        'Server/content/places/old', 'Server/content/places/deleted', 'Server/content/places/[0-9]*.rbxlx'])
    dirs.add(PREFIX + 'Server/content/places/')
    add_tree('Webserver/node', exclude=['Webserver/node/logs', 'Webserver/node/data', 'Webserver/node/node_modules'])
    dirs.add(PREFIX + 'Webserver/node/logs/')
    add_tree('Webserver/node/data', exclude=[
        'Webserver/node/data/places.json', 'Webserver/node/data/control.json', 'Webserver/node/data/runner-status.json',
        # Studio accounts and the secret behind Studio's edit tokens belong to
        # this PC; the server makes its own (people log in there again).
        'Webserver/node/data/accounts.json', 'Webserver/node/data/studio-secret.txt'])
    add_tree('Webserver/www', exclude=['Webserver/www/v1/dump', 'Webserver/www/Error/captures'])
    add_tree('Webserver/bin/apache/certificats')
    for name in ('server.json', 'assets.json', 'README.txt'):
        add_file(os.path.join(ROOT, 'config', name), 'config/' + name)
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
    add_file(os.path.join(TEMPLATES, 'README-SERVER.txt'), 'README-SERVER.txt')
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
    total = sum(os.path.getsize(src) for src in entries.values())
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT + '.new', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        written = set()
        for name in sorted(set(entries) | dirs):
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
            else:
                archive.write(entries[name], name)
    os.replace(OUT + '.new', OUT)
    print(f'{OUT}: {len(entries)} files, {round(total / 1e6)} MB unpacked, {round(os.path.getsize(OUT) / 1e6)} MB zipped')


if __name__ == '__main__':
    main()
