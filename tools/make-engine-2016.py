"""Builds the 2016 engine (0.254.0.80823, July 2016): Client2016/ (the game
client the launcher downloads for games set to 2016 on /manage) and
Server2016/ (their game server, RCCService), next to Client/ and Server/.

    python tools/make-engine-2016.py --studio <folder> --client <exe> --rcc <exe>

  --studio  the 0.254.0.80823 Studio folder (version-ff140f5bd46141f7): it has
            that build's content, PlatformContent, shaders and DLLs, which the
            client and RCC of the same build need (archive.org item
            roblox_studio_version-ff140f5bd46141f7_completeclientarchive)
  --client  RobloxPlayerBeta 0.254.0.80823 (archive.org funarchive, RobloxClient/)
  --rcc     RCCService 0.254.0.80823 (funarchive, RCCService/)
  --force   replace existing Client2016/ and Server2016/

Nothing here runs the programs. The originals are left as they are; the
copies get these changes (same file size):
  client  "roblox.com" -> "localhost." (17), the server's script key
          (Server/rbxsig_blob.txt), and its registry key moved to
          "ROBLOX2017 Revival" like the 2017 client (6 paths)
  RCC     "roblox.com" -> "localhost." (15), the script key, and two checks
          that kick every client here (each is byte-patched):
          - Players::hashMatches (0xC04D85, je -> nop nop): the exe-hash check,
            "ID = 148: ROBLOX version is out of date" right after connecting
          - Players::onRemoteSysStats (0xC08A9D, willKick 1 -> 0): the
            anti-cheat report kick, "This game has shut down" after joining
The RCC runs without FFlagDebugLocalRccServerConnection: this client has no
such switch, so with it the two sides' connection passwords differ. Without
it RCC checks client versions against the web server's lists, which
lib/routes.js answers empty (check nothing).
Then run python tools/build-client-files.py client2016 to pack the client for
launchers; Server2016/ goes to a server as a private update (it is Roblox's).
"""

import argparse
import hashlib
import os
import re
import shutil
import sys

import pefile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = b'0, 254, 0, 80823'
CLIENT_MD5 = '18701f7557e1a4c4240cf17041b2d1dd'
RCC_MD5 = '17067558fdc53cfead09233bc8259298'
BLOB_RE = re.compile(rb'BgIAAA[A-Za-z0-9+/]{192}[A-Za-z0-9+/=]{2}')
REG_OLD, REG_NEW = b'\\ROBLOX Corporation\\Roblox', b'\\ROBLOX2017 Revival\\Roblox'
RCC_PATCHES = [
    ('client hash check', 0xC04D85, bytes([0x74, 0x12]), bytes([0x90, 0x90])),
    ('anti-cheat report kick', 0xC08A9D, bytes([0xC6, 0x45, 0x17, 0x01]), bytes([0xC6, 0x45, 0x17, 0x00])),
]
CLIENT_FILES = ['content', 'PlatformContent', 'shaders', 'fmod.dll', 'SDL2.dll', 'd3dcompiler_47.dll',
                'msvcp110.dll', 'msvcr110.dll', 'openvr_api.dll', 'ReflectionMetadata.xml']
SERVER_FILES = ['content', 'PlatformContent', 'fmod.dll', 'VMProtectSDK32.dll', 'msvcp110.dll', 'msvcr110.dll']
# The 2016 reader of AppSettings.xml needs CRLF line ends.
APP_SETTINGS = ('<?xml version="1.0" encoding="UTF-8"?>\r\n<Settings>\r\n\t<ContentFolder>content</ContentFolder>\r\n'
                '\t<BaseUrl>{}</BaseUrl>\r\n</Settings>')


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
    return version


def check(path, kind, expected_md5):
    if not os.path.isfile(path):
        sys.exit(f'{kind}: {path} not found')
    if file_version(path) != VERSION:
        sys.exit(f'{kind}: {path} is not 0.254.0.80823')
    if md5(path) != expected_md5:
        sys.exit(f'{kind}: {path} is not the archive.org copy this tool knows (MD5 {expected_md5})')


def patch_exe(source, target, key, registry, code_patches=()):
    data = bytearray(open(source, 'rb').read())
    notes = [f'{data.count(b"roblox.com")} x roblox.com -> localhost.']
    data = bytearray(bytes(data).replace(b'roblox.com', b'localhost.'))
    blobs = list(BLOB_RE.finditer(data))
    if len(blobs) != 1:
        sys.exit(f'{source}: expected one script key, found {len(blobs)}')
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


def copy_from_studio(studio, names, folder):
    for name in names:
        source = os.path.join(studio, name)
        target = os.path.join(folder, name)
        if os.path.isdir(source):
            shutil.copytree(source, target, dirs_exist_ok=True)
        elif os.path.isfile(source):
            shutil.copy2(source, target)
        else:
            sys.exit(f'{studio}: {name} is missing (not the 0.254.0.80823 Studio folder?)')


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--studio', required=True)
    parser.add_argument('--client', required=True)
    parser.add_argument('--rcc', required=True)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()

    studio = os.path.abspath(args.studio)
    studio_exe = os.path.join(studio, 'RobloxStudioBeta.exe')
    if not os.path.isfile(studio_exe) or file_version(studio_exe) != VERSION:
        sys.exit(f'{studio} is not the 0.254.0.80823 Studio folder')
    check(args.client, 'client', CLIENT_MD5)
    check(args.rcc, 'RCC', RCC_MD5)
    with open(os.path.join(ROOT, 'Server', 'rbxsig_blob.txt'), 'rb') as handle:
        key = handle.read().strip()
    if not BLOB_RE.fullmatch(key):
        sys.exit('Server/rbxsig_blob.txt is not a 1024-bit public key blob')

    client = os.path.join(ROOT, 'Client2016')
    server = os.path.join(ROOT, 'Server2016')
    for folder in (client, server):
        if os.path.exists(folder):
            if not args.force:
                sys.exit(f'{folder} exists already (--force replaces it)')
            # A place file hard link (lib/hosting.js) is only a link: removing it leaves Server/content alone.
            try:
                shutil.rmtree(folder)
            except PermissionError as error:
                sys.exit(f'{error.filename} is in use: close the 2016 client and stop its game servers, then run this again.')

    patch_exe(args.client, os.path.join(client, 'RobloxPlayerBeta.exe'), key, registry=True)
    copy_from_studio(studio, CLIENT_FILES, client)
    shutil.rmtree(os.path.join(client, 'shaders', 'source'), ignore_errors=True)
    write(os.path.join(client, 'AppSettings.xml'), APP_SETTINGS.format('http://localhost./'))
    write(os.path.join(client, 'ClientSettings', 'ClientAppSettings.json'), '{\n}\n')

    patch_exe(args.rcc, os.path.join(server, 'RCCService.exe'), key, registry=False, code_patches=RCC_PATCHES)
    copy_from_studio(studio, SERVER_FILES, server)
    write(os.path.join(server, 'AppSettings.xml'), APP_SETTINGS.format('http://www.localhost./'))
    write(os.path.join(server, 'ClientSettings', 'RCCService.json'), '{\n  "FLogGoldenHashes": 7\n}\n')
    print('Client2016 and Server2016 are ready. Next: python tools/build-client-files.py client2016')


if __name__ == '__main__':
    main()
