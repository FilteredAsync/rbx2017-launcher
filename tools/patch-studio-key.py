"""Make Roblox Studio trust the same script-signing key as the client and RCC.

The 2017 executables carry the public key that checks signed Lua ("--rbxsig")
as a base64 PUBLICKEYBLOB. The client and RCC here were patched to carry the
key in Server/rbxsig_blob.txt, whose private half the web server signs with
(Server/rbxsig_private.pem). This swaps whatever key Studio carries for that
one, so join scripts and the like signed by the web server work in Studio too.

    python tools/patch-studio-key.py            (patches Studio/RobloxStudioBeta.exe)
    python tools/patch-studio-key.py <exe>

Keeps a copy as RobloxStudioBeta.exe.before-key-patch; running it again does
nothing once the key is in.
"""

import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOB_RE = re.compile(rb'BgIAAA[A-Za-z0-9+/]{192}[A-Za-z0-9+/=]{2}')


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'Studio', 'RobloxStudioBeta.exe')
    with open(os.path.join(ROOT, 'Server', 'rbxsig_blob.txt'), 'rb') as f:
        wanted = f.read().strip()
    if not BLOB_RE.fullmatch(wanted):
        sys.exit('Server/rbxsig_blob.txt is not a 1024-bit public key blob.')
    with open(exe, 'rb') as f:
        data = f.read()
    if wanted in data:
        print(f'{exe}: already uses the server key.')
        return
    found = [m for m in BLOB_RE.finditer(data)]
    if len(found) != 1:
        sys.exit(f'{exe}: expected one public key blob, found {len(found)}.')
    start, end = found[0].span()
    backup = exe + '.before-key-patch'
    if not os.path.exists(backup):
        shutil.copy2(exe, backup)
    patched = data[:start] + wanted + data[end:]
    assert len(patched) == len(data)
    with open(exe, 'wb') as f:
        f.write(patched)
    print(f'{exe}: key replaced at offset {start} (backup: {os.path.basename(backup)}).')


if __name__ == '__main__':
    main()
