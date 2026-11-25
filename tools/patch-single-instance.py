"""Takes out the game client's one-at-a-time rule, which closed the player's
real Roblox: every Roblox client from 2014 to today opens the named event
"ROBLOX_singletonEvent" when it starts, signals it (any other Roblox client
waiting on it closes itself), then waits on it and closes its own window
when the next one starts. Since our clients share that name with today's
Roblox, starting a game from the launcher closed the player's Roblox.

    python tools/patch-single-instance.py <RobloxPlayerBeta.exe>...
    python tools/patch-single-instance.py --check <exe>...   (report only)

Two changes, same file size:
  - after CreateEventA("ROBLOX_singletonEvent") the client checks the handle
    and, without one, skips the whole rule ("if (!event) return"). That
    branch is made the one always taken (jne -> nop), so the client neither
    signals other clients nor waits to be closed: several of ours can run
    side by side too.
  - "ROBLOX_singletonEvent"/"ROBLOX_singletonMutex" become
    "RB2017_singletonEvent"/"RB2017_singletonMutex", so the one event the
    client still opens is not today's Roblox's.
Found by the code's shape (push of the name, call, test reg,reg, jne), not by
fixed addresses, so it works for every year's client (checked on 0.177,
0.205, 0.254, 0.300 and 0.338). Running it again does nothing.
"""

import re
import struct
import sys

import pefile

OLD_EVENT, NEW_EVENT = b'ROBLOX_singletonEvent\0', b'RB2017_singletonEvent\0'
OLD_MUTEX, NEW_MUTEX = b'ROBLOX_singletonMutex\0', b'RB2017_singletonMutex\0'
# test r32,r32 (85 C0..FF with matching registers) then jne rel8 / jne rel32.
TEST_JNE = re.compile(rb'\x85([\xC0\xC9\xD2\xDB\xF6\xFF])(\x75.|\x0F\x85....)', re.S)


def patch(exe, check_only=False):
    data = bytearray(open(exe, 'rb').read())
    pe = pefile.PE(exe, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase

    def va_of(offset):
        rva = pe.get_rva_from_offset(offset)
        return None if rva is None else base + rva

    name = data.find(b'\0' + OLD_EVENT)
    renamed = name < 0 and data.find(b'\0' + NEW_EVENT) >= 0
    if renamed:
        name = data.find(b'\0' + NEW_EVENT)
    if name < 0:
        pe.close()
        return 'no singleton event name (not a Roblox game client?)'
    name_va = va_of(name + 1)
    # push imm32 of the name; the branch follows within a few instructions.
    push = data.find(b'\x68' + struct.pack('<I', name_va))
    pe.close()
    if push < 0:
        return 'no code uses the event name: not patched'
    window = bytes(data[push:push + 48])
    if b'\xFF\x15' not in window:
        return f'unexpected code after the event name at file offset {push:#x}: not patched'
    match = TEST_JNE.search(window, window.find(b'\xFF\x15'))
    nopped = re.search(rb'\x85[\xC0\xC9\xD2\xDB\xF6\xFF](\x90\x90(?:\x90\x90\x90\x90)?)', window[window.find(b'\xFF\x15'):])
    notes = []
    if match:
        at = push + match.start(2)
        size = len(match.group(2))
        if not check_only:
            data[at:at + size] = b'\x90' * size
        notes.append(f'one-at-a-time rule {"would be " if check_only else ""}off (jne at {va_of(at) or 0:#x})')
    elif nopped:
        notes.append('one-at-a-time rule already off')
    else:
        return f'no handle check after CreateEventA at file offset {push:#x}: not patched'
    for old, new in ((OLD_EVENT, NEW_EVENT), (OLD_MUTEX, NEW_MUTEX)):
        count = data.count(b'\0' + old)
        if count and not check_only:
            data[:] = bytes(data).replace(b'\0' + old, b'\0' + new)
        if count:
            notes.append(f'{old[:-1].decode()} {"would be " if check_only else ""}renamed')
    if not check_only:
        with open(exe, 'wb') as handle:
            handle.write(data)
    return '; '.join(notes)


def main():
    args = sys.argv[1:]
    check_only = '--check' in args
    exes = [a for a in args if a != '--check']
    if not exes:
        sys.exit(__doc__)
    for exe in exes:
        print(f'{exe}: {patch(exe, check_only)}')


if __name__ == '__main__':
    main()
