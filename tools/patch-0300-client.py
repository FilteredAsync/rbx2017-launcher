"""Make the stock 0.300.0.138971 game client (RobloxPlayerBeta.exe, the same build
as Server/RCCService.exe) work with this server, like the 0.299 client in Client/.

    python tools/patch-0300-client.py <RobloxPlayerBeta.exe>
    python tools/patch-studio-key.py <RobloxPlayerBeta.exe>      (the server's script key)
    python tools/patch-2017-isolation.py <RobloxPlayerBeta.exe>  (own registry key)

This script does the two changes only this build needs:
  - its 13 "roblox.com" strings become "localhost." (same length), the names the
    launcher's proxy answers, as in the 0.299 client;
  - Client::playerConnect (0xBF12D7): with FFlagDebugLocalRccServerConnection on
    (RCC needs it for its "test" connection password), this build replaced the
    join script's address with localhost:53640, so every join went to whatever
    game server had port 53640. je -> jmp keeps the join script's address.
The matching shaders and content come from the same build's client folder: the
0.300 renderer draws no 3D world with the 0.299 shader packs. RCC disconnects
this build right after joining unless patch-rcc-signature.ps1 has run (see
lib/hosting.js). Runs again safely: patched parts are skipped.
"""
import os
import sys

import pefile

REDIRECT_VA, REDIRECT_OLD, REDIRECT_NEW = 0xBF12D7, bytes([0x74, 0x16]), bytes([0xEB, 0x16])


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    exe = sys.argv[1]
    pe = pefile.PE(exe, fast_load=True)
    version = None
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    for info in getattr(pe, 'FileInfo', []) or []:
        for entry in info:
            for table in getattr(entry, 'StringTable', []):
                version = table.entries.get(b'FileVersion', version)
    off = pe.get_offset_from_rva(REDIRECT_VA - pe.OPTIONAL_HEADER.ImageBase)
    pe.close()  # pefile keeps the file mapped; Windows refuses the write otherwise
    if version != b'0, 300, 0, 138971':
        sys.exit(f'{exe}: file version {version!r}, not the 0.300.0.138971 client')

    data = bytearray(open(exe, 'rb').read())
    notes = []
    old, new = b'roblox.com', b'localhost.'
    count = data.count(old)
    at = data.find(old)
    while at >= 0:
        data[at:at + len(old)] = new
        at = data.find(old, at + 1)
    notes.append(f'{count} x roblox.com -> localhost.' if count else 'addresses: already localhost.')

    here = bytes(data[off:off + 2])
    if here == REDIRECT_NEW:
        notes.append('join address: already kept')
    elif here == REDIRECT_OLD:
        data[off:off + 2] = REDIRECT_NEW
        notes.append('join address: kept with the debug connection flag (je -> jmp)')
    else:
        sys.exit(f'{exe}: unexpected bytes {here.hex()} at {REDIRECT_VA:#x}')

    with open(exe, 'wb') as handle:
        handle.write(data)
    print(f'{os.path.basename(exe)}: ' + '; '.join(notes))


if __name__ == '__main__':
    main()
