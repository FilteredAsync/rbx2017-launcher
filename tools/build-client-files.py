"""Packs the game client for the downloader installer.

    python tools/build-client-files.py

Writes downloads/client-files.zip (this folder's Client/, as Client/...)
and downloads/client-files.json (version, size, SHA-256). The web server
hands these out at /download/client-files.zip and .json; the launcher from
the small Setup.exe downloads them on first run. Put the downloads folder on
the server (tools/build-server-package.py includes it) and run this again
whenever Client/ changes: launchers offer the new version as an update.
"""

import datetime
import fnmatch
import hashlib
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.path.join(ROOT, 'Client')
OUT_DIR = os.path.join(ROOT, 'downloads')
# Same exclusions as the full installer (Launcher/package.json).
EXCLUDE = ['Client/RobloxPlayerBeta_aecandidate.exe', 'Client/RobloxPlayerBeta_tracecandidate.exe',
           'Client/rbxsig_private.pem', 'Client/corescripts-original', 'Client/corescripts-original/*']


def main():
    if not os.path.isfile(os.path.join(CLIENT, 'RobloxPlayerBeta.exe')):
        sys.exit('Client/RobloxPlayerBeta.exe not found')
    files = []
    for directory, subdirs, names in os.walk(CLIENT):
        rel_dir = os.path.relpath(directory, ROOT).replace(os.sep, '/')
        subdirs[:] = sorted(s for s in subdirs if not any(fnmatch.fnmatch(f'{rel_dir}/{s}', p) for p in EXCLUDE))
        for name in sorted(names):
            rel = f'{rel_dir}/{name}'
            if not any(fnmatch.fnmatch(rel, p) for p in EXCLUDE):
                files.append(rel)
    os.makedirs(OUT_DIR, exist_ok=True)
    zip_path = os.path.join(OUT_DIR, 'client-files.zip')
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
    with open(os.path.join(OUT_DIR, 'client-files.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
    print(f'{zip_path}: {len(files)} files, {round(manifest["size"] / 1e6)} MB, version {manifest["version"]}')


if __name__ == '__main__':
    main()
