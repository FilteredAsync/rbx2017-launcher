"""Keep the 2017 client and Studio out of the real Roblox's registry keys.

Both 2017 programs keep settings and crash markers under
HKCU\\Software\\ROBLOX Corporation\\Roblox, and 2017 Studio's Qt settings
(window layout, recent files, login) land on HKCU\\Software\\Roblox\\RobloxStudio:
the same keys the real, current Roblox and Studio use. This moves them to
HKCU\\Software\\ROBLOX2017 Revival (the files themselves are already kept
apart by the launcher's private profile folder, lib/joining.js isolatedEnv).

  - "ROBLOX Corporation" in the registry paths becomes "ROBLOX2017 Revival"
    (same length): 5 paths in the client, 3 in Studio.
  - Studio's Qt organization name: its 9 uses (setOrganizationName and the
    QSettings("Roblox", ...) calls) are pointed at a new "ROBLOX2017 Revival"
    string written into unused space at the end of .rdata. The "Roblox"
    string itself stays, because Studio also uses it elsewhere.
  - Studio's own folder, QDir::homePath() + "/AppData/Local/Roblox" (the
    default Plugins folder, InstalledPlugins, CoreScriptOverrides and
    ScriptAutosaves): homePath() ignores the launcher's USERPROFILE, so 2017
    Studio loaded the real Studio's plugins (modern Luau, which fails to
    compile). Its one use is pointed at "/AppData/Local/ROBLOX2017 Revival",
    a second new string in the same free space.

    python tools/patch-2017-isolation.py                 (Client/ and Studio/ exes)
    python tools/patch-2017-isolation.py <exe> [<exe>...]
    python tools/patch-2017-isolation.py --check         (report only)
    python tools/patch-2017-isolation.py --backup <dir>  (copy each exe there first)

The file size never changes. Running it again does nothing once patched.
Made for client 0.299 (RobloxPlayerBeta.exe) and Studio 0.299.0.136981; on
any other build it refuses rather than guess.
"""

import os
import shutil
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD_VENDOR = b'ROBLOX Corporation'
NEW_VENDOR = b'ROBLOX2017 Revival'
assert len(OLD_VENDOR) == len(NEW_VENDOR)
REG_OLD = b'\\' + OLD_VENDOR + b'\\Roblox'
REG_NEW = b'\\' + NEW_VENDOR + b'\\Roblox'

# Studio: the push instructions (VA of the 0x68 opcode) that pass the Qt
# organization name "Roblox": QCoreApplication::setOrganizationName at
# 0x5e1529, the rest are QSettings("Roblox", <application>) constructions.
STUDIO_QT_ORG_PUSHES = [0x591134, 0x591b23, 0x5e1529, 0x618482, 0x618c12, 0x619a41, 0x61a21b, 0x661e6b, 0x66c3fa]
QT_ORG_OLD = b'Roblox\0'
QT_ORG_NEW = NEW_VENDOR + b'\0'
# Where the new string goes: this many bytes before the end of .rdata's raw data.
QT_ORG_SLOT_FROM_END = 32

# Studio: the push of "/AppData/Local/Roblox" after QDir::homePath() in the
# AppSettings setup (0x6a62c0 calls homePath, 0x6a62d4 joins the two).
STUDIO_APPDATA_PUSH = 0x6a62c6
APPDATA_OLD = b'/AppData/Local/Roblox\0'
APPDATA_NEW = b'/AppData/Local/' + NEW_VENDOR + b'\0'
# Its new string sits just before the Qt organization one.
APPDATA_SLOT_FROM_END = QT_ORG_SLOT_FROM_END + 40
assert APPDATA_SLOT_FROM_END - QT_ORG_SLOT_FROM_END >= len(APPDATA_NEW)

EXPECTED_REG_PATHS = {'client': 5, 'studio': 3}


