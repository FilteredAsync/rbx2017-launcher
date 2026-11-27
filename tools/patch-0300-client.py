"""Make the stock 0.300.0.138971 game client (RobloxPlayerBeta.exe, the same build
as Server/RCCService.exe) work with this server, like the 0.299 client in Client/.

    python tools/patch-0300-client.py <RobloxPlayerBeta.exe> [--domain rbx2017.com] [--scheme https]
    python tools/patch-studio-key.py <RobloxPlayerBeta.exe>      (the server's script key)
    python tools/patch-2017-isolation.py <RobloxPlayerBeta.exe>  (own registry key)

This script does the changes only this build needs:
  - its 13 "roblox.com" strings become "localhost." (same length), the names the
    launcher's proxy answers, as in the 0.299 client;
  - Client::playerConnect (0xBF12D7): with FFlagDebugLocalRccServerConnection on
    (RCC needs it for its "test" connection password), this build replaced the
    join script's address with localhost:53640, so every join went to whatever
    game server had port 53640. je -> jmp keeps the join script's address.

--domain points the client straight at that server's public names instead of
the launcher's localhost. proxy. <scheme>://m.<domain>/ becomes its base
(BaseUrl in the AppSettings.xml next to the exe; the launcher uses http on
Windows 7 and 8), and the engine's own names
under <domain> (api., assetgame., clientsettings.api., ephemeralcounters.api.)
are the ones the VPS already serves for the Android app
(tools/vps/setup-vps.sh --android). Six of the strings get the domain, in place:
the base address, assetgame., the API address format and three lists of the
client's own sites. Each must fit its string's slot (the string and its
padding up to the next 4-byte boundary), so where the domain is longer than
"roblox.com" a list entry loses its leading dot or trailing slash, and the API
format the slash before "?". The rest (help texts, the analytics address, the
place file schema, the started-event name) stay localhost. ClientDomain.txt
next to the exe holds the base address: the launcher (lib/joining.js) then
starts this client with those names and no local web proxy. The game's UDP
traffic still goes through the launcher's relay (lib/relay.js).

The matching shaders and content come from the same build's client folder: the
0.300 renderer draws no 3D world with the 0.299 shader packs. RCC disconnects
this build right after joining unless patch-rcc-signature.ps1 has run (see
lib/hosting.js). Runs again safely: patched parts are skipped.
"""
import os
import re
import sys

import pefile

REDIRECT_VA, REDIRECT_OLD, REDIRECT_NEW = 0xBF12D7, bytes([0x74, 0x16]), bytes([0xEB, 0x16])

# The client's own names (localhost. after the swap) that --domain rewrites, and
# the forms to try for a domain, longest first; each gets the first that fits.
DOMAIN_STRINGS = [
    # Its own base address stays http, as Roblox's was (http://www.roblox.com):
    # the VPS answers both, and Windows 7 may not get through TLS.
    (b'http://www.localhost.', lambda d, s: [f'http://m.{d}']),
    (b'assetgame.localhost.', lambda d, s: [f'assetgame.{d}']),
    (b'localhost.', lambda d, s: [d]),
    (b'.localhost.', lambda d, s: [f'.{d}', d]),
    (b'localhost./', lambda d, s: [f'{d}/', d]),
    (b'%s://%sapi.localhost./%s/?apiKey=%s',
     lambda d, s: [f'%s://%sapi.{d}/%s/?apiKey=%s', f'%s://%sapi.{d}/%s?apiKey=%s']),
]


def c_strings(data, text):
    """Offsets where text stands as a whole C string (a NUL before and after it)."""
    needle = b'\0' + text + b'\0'
    found = []
    at = data.find(needle)
    while at >= 0:
        found.append(at + 1)
        at = data.find(needle, at + 1)
    return found


def slot(data, start, length):
    """How many bytes the string at start may use, its NUL included: up to the
    next 4-byte boundary after its NUL, as long as those bytes are padding."""
    end = (start + length + 1 + 3) & ~3
    return end - start if not any(data[start + length:end]) else length + 1


def point_at_domain(data, domain, scheme, notes):
    for old, forms in DOMAIN_STRINGS:
        candidates = [form.encode('ascii') for form in forms(domain, scheme)]
        spots = c_strings(data, old)
        if not spots:
            if any(c_strings(data, candidate) for candidate in candidates):
                notes.append(f'{old.decode()}: already {domain}')
                continue
            sys.exit(f'no "{old.decode()}" string to point at {domain}')
        if len(spots) != 1:
            sys.exit(f'"{old.decode()}" is in the file {len(spots)} times, expected once')
        start = spots[0]
        room = slot(data, start, len(old))
        new = next((candidate for candidate in candidates if len(candidate) < room), None)
        if new is None:
            sys.exit(f'{domain} is too long for "{old.decode()}" ({room - 1} characters at most)')
        data[start:start + room] = new + b'\0' * (room - len(new))
        notes.append(f'{old.decode()} -> {new.decode()}')


def set_base_url(folder, base):
    """BaseUrl in the client's AppSettings.xml, and ClientDomain.txt for the launcher."""
    settings = os.path.join(folder, 'AppSettings.xml')
    if not os.path.isfile(settings):
        sys.exit(f'{settings} is missing: the client needs it next to the exe')
    text = open(settings, 'rb').read()
    updated, count = re.subn(rb'<BaseUrl>[^<]*</BaseUrl>', b'<BaseUrl>' + base.encode('ascii') + b'</BaseUrl>', text)
    if count != 1:
        sys.exit(f'{settings} has {count} <BaseUrl> elements, expected one')
    if updated != text:
        with open(settings, 'wb') as handle:
            handle.write(updated)
    with open(os.path.join(folder, 'ClientDomain.txt'), 'wb') as handle:
        handle.write(f'{base}\n'.encode('ascii'))


def main():
    args = sys.argv[1:]
    domain, scheme = None, 'https'
    exe = None
    while args:
        arg = args.pop(0)
        if arg == '--domain' and args:
            domain = args.pop(0).strip().lower().rstrip('.')
        elif arg == '--scheme' and args:
            scheme = args.pop(0).strip().lower()
        elif exe is None and not arg.startswith('--'):
            exe = arg
        else:
            sys.exit(__doc__)
    if exe is None:
        sys.exit(__doc__)
    if domain is not None and not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', domain):
        sys.exit(f'--domain {domain!r} is not a domain name')
    if scheme not in ('http', 'https'):
        sys.exit('--scheme is http or https')

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

    if domain is not None:
        point_at_domain(data, domain, scheme, notes)

    with open(exe, 'wb') as handle:
        handle.write(data)
    if domain is not None:
        base = f'{scheme}://m.{domain}/'
        set_base_url(os.path.dirname(os.path.abspath(exe)), base)
        notes.append(f'BaseUrl and ClientDomain.txt: {base}')
    print(f'{os.path.basename(exe)}: ' + '; '.join(notes))


if __name__ == '__main__':
    main()
