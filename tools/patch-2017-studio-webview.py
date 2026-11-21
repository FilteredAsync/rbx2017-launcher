"""Let 2017 Studio's web pages (Toolbox, start page, web dialogs) load.

Studio builds the address of every page it shows in its web view from the base
URL in AppSettings.xml (http://localhost./ here), and RobloxSettings::getBaseURL
forces the scheme to https. Those pages go through Qt's own network stack, which
checks certificates against Windows' trusted roots. The launcher's proxy on
https://localhost. has a self-signed certificate, so Qt drops every such page
after the handshake ("The certificate is self-signed, and untrusted", then "SSL
handshake failed"), without sending the request: the Toolbox stays blank.
Studio's own engine requests (WinINet) accept any certificate and are not
affected.

getBaseURL's QString("https") is pointed at an "http" string that is already in
the file, so the web view uses http://localhost./ (the proxy's port 80, no TLS).
Only that one push changes: the "https" string is shared by 23 other places,
engine code included, and stays as it is. The new operand is an address inside
the image like the old one, so the relocation entry for it still applies.

    python tools/patch-2017-studio-webview.py                 (Studio/RobloxStudioBeta.exe)
    python tools/patch-2017-studio-webview.py <exe>
    python tools/patch-2017-studio-webview.py --check         (report only)
    python tools/patch-2017-studio-webview.py --backup <dir>  (copy the exe there first)

The file size never changes. Running it again does nothing once patched.
Made for Studio 0.299.0.136981; on any other build it refuses rather than guess.
"""

import os
import shutil
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, 'Studio', 'RobloxStudioBeta.exe')

HTTPS_VA = 0x1229470  # "https" (shared)
HTTP_VA = 0x155A314   # "http", a string of its own
# In getBaseURL (0x6a6640): ~QString(); push "https"; lea ecx, [ebp-0x14]; QString(const char*)
BEFORE = bytes.fromhex('8d4de8c645fc02ff1580e91d01')
AFTER = bytes.fromhex('8d4decff1564e91d01')
SITE_OLD = BEFORE + b'\x68' + struct.pack('<I', HTTPS_VA) + AFTER
SITE_NEW = BEFORE + b'\x68' + struct.pack('<I', HTTP_VA) + AFTER


def sections(data):
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    count = struct.unpack_from('<H', data, pe + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    image_base = struct.unpack_from('<I', data, pe + 24 + 28)[0]
    table = pe + 24 + optional_size
    result = []
    for index in range(count):
        entry = table + index * 40
        virtual_size, virtual_address, raw_size, raw_pointer = struct.unpack_from('<IIII', data, entry + 8)
        result.append((image_base + virtual_address, virtual_size, raw_pointer, raw_size))
    return result


def string_at(data, va):
    for start, size, pointer, raw_size in sections(data):
        if start <= va < start + min(size, raw_size):
            at = pointer + va - start
            return bytes(data[at:data.index(b'\0', at) + 1]), data[at - 1]
    return None, None


def patch(path, check_only=False, backup_dir=None):
    with open(path, 'rb') as handle:
        data = bytearray(handle.read())
    if string_at(data, HTTPS_VA)[0] != b'https\0':
        return f'{path}: not Studio 0.299.0.136981 (no "https" where expected); left alone'
    text, before = string_at(data, HTTP_VA)
    if text != b'http\0' or before != 0:
        return f'{path}: not Studio 0.299.0.136981 (no "http" where expected); left alone'
    if data.count(SITE_NEW) == 1 and data.count(SITE_OLD) == 0:
        return f'{path}: already patched'
    if data.count(SITE_OLD) != 1:
        return f'{path}: getBaseURL not found; left alone'
    if check_only:
        return f'{path}: needs patching'
    if backup_dir:
        os.makedirs(backup_dir, exist_ok=True)
        shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))
    at = data.find(SITE_OLD)
    data[at:at + len(SITE_OLD)] = SITE_NEW
    temp = path + '.patching'
    with open(temp, 'wb') as handle:
        handle.write(data)
    os.replace(temp, path)
    return f'{path}: patched'


def main(argv):
    check_only = '--check' in argv
    backup_dir = None
    if '--backup' in argv:
        index = argv.index('--backup')
        backup_dir = argv[index + 1]
        del argv[index:index + 2]
    paths = [arg for arg in argv if not arg.startswith('--')] or [DEFAULT_EXE]
    for path in paths:
        print(patch(path, check_only, backup_dir))


if __name__ == '__main__':
    main(sys.argv[1:])