class PE:
    def __init__(self, data):
        pe = struct.unpack_from('<I', data, 0x3C)[0]
        if data[pe:pe + 4] != b'PE\0\0':
            raise ValueError('not a PE file')
        count = struct.unpack_from('<H', data, pe + 6)[0]
        optional = struct.unpack_from('<H', data, pe + 20)[0]
        self.base = struct.unpack_from('<I', data, pe + 24 + 28)[0]
        self.sections = []
        for i in range(count):
            at = pe + 24 + optional + 40 * i
            name = data[at:at + 8].rstrip(b'\0').decode('latin1')
            vsize, rva, rsize, raw = struct.unpack_from('<IIII', data, at + 8)
            self.sections.append({'name': name, 'header': at, 'vsize': vsize, 'rva': rva, 'rsize': rsize, 'raw': raw})

    def section(self, name):
        for s in self.sections:
            if s['name'] == name:
                return s
        raise ValueError(f'no {name} section')

    def va_to_offset(self, va):
        rva = va - self.base
        for s in self.sections:
            if s['rva'] <= rva < s['rva'] + max(s['vsize'], s['rsize']) and rva - s['rva'] < s['rsize']:
                return s['raw'] + rva - s['rva']
        return None

    def offset_to_va(self, offset):
        for s in self.sections:
            if s['raw'] <= offset < s['raw'] + s['rsize']:
                return self.base + s['rva'] + offset - s['raw']
        return None


def kind_of(path, data):
    name = os.path.basename(path).lower()
    if b'Qt5Core.dll' in data or 'studio' in name:
        return 'studio'
    return 'client'


def patch_registry_paths(data, kind, notes):
    old = data.count(REG_OLD)
    new = data.count(REG_NEW)
    expected = EXPECTED_REG_PATHS[kind]
    if old + new != expected:
        raise ValueError(f'expected {expected} registry paths, found {old} unpatched and {new} patched')
    if old == 0:
        notes.append(f'registry paths: already {NEW_VENDOR.decode()} ({new})')
        return 0
    at = data.find(REG_OLD)
    while at >= 0:
        data[at:at + len(REG_OLD)] = REG_NEW
        at = data.find(REG_OLD, at + 1)
    notes.append(f'registry paths: {old} changed to {NEW_VENDOR.decode()}')
    return old


def patch_studio_qt_org(data, notes):
    pe = PE(bytes(data[:4096]))  # the headers are all it reads
    rdata = pe.section('.rdata')
    slot = rdata['raw'] + rdata['rsize'] - QT_ORG_SLOT_FROM_END
    slot_va = pe.offset_to_va(slot)
    sites = []
    for va in STUDIO_QT_ORG_PUSHES:
        off = pe.va_to_offset(va)
        if off is None or data[off] != 0x68:
            raise ValueError(f'no push at {va:#x}: not the expected Studio build')
        sites.append((va, off, struct.unpack_from('<I', data, off + 1)[0]))
    targets = {target for _, _, target in sites}
    if targets == {slot_va}:
        if bytes(data[slot:slot + len(QT_ORG_NEW)]) != QT_ORG_NEW:
            raise ValueError('Qt organization already repointed, but the new string is missing')
        notes.append(f'Qt organization: already {NEW_VENDOR.decode()}')
        return 0
    if len(targets) != 1:
        raise ValueError(f'the Qt organization pushes point at {len(targets)} different strings')
    old_va = targets.pop()
    old_off = pe.va_to_offset(old_va)
    if bytes(data[old_off:old_off + len(QT_ORG_OLD)]) != QT_ORG_OLD:
        raise ValueError('the Qt organization pushes do not point at "Roblox": not the expected Studio build')
    end_of_data = rdata['raw'] + rdata['vsize']
    if end_of_data > slot or any(data[slot:rdata['raw'] + rdata['rsize']]):
        raise ValueError('no free space at the end of .rdata')
    data[slot:slot + len(QT_ORG_NEW)] = QT_ORG_NEW
    # Cover the new string with the section's size in memory (same pages).
    new_vsize = slot + len(QT_ORG_NEW) - rdata['raw']
    struct.pack_into('<I', data, rdata['header'] + 8, new_vsize)
    for _, off, _ in sites:
        struct.pack_into('<I', data, off + 1, slot_va)
    notes.append(f'Qt organization: {len(sites)} uses changed to {NEW_VENDOR.decode()} (string at {slot_va:#x})')
    return len(sites)


