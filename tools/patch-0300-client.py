"""Make the stock 0.300.0.138971 game client (RobloxPlayerBeta.exe, the same build
as Server/RCCService.exe) work with this server, like the 0.299 client in Client/.

    python tools/patch-0300-client.py <RobloxPlayerBeta.exe>
    python tools/patch-studio-key.py <RobloxPlayerBeta.exe>      (the server's script key)
    python tools/patch-2017-isolation.py <RobloxPlayerBeta.exe>  (own registry key)
    python tools/patch-0300-client.py <RobloxPlayerBeta.exe> --domain rbx2017.com [--scheme https]

This script does the changes only this build needs:
  - its 13 "roblox.com" strings become "localhost." (same length), the names the
    launcher's proxy answers, as in the 0.299 client;
  - Client::playerConnect (0xBF12D7): with FFlagDebugLocalRccServerConnection on
    (RCC needs it for its "test" connection password), this build replaced the
    join script's address with localhost:53640, so every join went to whatever
    game server had port 53640. je -> jmp keeps the join script's address.

--domain (run it last, after the other patches: it copies the finished exe)
adds a second client next to this one, set up for that server's public names
instead of the launcher's localhost. proxy. RobloxPlayerBeta.exe and
AppSettings.xml stay as they are, so launchers before 1.21.1 keep starting
the localhost. client through their proxy; the same game files work with both.
  - RobloxPlayerBetaDirect.exe: a copy with six strings pointing at the domain,
    in place: its own base address (http://m.<domain>, as Roblox's was http),
    assetgame., the API address format and three lists of its own sites (the
    plain list entry is the one its join trust check reads, so this client
    no longer trusts localhost.). Each must fit its string's slot (the string
    and its padding up to the next 4-byte boundary), so where the domain is
    longer than "roblox.com" an entry loses its leading dot or trailing slash,
    and the API format the slash before "?". It reads AppSettingD.xml instead
    of AppSettings.xml: the name must keep its length (a longer one overruns
    the client's buffer and it quits at start).
  - AppSettingD.xml: AppSettings.xml with BaseUrl http://m.<domain>/ (byte for
    byte otherwise: the client's reader needs its CRLF line ends).
  - ClientDirect.txt: <scheme>://m.<domain>/, the base address the launcher
    (lib/joining.js, 1.21.1 on) starts RobloxPlayerBetaDirect.exe with, with no
    local web proxy (http on Windows 7 and 8). Its names under <domain> (m.,
    api., assetgame., clientsettings.api., ephemeralcounters.api.) are the ones
    the VPS already serves for the Android app (tools/vps/setup-vps.sh
    --android). The game's UDP still goes through the launcher's relay.

The matching shaders and content come from the same build's client folder: the
0.300 renderer draws no 3D world with the 0.299 shader packs. RCC disconnects
this build right after joining unless patch-rcc-signature.ps1 has run (see
lib/hosting.js). Runs again safely: patched parts are skipped, and the second
client is made again from RobloxPlayerBeta.exe each time.
"""
import os
import re
import sys

import pefile

REDIRECT_VA, REDIRECT_OLD, REDIRECT_NEW = 0xBF12D7, bytes([0x74, 0x16]), bytes([0xEB, 0x16])

DIRECT_EXE = 'RobloxPlayerBetaDirect.exe'
DIRECT_MARKER = 'ClientDirect.txt'
SETTINGS, DIRECT_SETTINGS = 'AppSettings.xml', 'AppSettingD.xml'
SETTINGS_PATH = (b'\\' + SETTINGS.encode('ascii'), b'\\' + DIRECT_SETTINGS.encode('ascii'))

# The client's own names (localhost. after the swap) that --domain rewrites in
# the second client, and the forms to try for a domain, longest first; each
# gets the first that fits.
DOMAIN_STRINGS = [
    (b'http://www.localhost.', lambda d: [f'http://m.{d}']),
    (b'assetgame.localhost.', lambda d: [f'assetgame.{d}']),
    (b'localhost.', lambda d: [d]),
    (b'.localhost.', lambda d: [f'.{d}', d]),
    (b'localhost./', lambda d: [f'{d}/', d]),
    (b'%s://%sapi.localhost./%s/?apiKey=%s',
     lambda d: [f'%s://%sapi.{d}/%s/?apiKey=%s', f'%s://%sapi.{d}/%s?apiKey=%s']),
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


def only(data, text, what):
    spots = c_strings(data, text)
    if len(spots) != 1:
        sys.exit(f'"{text.decode()}" ({what}) is in the file {len(spots)} times, expected once:'
                 ' RobloxPlayerBeta.exe must be the localhost. client')
    return spots[0]


def point_at_domain(data, domain, notes):
    for old, forms in DOMAIN_STRINGS:
        candidates = [form.encode('ascii') for form in forms(domain)]
        start = only(data, old, 'a name to point at the domain')
        room = slot(data, start, len(old))
        new = next((candidate for candidate in candidates if len(candidate) < room), None)
        if new is None:
            sys.exit(f'{domain} is too long for "{old.decode()}" ({room - 1} characters at most)')
        data[start:start + room] = new + b'\0' * (room - len(new))
        notes.append(f'{old.decode()} -> {new.decode()}')
    old, new = SETTINGS_PATH
    start = only(data, old, 'the settings file')
    data[start:start + len(old)] = new
    notes.append(f'reads {DIRECT_SETTINGS}')


def write_direct(folder, data, domain, scheme, notes):
    with open(os.path.join(folder, DIRECT_EXE), 'wb') as handle:
        handle.write(data)
    settings = os.path.join(folder, SETTINGS)
    if not os.path.isfile(settings):
        sys.exit(f'{settings} is missing: the client needs it next to the exe')
    text = open(settings, 'rb').read()
    direct, count = re.subn(rb'<BaseUrl>[^<]*</BaseUrl>', f'<BaseUrl>http://m.{domain}/</BaseUrl>'.encode('ascii'), text)
    if count != 1:
        sys.exit(f'{settings} has {count} <BaseUrl> elements, expected one')
    with open(os.path.join(folder, DIRECT_SETTINGS), 'wb') as handle:
        handle.write(direct)
    base = f'{scheme}://m.{domain}/'
    with open(os.path.join(folder, DIRECT_MARKER), 'wb') as handle:
        handle.write(f'{base}\n'.encode('ascii'))
    # The first version of --domain changed RobloxPlayerBeta.exe in place and
    # left this file; launcher 1.21.0 would start the localhost. client with it.
    stale = os.path.join(folder, 'ClientDomain.txt')
    if os.path.isfile(stale):
        os.remove(stale)
        notes.append('removed ClientDomain.txt')
    notes.append(f'{DIRECT_EXE}, {DIRECT_SETTINGS} (http://m.{domain}/) and {DIRECT_MARKER} ({base})')


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

    with open(exe, 'wb') as handle:
        handle.write(data)

    if domain is not None:
        direct = bytearray(data)
        point_at_domain(direct, domain, notes)
        write_direct(os.path.dirname(os.path.abspath(exe)), direct, domain, scheme, notes)
    print(f'{os.path.basename(exe)}: ' + '; '.join(notes))


if __name__ == '__main__':
    main()
