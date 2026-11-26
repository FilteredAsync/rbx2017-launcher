"""Builds another Roblox year (lib/engines.js) next to Client/ and Server/:
Client<year>/ (the game client the launcher downloads for games set to that
year on /manage) and, for years with their own game server, Server<year>/.

    python tools/make-engine.py 2016 --studio <folder> --client <exe> --rcc <exe>
    python tools/make-engine.py 2015 --client <full player folder> --rcc <RCC folder>
    python tools/make-engine.py 2014 --client <full player folder>
    python tools/make-engine.py 2018 --client <full player folder> --rcc <exe>
    python tools/make-engine.py 2013 --client <full player folder>
    python tools/make-engine.py 2009 --client <RobloxApp folder>
    --force   replace existing folders

Where the files come from (Roblox's own builds; this tool checks each exe's
version and MD5 and never runs anything):
  2016 (0.254.0.80823): client and RCC from archive.org funarchive; content,
        shaders and DLLs from that build's Studio folder (archive.org item
        roblox_studio_version-ff140f5bd46141f7_completeclientarchive)
  2015 (0.205.0.61876, July 2015): full player folder from
        archive.roblonium.com, RobloxPlayer/main/2015/7.2015; its RCC
        0.206.0.62042 (six days later) from RCCService/unlisted/2015 there
        (--rcc <that folder>; see the note at its entry below)
  2014 (0.177.0.54327, December 2014): full player folder from
        archive.roblonium.com, RobloxPlayer/main/2014/12.2014. No 2014 RCC
        survives, and the 2014 client crashes on the 2015 one: not offered
  2018 (0.338.0.202976, May 2018): full player folder from
        archive.roblonium.com; its RCC 0.338.0.202225 from the
        Roblox_Builds_2014_2020 archive (2018-05-15_Mid-Spring_Build/Server)
  2013 (0.98.0.31956, April 2013): the player folder from archive.org item
        roblox_client_version-5c703d6176af434b_zork
  2009 (0.20.12.1, November 2009): RobloxApp from archive.org item
        roblox_client_version-a00995fdd72842a2 (setup.roblox.com packages)
  No RCC survives from before 2015, so for 2013 and 2009 the client itself
  hosts the game ("self-hosted", lib/engines.js): Server<year>/ is the same
  patched folder as Client<year>/.

Every client gets, at the same file size: "roblox.com" -> "localhost."; the
one-at-a-time rule taken out (tools/patch-single-instance.py: it closed the
player's real Roblox); the
server's script key (Server/rbxsig_blob.txt) in place of Roblox's 1024-bit
one; its registry key moved to "ROBLOX2017 Revival" like the 2017 client;
AppSettings.xml with CRLF line ends (the old readers need them) and the base
address the year needs; ClientSettings/ClientAppSettings.json with its flags.
Years with their own RCC get the RCC patched the same way plus that build's
code patches (two checks that kick every byte-patched client, for 2016).

Then: python tools/build-client-files.py client<year> packs the client for
launchers. Server<year>/ and the packages go to a server as a private update
(they are Roblox's files: never into git or a public release).
"""

import argparse
import hashlib
import os
import re
import shutil
import stat
import sys

import importlib.util