def patch_studio_appdata(data, notes):
    pe = PE(bytes(data[:4096]))
    rdata = pe.section('.rdata')
    slot = rdata['raw'] + rdata['rsize'] - APPDATA_SLOT_FROM_END
    slot_va = pe.offset_to_va(slot)
    qt_slot = rdata['raw'] + rdata['rsize'] - QT_ORG_SLOT_FROM_END
    off = pe.va_to_offset(STUDIO_APPDATA_PUSH)
    if off is None or data[off] != 0x68:
        raise ValueError(f'no push at {STUDIO_APPDATA_PUSH:#x}: not the expected Studio build')
    target = struct.unpack_from('<I', data, off + 1)[0]
    if target == slot_va:
        if bytes(data[slot:slot + len(APPDATA_NEW)]) != APPDATA_NEW:
            raise ValueError('Studio folder already repointed, but the new string is missing')
        notes.append(f'Studio folder: already AppData\\Local\\{NEW_VENDOR.decode()}')
        return 0
    old_off = pe.va_to_offset(target)
    if old_off is None or bytes(data[old_off:old_off + len(APPDATA_OLD)]) != APPDATA_OLD:
        raise ValueError('the Studio folder push does not point at "/AppData/Local/Roblox": not the expected Studio build')
    # The space must be unused: past the section's data, or (once the Qt
    # organization patch stretched the section over its string) still zero.
    end_of_data = rdata['raw'] + rdata['vsize']
    stretched = end_of_data == qt_slot + len(QT_ORG_NEW)
    if (end_of_data > slot and not stretched) or any(data[slot:qt_slot]):
        raise ValueError('no free space for the Studio folder string')
    data[slot:slot + len(APPDATA_NEW)] = APPDATA_NEW
    new_vsize = max(rdata['vsize'], slot + len(APPDATA_NEW) - rdata['raw'])
    struct.pack_into('<I', data, rdata['header'] + 8, new_vsize)
    struct.pack_into('<I', data, off + 1, slot_va)
    notes.append(f'Studio folder: AppData\\Local\\Roblox changed to AppData\\Local\\{NEW_VENDOR.decode()} (string at {slot_va:#x})')
    return 1


def process(path, check_only, backup_dir):
    with open(path, 'rb') as f:
        original = f.read()
    data = bytearray(original)
    kind = kind_of(path, original)
    notes = []
    changed = patch_registry_paths(data, kind, notes)
    if kind == 'studio':
        changed += patch_studio_qt_org(data, notes)
        changed += patch_studio_appdata(data, notes)
    assert len(data) == len(original)
    if changed and not check_only:
        if backup_dir:
            os.makedirs(backup_dir, exist_ok=True)
            target = os.path.join(backup_dir, os.path.basename(path) + '.orig')
            if not os.path.exists(target):
                shutil.copy2(path, target)
                notes.append(f'backup: {target}')
        with open(path, 'wb') as f:
            f.write(data)
    state = 'would patch' if (changed and check_only) else ('patched' if changed else 'up to date')
    print(f'{path} ({kind}): {state}')
    for note in notes:
        print(f'  {note}')
    return changed


def main(argv):
    check_only = '--check' in argv
    backup_dir = None
    paths = []
    i = 0
    while i < len(argv):
        if argv[i] == '--check':
            pass
        elif argv[i] == '--backup':
            i += 1
            backup_dir = argv[i]
        else:
            paths.append(argv[i])
        i += 1
    if not paths:
        paths = [os.path.join(ROOT, 'Client', 'RobloxPlayerBeta.exe'), os.path.join(ROOT, 'Studio', 'RobloxStudioBeta.exe')]
    failed = False
    for path in paths:
        if not os.path.isfile(path):
            print(f'{path}: not found, skipped')
            continue
        try:
            process(path, check_only, backup_dir)
        except ValueError as error:
            print(f'{path}: {error}; left unchanged')
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main(sys.argv[1:])
