"""Let 2017 Studio load its FastFlags (ClientAppSettings).

At start Studio downloads its flags from
<scheme>://clientsettings.api.<domain>/Setting/QuietGet/ClientAppSettings,
and only then reads its own ClientSettings/ClientAppSettings.json. The address
comes from the base URL in AppSettings.xml, which is http://localhost./ here:
the engine's address builder only knows www./m./sitetest3 bases on roblox.com
(patched to localhost.), so it returns an empty address, the download throws,
Studio logs "Failed to load settings" and skips its local file too. Studio then
runs with no flags at all: every 2017 feature that is switched off by default
stays off (UITableLayout, WeldConstraint, CollectionService tags, UIPadding,
collision groups...), so places that use them fail to open ("UITableLayout is
not yet enabled!", Jailbreak) or behave unlike the game client.

The builder's "sitetest3" branch is pointed at localhost. bases:
  - the test ".sitetest3" becomes "localhost." (same length), which matches
    the "localhost./" left of http://localhost./;
  - its format "%s://%sapi.sitetest3%s/%s/?apiKey=%s" becomes
    "%s://%sapi.localhost.%.0s/%s/?apiKey=%s" (the domain argument is dropped
    with %.0s), within the string's own padding. The host keeps the trailing
    dot: the engine only trusts hosts that end in "localhost." (its patched
    "roblox.com"), and refuses the others before sending anything.
So Studio asks http://clientsettings.api.localhost./Setting/QuietGet/ClientAppSettings/
(listed in the hosts file by addHostsEntries.bat), the launcher's proxy passes
it to the server (lib/routes.js clientAppSettings), and then the local file is
read on top. The same builder also gives Studio's other api. addresses
(ephemeralcounters, versioncompatibility, game/players): they now reach the
server too, instead of failing before any request.

    python tools/patch-2017-studio-settings.py                 (Studio/RobloxStudioBeta.exe)
    python tools/patch-2017-studio-settings.py <exe>
    python tools/patch-2017-studio-settings.py --check         (report only)
    python tools/patch-2017-studio-settings.py --backup <dir>  (copy the exe there first)

The file size never changes. Running it again does nothing once patched.
Made for Studio 0.299.0.136981; on any other build it refuses rather than guess.
"""

import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, 'Studio', 'RobloxStudioBeta.exe')
NUL = bytes(1)

# The sitetest3 test string sits right before the branch's format string:
# ".sitetest3" + 2 NULs (12 bytes), then the format + 4 NULs (40 bytes).
TEST_OLD = b'.sitetest3' + NUL * 2
TEST_NEW = b'localhost.' + NUL * 2
FORMAT_OLD = b'%s://%sapi.sitetest3%s/%s/?apiKey=%s' + NUL * 4
FORMAT_NEW = b'%s://%sapi.localhost.%.0s/%s/?apiKey=%s' + NUL
assert len(TEST_OLD) == len(TEST_NEW) and len(FORMAT_OLD) == len(FORMAT_NEW)
# The strings around them in Studio 0.299.0.136981, to be sure it is that build.
NEIGHBOURS = [b'https://www' + NUL, b'http://m' + NUL, b'%s://%sapi.localhost./%s/?apiKey=%s' + NUL]


def patch(path, check_only=False, backup_dir=None):
    with open(path, 'rb') as handle:
        data = bytearray(handle.read())
    for neighbour in NEIGHBOURS:
        if data.count(neighbour) != 1:
            return f'{path}: not Studio 0.299.0.136981 (address builder strings differ); left alone'
    if data.count(FORMAT_NEW) == 1:
        at = data.find(FORMAT_NEW)
        if data[at - len(TEST_NEW):at] == TEST_NEW:
            return f'{path}: already patched'
        return f'{path}: half patched?; left alone'
    if data.count(FORMAT_OLD) != 1:
        return f'{path}: address builder format not found; left alone'
    at = data.find(FORMAT_OLD)
    if data[at - len(TEST_OLD):at] != TEST_OLD:
        return f'{path}: sitetest3 test not where expected; left alone'
    if check_only:
        return f'{path}: needs patching'
    if backup_dir:
        os.makedirs(backup_dir, exist_ok=True)
        shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))
    data[at - len(TEST_OLD):at] = TEST_NEW
    data[at:at + len(FORMAT_OLD)] = FORMAT_NEW
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
