"""Packs the game client (or Roblox Studio) for launchers to download.

    python tools/build-client-files.py            the game client
    python tools/build-client-files.py studio     Roblox Studio

Writes downloads/client-files.zip (this folder's Client/, as Client/...)
and downloads/client-files.json (version, size, SHA-256); with "studio",
downloads/studio-files.zip and .json from Studio/. The web server hands these
out at /download/<name>; the launcher from the small Setup.exe downloads the
game files on first run, and Studio when a player opens it. Put the downloads
folder on the server (tools/build-server-package.py includes it) and run this
again whenever Client/ or Studio/ changes: launchers offer the new version.
"""

import datetime
import fnmatch
import hashlib
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'downloads')

KINDS = {
    'client': {
        'folder': 'Client',
        'exe': 'RobloxPlayerBeta.exe',
        'name': 'client-files',
        # Same exclusions as the full installer (Launcher/package.json).
        'exclude': ['Client/RobloxPlayerBeta_aecandidate.exe', 'Client/RobloxPlayerBeta_tracecandidate.exe',
                    'Client/rbxsig_private.pem', 'Client/corescripts-original', 'Client/corescripts-original/*'],
    },
    'studio': {
        'folder': 'Studio',
        'exe': 'RobloxStudioBeta.exe',
        'name': 'studio-files',
        # Keys, the patcher and the unpatched or backup copies of the exe stay here.
        'exclude': ['Studio/rbxsig_private.pem', 'Studio/rbxsig_public.pub', 'Studio/rbxsig_blob.txt',
                    'Studio/roblox-auto-patcher.exe', 'Studio/RobloxStudioBeta_unPatched.exe',
                    'Studio/*.bak', 'Studio/*.before-key-patch', 'Studio/ClientSettings/*.original'],
    },
}


def check_studio_key(exe):
    """Studio must trust the server's script key (tools/patch-studio-key.py)."""
    with open(os.path.join(ROOT, 'Server', 'rbxsig_blob.txt'), 'rb') as handle:
        blob = handle.read().strip()
    with open(exe, 'rb') as handle:
        if blob not in handle.read():
            sys.exit('Studio does not trust the server key yet: run python tools/patch-studio-key.py first.')


def main():
    kind_name = sys.argv[1].lower() if len(sys.argv) > 1 else 'client'
    if kind_name not in KINDS:
        sys.exit(f'usage: python tools/build-client-files.py [{"|".join(KINDS)}]')
    kind = KINDS[kind_name]
    source = os.path.join(ROOT, kind['folder'])
    exe = os.path.join(source, kind['exe'])
    if not os.path.isfile(exe):
        sys.exit(f'{kind["folder"]}/{kind["exe"]} not found')
    if kind_name == 'studio':
        check_studio_key(exe)
    exclude = kind['exclude']
    files = []
    for directory, subdirs, names in os.walk(source):
        rel_dir = os.path.relpath(directory, ROOT).replace(os.sep, '/')
        subdirs[:] = sorted(s for s in subdirs if not any(fnmatch.fnmatch(f'{rel_dir}/{s}', p) for p in exclude))
        for name in sorted(names):
            rel = f'{rel_dir}/{name}'
            if not any(fnmatch.fnmatch(rel, p) for p in exclude):
                files.append(rel)
    os.makedirs(OUT_DIR, exist_ok=True)
    zip_path = os.path.join(OUT_DIR, f'{kind["name"]}.zip')
    with zipfile.ZipFile(zip_path + '.new', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for rel in files:
            archive.write(os.path.join(ROOT, *rel.split('/')), rel)
    os.replace(zip_path + '.new', zip_path)

    digest = hashlib.sha256()
    with open(zip_path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    sha256 = digest.hexdigest()
    manifest = {
        'version': sha256[:12],
        'size': os.path.getsize(zip_path),
        'sha256': sha256,
        'files': len(files),
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
    }
    with open(os.path.join(OUT_DIR, f'{kind["name"]}.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
    print(f'{zip_path}: {len(files)} files, {round(manifest["size"] / 1e6)} MB, version {manifest["version"]}')


if __name__ == '__main__':
    main()