import pefile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def single_instance():
    spec = importlib.util.spec_from_file_location('single_instance', os.path.join(ROOT, 'tools', 'patch-single-instance.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
BLOB_RE = re.compile(rb'BgIAAA[A-Za-z0-9+/]{192}[A-Za-z0-9+/=]{2}(?![A-Za-z0-9+/=])')
REG_OLD, REG_NEW = b'\\ROBLOX Corporation\\Roblox', b'\\ROBLOX2017 Revival\\Roblox'
APP_SETTINGS = ('<?xml version="1.0" encoding="UTF-8"?>\r\n<Settings>\r\n\t<ContentFolder>content</ContentFolder>\r\n'
                '\t<BaseUrl>{}</BaseUrl>\r\n</Settings>')
# Files of a full player folder that a player never needs (browser plugins).
SKIP = ('NPRobloxProxy.dll', 'NPRobloxProxy64.dll', 'RobloxProxy.dll', 'RobloxProxy64.dll', 'RobloxPlayerLauncher.exe')

YEARS = {
    # Self-hosted years (no RCC): Server<year>/ is a copy of the client folder.
    '2013': {
        'client': {'version': '0.98.0.31956', 'md5': 'f99d8886ddec33265ebfc4edd808031c',
                   'patches': [
                       # The same CPU count as 2009's (below), whose loop
                       # carries the mask in eax: loop while the CPU index
                       # (esi) is below 32 instead of while 1 << esi is not 0
                       # (mov eax,1 / test eax,eax become xor+inc / nop+cmp;
                       # the jne becomes jb at the same address).
                       ('CPU count past 32 CPUs', 0x9B71B9, bytes.fromhex('B8010000008BCED3E085C00F85'),
                        bytes.fromhex('31C0408BCED3E09083FE200F82')),
                   ],
                   # Its flags come from https://clientsettings.api.<domain>/,
                   # and its TLS can't talk to our web server's (30 s timeout
                   # at every start): plain http instead (same length, NUL-padded).
                   'strings': [
                       (b'https://%s.api.localhost./%s/?apiKey=%s\0', b'http://%s.api.localhost./%s/?apiKey=%s\0\0'),
                       (b'https://%s.api.%s%s/%s/?apiKey=%s\0', b'http://%s.api.%s%s/%s/?apiKey=%s\0\0'),
                   ]},
        'base_url': 'http://www.localhost.',
        'client_flags': '{\n}\n',
        'self_hosted': True,
    },
    '2009': {
        'client': {'version': '0.20.12.1', 'md5': '2e6a5cb6c1df1b98a6530a192a5c3b21', 'exe': 'RobloxApp.exe',
                   # It has no one-at-a-time rule (no singleton event).
                   'single_instance': False,
                   'patches': [
                       # Its CPU count (Intel's cpucount sample) walks the
                       # affinity mask with 1 << i, which on x86 wraps back to
                       # 1 at i = 32: with 32 or more logical CPUs it never
                       # ends and overruns 256-byte stack arrays (a crash at
                       # start). Stop after bit 31: "dec eax" makes the 1 the
                       # wrapped shift gives end the loop.
                       ('CPU count past 32 CPUs', 0x7B435F, bytes.fromhex('85C0'), bytes.fromhex('4890')),
                       # Player::setUserId asks for Roblox's own permission
                       # (requirePermission(3, "...set a Player's ID")), which
                       # our join script (-script) doesn't have, so every
                       # player would be ID 0. The check goes (two pushes and
                       # two calls; the callee pops its own arguments).
                       ('player ID permission', 0x4EDF10, bytes.fromhex('68C82F97006A03E8241FFFFF8BC8E8FDABFEFF'), bytes(19 * [0x90])),
                       # The same check in the Player.Name setter ("...set a
                       # Player's name"), so the join script can name the
                       # player; the mov esi,ecx between them stays.
                       ('player name permission', 0x4DFEB1, bytes.fromhex('68642897006A038BF1E881FFFFFF8BC8E85A8CFFFF'),
                        bytes(7 * [0x90]) + bytes.fromhex('8BF1') + bytes(12 * [0x90])),
                   ]},
        'base_url': 'http://www.localhost.',
        'client_flags': '{\n}\n',
        'self_hosted': True,
    },
    '2016': {
        'client': {'version': '0.254.0.80823', 'md5': '18701f7557e1a4c4240cf17041b2d1dd'},
        # Its content, shaders and DLLs come from the same build's Studio folder.
        'studio': {'version': '0.254.0.80823', 'files': ['content', 'PlatformContent', 'shaders', 'fmod.dll', 'SDL2.dll', 'd3dcompiler_47.dll',
                                                          'msvcp110.dll', 'msvcr110.dll', 'openvr_api.dll', 'ReflectionMetadata.xml']},
        'base_url': 'http://localhost./',
        'client_flags': '{\n}\n',
        'rcc': {
            'version': '0.254.0.80823', 'md5': '17067558fdc53cfead09233bc8259298',
            'files': ['content', 'PlatformContent', 'fmod.dll', 'VMProtectSDK32.dll', 'msvcp110.dll', 'msvcr110.dll'],
            # This RCC runs without FFlagDebugLocalRccServerConnection (its
            # client has no such switch), so these checks are patched instead.
            'patches': [
                ('client hash check', 0xC04D85, bytes([0x74, 0x12]), bytes([0x90, 0x90])),
                ('anti-cheat report kick', 0xC08A9D, bytes([0xC6, 0x45, 0x17, 0x01]), bytes([0xC6, 0x45, 0x17, 0x00])),
            ],
            'flags': '{\n  "FLogGoldenHashes": 7\n}\n',
        },
    },
    '2015': {
        'client': {'version': '0.205.0.61876', 'md5': 'a20f01994673fe3ef5ca1706b6a96d0e'},
        # With http://localhost./ this client builds an empty address and
        # stops at start (MSVCR110 0xC0000409).
        'base_url': 'http://www.localhost./',
        # It fetches the server's flags (the 2017 set) and then this file: the
        # debug connection switch would change its connection password.
        'client_flags': '{\n  "FFlagDebugLocalRccServerConnection": false\n}\n',
        # Its own RCC: the full RCC folder from archive.roblonium.com
        # (RCCService/unlisted/2015/0.206.0.62042). Every copy of this exe is
        # the same one, changed after Roblox signed it (signature
        # HashMismatch): a few bytes only (its PE checksum is 0x26 off), no
        # added code, sections, imports or addresses. Used on the user's call.
        'rcc': {
            'version': '0.206.0.62042', 'md5': 'c3ad66e7363759204b3d6005ce5e22f0', 'from_folder': True,
            'files': ['content', 'platformcontent', 'shaders', 'fmod.dll', 'fmodex.dll', 'SDL2.dll', 'VMProtectSDK32.dll',
                      'msvcp110.dll', 'msvcr110.dll', 'ReflectionMetadata.xml'],
            'patches': [
                ('client hash check', 0xAA7EF5, bytes([0x74, 0x12]), bytes([0x90, 0x90])),
                ('anti-cheat report kick', 0xAAB56D, bytes([0xC6, 0x45, 0x17, 0x01]), bytes([0xC6, 0x45, 0x17, 0x00])),
            ],
            'flags': '{\n  "FLogGoldenHashes": 7\n}\n',
        },
    },
    # Built but not offered (lib/engines.js): the 2014 client crashes on the
    # 2015 RCC, and no 2014 RCC survives.
    '2014': {
        'client': {'version': '0.177.0.54327', 'md5': '75e4466d2effef3a7fd57aa716dfdc1c'},
        'base_url': 'http://www.localhost./',
        'client_flags': '{\n  "FFlagDebugLocalRccServerConnection": false\n}\n',
    },
    '2018': {
        'client': {'version': '0.338.0.202976', 'md5': '4a77a4af05fbb8fd4242111ce8810a73',
                   # Game pass and badge checks go to inventory.<domain>, a name
                   # hosts files here don't have; api.<domain> answers them.
                   'patches': [('inventory host', 0x1132C8C, b'inventory\0', b'api\0' + bytes(6))]},
        'base_url': 'http://localhost./',
        # Like the 2017 pair: the debug connection switch on both sides skips
        # the version and exe hash checks.
        'client_flags': '{\n  "FFlagDebugLocalRccServerConnection": true,\n  "DFFlagDebugLocalRccServerConnection": true\n}\n',
        # RCC 0.338.0.202225 (May 2018) from the Roblox_Builds_2014_2020
        # archive (2018-05-15_Mid-Spring_Build/Server); content from the
        # client folder, VMProtectSDK32.dll from Server/. The 2017 RCC needs
        # the same fixes as memory patches (patch-rcc-*.ps1).
        # The client keeps its CoreScripts inside the exe, so the player
        # folder has no content/scripts; this RCC loads ServerStarterScript
        # and Modules/Server from there and stops without them. The 2017
        # server's (Server/content/scripts, signed with our key) run on it.
        'rcc': {
            'version': '0.338.0.202225', 'md5': 'fe3514499344d1e70e83243675133108',
            'files': ['content', 'PlatformContent'],
            'repo_files': ['VMProtectSDK32.dll', 'content/scripts'],
            'patches': [
                # ServerReplicator::dataOutStep: a place authentication
                # refusal (validate-place-join) disconnects the player. Never.
                ('place authentication kick', 0xBF9E39, bytes.fromhex('83BFA883000003'), bytes.fromhex('83BFA8830000FF')),
                # "Bad signature (3)": every byte-patched client reports its
                # own broken signature; mask 0 never matches.
                ('bad-signature report kick', 0xC01DAB, bytes.fromhex('6A0857'), bytes.fromhex('6A0057')),
                # LuaWebService (IsInGroup, IsFriendsWith...): the helper that
                # makes addresses https:// keeps them http://, and the trust
                # check takes the game's own site (localhost.) on both of its
                # paths instead of refusing it.
                ('https helper', 0x5238E9, bytes.fromhex('83FEFF7531'), bytes.fromhex('83C8FF9090')),
                ('LuaWebService trust check', 0x5156FF, bytes.fromhex('751D'), bytes.fromhex('7514')),
                ('LuaWebService trust check (flag off)', 0x515731, bytes.fromhex('7518'), bytes.fromhex('7514')),
                # Data stores go to gamepersistence.<domain> and game pass and
                # badge checks to inventory.<domain>, names the hosts files here
                # don't have: data.<domain> and api.<domain> instead (the web
                # server answers /persistence/ and /v1/users/ on any name).
                ('data store host', 0x107AE9C, b'gamepersistence\0', b'data\0' + bytes(11)),
                ('inventory host', 0x10954A4, b'inventory\0', b'api\0' + bytes(6)),
            ],
            'flags': '{\n  "FFlagDebugLocalRccServerConnection": true,\n  "DFFlagDebugLocalRccServerConnection": true\n}\n',
            # This RCC hands players the PlayerScripts on its disk (2017's,
            # above). Their ControlScript waits for a DynamicThumbstick module
            # they lack, so players could neither move nor steer the camera.
            # It is for touch screens only; this stub does nothing.
            'written': {
                'content/scripts/PlayerScripts/StarterPlayerScripts/ControlScript/MasterControl/DynamicThumbstick.lua': (
                    '-- Written by tools/make-engine.py: ControlScript waits for this module.\r\n'
                    '-- Touch screens only; it does nothing.\r\n'
                    'local DynamicThumbstick = {}\r\n'
                    'function DynamicThumbstick:Enable() end\r\n'
                    'function DynamicThumbstick:Disable() end\r\n'
                    'function DynamicThumbstick:Create(parentFrame) end\r\n'
                    'return DynamicThumbstick\r\n'
                ),
            },
        },
    },
}


def md5(path):
    with open(path, 'rb') as handle:
        return hashlib.md5(handle.read()).hexdigest()


def file_version(path):
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    version = None
    for info in getattr(pe, 'FileInfo', []) or []:
        for entry in info:
            for table in getattr(entry, 'StringTable', []):
                version = table.entries.get(b'FileVersion', version)
    pe.close()
    return version.decode('latin-1').replace(', ', '.') if version else None


def check(path, kind, want):
    if not os.path.isfile(path):
        sys.exit(f'{kind}: {path} not found')
    if file_version(path) != want['version']:
        sys.exit(f'{kind}: {path} is {file_version(path)}, not {want["version"]}')
    if 'md5' in want and md5(path) != want['md5']:
        sys.exit(f'{kind}: {path} is not the copy this tool knows (MD5 {want["md5"]})')


def patch_exe(source, target, key, registry, code_patches=(), string_patches=()):
    data = bytearray(open(source, 'rb').read())
    wide = data.count('roblox.com'.encode('utf-16-le'))
    notes = [f'{data.count(b"roblox.com")} x roblox.com -> localhost.' + (f' (+{wide} UTF-16)' if wide else '')]
    data = bytearray(bytes(data).replace(b'roblox.com', b'localhost.'))
    data = bytearray(bytes(data).replace('roblox.com'.encode('utf-16-le'), 'localhost.'.encode('utf-16-le')))
    # Same-length string changes (after the roblox.com one), each found once.
    for old, new in string_patches:
        if len(old) != len(new) or data.count(old) != 1:
            sys.exit(f'{source}: string patch {old!r} not found once (or not the same length)')
        data = bytearray(bytes(data).replace(old, new))
        notes.append(f'{old.split(b"://")[0].decode()} address -> {new.split(b"://")[0].decode()}')
    blobs = list(BLOB_RE.finditer(data))
    if len(blobs) != 1:
        sys.exit(f'{source}: expected one 1024-bit script key, found {len(blobs)}')
    start, end = blobs[0].span()
    data[start:end] = key
    notes.append('script key')
    if registry:
        notes.append(f'{data.count(REG_OLD)} x registry key')
        data = bytearray(bytes(data).replace(REG_OLD, REG_NEW))
    if code_patches:
        pe = pefile.PE(source, fast_load=True)
        base = pe.OPTIONAL_HEADER.ImageBase
        offsets = [pe.get_offset_from_rva(va - base) for _, va, _, _ in code_patches]
        pe.close()
        for (label, va, old, new), offset in zip(code_patches, offsets):
            if bytes(data[offset:offset + len(old)]) != old:
                sys.exit(f'{source}: unexpected bytes at {va:#x} ({label})')
            data[offset:offset + len(old)] = new
            notes.append(label)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'wb') as handle:
        handle.write(data)
    print(f'{os.path.relpath(target, ROOT)}: ' + ', '.join(notes))


def copy_named(source_dir, names, folder):
    for name in names:
        source = os.path.join(source_dir, name)
        target = os.path.join(folder, name)
        if os.path.isdir(source):
            shutil.copytree(source, target, dirs_exist_ok=True)
        elif os.path.isfile(source):
            shutil.copy2(source, target)
        else:
            sys.exit(f'{source_dir}: {name} is missing')


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def writable(folder):
    # Some packages (2009's) hold read-only files; copies keep that, and a
    # read-only file can't be replaced by the launcher's updates or removed.
    for directory, _, names in os.walk(folder):
        for name in names:
            path = os.path.join(directory, name)
            os.chmod(path, os.stat(path).st_mode | stat.S_IWRITE)


def remove(folder):
    # A place file hard link (lib/hosting.js) is only a link: removing it leaves Server/content alone.
    def retry_writable(function, path, _):
        os.chmod(path, stat.S_IWRITE)
        function(path)
    try:
        shutil.rmtree(folder, onerror=retry_writable)
    except PermissionError as error:
        sys.exit(f'{error.filename} is in use: close that year\'s client and stop its game servers, then run this again.')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('year', choices=sorted(YEARS))
    parser.add_argument('--client', required=True, help='the client exe (with --studio) or a full player folder')
    parser.add_argument('--studio', help='the same build\'s Studio folder (2016)')
    parser.add_argument('--rcc', help='the RCC exe, or for 2015 the full RCC folder (years with their own game server)')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    year = YEARS[args.year]

    with open(os.path.join(ROOT, 'Server', 'rbxsig_blob.txt'), 'rb') as handle:
        key = handle.read().strip()
    if not BLOB_RE.fullmatch(key):
        sys.exit('Server/rbxsig_blob.txt is not a 1024-bit public key blob')

    if 'studio' in year:
        if not args.studio:
            sys.exit(f'{args.year} needs --studio (its game files come from that build\'s Studio folder)')
        if file_version(os.path.join(args.studio, 'RobloxStudioBeta.exe')) != year['studio']['version']:
            sys.exit(f'{args.studio} is not the {year["studio"]["version"]} Studio folder')
        client_exe, files_from = args.client, args.studio
    else:
        if not os.path.isdir(args.client):
            sys.exit(f'{args.year} needs --client <full player folder>')
        client_exe, files_from = os.path.join(args.client, year['client'].get('exe', 'RobloxPlayerBeta.exe')), args.client
    check(client_exe, 'client', year['client'])
    rcc = year.get('rcc')
    rcc_exe = rcc_files = None
    if rcc:
        if not args.rcc:
            sys.exit(f'{args.year} needs --rcc <RCCService {"folder" if rcc.get("from_folder") else "exe"}>')
        if rcc.get('from_folder'):
            names = [n for n in os.listdir(args.rcc) if n.lower() == 'rccservice.exe'] if os.path.isdir(args.rcc) else []
            if not names:
                sys.exit(f'{args.rcc} is not an RCC folder (no RCCService.exe)')
            rcc_exe, rcc_files = os.path.join(args.rcc, names[0]), args.rcc
        else:
            rcc_exe, rcc_files = args.rcc, files_from
        check(rcc_exe, 'RCC', rcc)

    client = os.path.join(ROOT, f'Client{args.year}')
    server = os.path.join(ROOT, f'Server{args.year}')
    self_hosted = year.get('self_hosted', False)
    for folder in (client, server) if rcc or self_hosted else (client,):
        if os.path.exists(folder):
            if not args.force:
                sys.exit(f'{folder} exists already (--force replaces it)')
            remove(folder)

    exe_name = year['client'].get('exe', 'RobloxPlayerBeta.exe')
    patch_exe(client_exe, os.path.join(client, exe_name), key, registry=True, code_patches=year['client'].get('patches', ()),
              string_patches=year['client'].get('strings', ()))
    if year['client'].get('single_instance', True):
        result = single_instance().patch(os.path.join(client, exe_name))
        if 'not patched' in result or result.startswith('no '):
            sys.exit(f'Client{args.year}: {result}')
        print(f'Client{args.year}/{exe_name}: {result}')
    if 'studio' in year:
        copy_named(files_from, year['studio']['files'], client)
        shutil.rmtree(os.path.join(client, 'shaders', 'source'), ignore_errors=True)
    else:
        for name in os.listdir(files_from):
            if name in SKIP or name in (exe_name, 'AppSettings.xml'):
                continue
            copy_named(files_from, [name], client)
    write(os.path.join(client, 'AppSettings.xml'), APP_SETTINGS.format(year['base_url']))
    write(os.path.join(client, 'ClientSettings', 'ClientAppSettings.json'), year['client_flags'])
    writable(client)

    if rcc:
        patch_exe(rcc_exe, os.path.join(server, 'RCCService.exe'), key, registry=False, code_patches=rcc['patches'])
        copy_named(rcc_files, rcc['files'], server)
        copy_named(os.path.join(ROOT, 'Server'), rcc.get('repo_files', []), server)
        write(os.path.join(server, 'AppSettings.xml'), APP_SETTINGS.format('http://www.localhost./'))
        write(os.path.join(server, 'ClientSettings', 'RCCService.json'), rcc['flags'])
        for name, text in rcc.get('written', {}).items():
            write(os.path.join(server, *name.split('/')), text)
    if self_hosted:
        # The game server is the same client (lib/hosting.js starts it as the host).
        shutil.copytree(client, server)
    print(f'Client{args.year}' + (f' and Server{args.year} are' if rcc or self_hosted else ' is') + f' ready. Next: python tools/build-client-files.py client{args.year}')


if __name__ == '__main__':
    main()
