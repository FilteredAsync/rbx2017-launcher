"""Packs the game client (or Roblox Studio) for launchers to download.

    python tools/build-client-files.py            the game client
    python tools/build-client-files.py studio     Roblox Studio
    python tools/build-client-files.py --edited-corescripts
        the game client with this PC's edited CoreScripts (see ORIGINALS)
    --out <folder>   write somewhere else than downloads/ (for tests)

Writes, in downloads/ (client-files for this folder's Client/, as Client/...;
studio-files for Studio/ with "studio"):
  <name>.tar.zst   every file, zstd-compressed (launchers 1.7.2 and newer)
  <name>-from-<old version>.tar.zst   only the files that changed since one
                   of the last few versions (history/<name>/ keeps their file
                   lists), so updates download a few MB instead of everything
  <name>.zip       every file, for launchers before 1.7.2
  <name>.json      the version (from the files' contents, so building again
                   without changes is no update), sizes and SHA-256s
The web server hands these out at /download/<name>; the launcher from the
small Setup.exe downloads the game files on first run, and Studio when a
player opens it. Put the downloads folder on the server (a private update of
downloads) and run this again whenever Client/ or Studio/ changes: launchers
offer the new version. Needs Node 22.15 or newer on PATH (tools/zstd.js).
"""

import datetime
import fnmatch
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'downloads')
# Versions whose players get a "what changed" package instead of everything.
KEEP_VERSIONS = 5
# A "what changed" package bigger than this share of the full one is not worth it.
DELTA_MAX_SHARE = 0.6

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


# CoreScripts edited on this PC for in-game friend status (not yet verified
# in game): until they are, players get the originals kept in
# Client/corescripts-original. --edited-corescripts packs the edited ones.
ORIGINALS = {
    'Client/content/scripts/CoreScripts/CoreScripts/BlockPlayerPrompt.lua': 'BlockPlayerPrompt.lua',
    'Client/content/scripts/CoreScripts/CoreScripts/FriendPlayerPrompt.lua': 'FriendPlayerPrompt.lua',
    'Client/content/scripts/CoreScripts/CoreScripts/Topbar.lua': 'Topbar.lua',
    'Client/content/scripts/CoreScripts/Modules/PlayerDropDown.lua': 'PlayerDropDown.lua',
    'Client/content/scripts/CoreScripts/Modules/PlayerlistModule.lua': 'PlayerlistModule.lua',
    'Client/content/scripts/CoreScripts/Modules/Settings/Pages/Players.lua': 'Players.lua',
}


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def content_version(contents):
    """12 hex digits from the files' names and contents."""
    digest = hashlib.sha256()
    for rel in sorted(contents):
        digest.update(f'{rel}\0{contents[rel]}\n'.encode('utf-8'))
    return digest.hexdigest()[:12]


def write_tar_zst(path, members, delta_info=None):
    """A zstd-compressed tar of members [(rel, source path)], through tools/zstd.js.
    delta_info goes first as .delta.json."""
    node = shutil.which('node')
    if not node:
        sys.exit('node not found on PATH: it compresses the packages (tools/zstd.js).')
    temporary = path + '.new'
    process = subprocess.Popen([node, os.path.join(ROOT, 'tools', 'zstd.js'), temporary, '19'], stdin=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdin, mode='w|', format=tarfile.PAX_FORMAT) as archive:
            if delta_info is not None:
                data = json.dumps(delta_info, indent=1).encode('utf-8')
                info = tarfile.TarInfo('.delta.json')
                info.size = len(data)
                info.mtime = int(datetime.datetime.now().timestamp())
                archive.addfile(info, io.BytesIO(data))
            for rel, source in members:
                archive.add(source, arcname=rel, recursive=False)
    finally:
        process.stdin.close()
    if process.wait() != 0:
        sys.exit(f'compressing {os.path.basename(path)} failed')
    os.replace(temporary, path)
    return {'file': os.path.basename(path), 'size': os.path.getsize(path), 'sha256': sha256_file(path)}


def seed_history(out_dir, name, history_dir):
    """Before the first build with history, the file list of the package the
    server hands out now (its zip), so its players get a small update too."""
    old_json = os.path.join(out_dir, f'{name}.json')
    old_zip = os.path.join(out_dir, f'{name}.zip')
    if os.listdir(history_dir) or not (os.path.isfile(old_json) and os.path.isfile(old_zip)):
        return
    with open(old_json, encoding='utf-8') as handle:
        old = json.load(handle)
    if not old.get('version') or old.get('contents'):
        return
    contents = {}
    with zipfile.ZipFile(old_zip) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            digest = hashlib.sha256()
            with archive.open(info) as member:
                for block in iter(lambda: member.read(1 << 20), b''):
                    digest.update(block)
            contents[info.filename] = digest.hexdigest()
    with open(os.path.join(history_dir, f'{old["version"]}.json'), 'w', encoding='utf-8') as handle:
        json.dump({'version': old['version'], 'createdAt': old.get('createdAt'), 'contents': contents}, handle)
    print(f'history: recorded the current {name} {old["version"]} ({len(contents)} files)')


def main():
    global OUT_DIR
    if '--out' in sys.argv:
        OUT_DIR = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])
    skip = {sys.argv.index('--out') + 1} if '--out' in sys.argv else set()
    args = [arg for i, arg in enumerate(sys.argv[1:], 1) if not arg.startswith('--') and i not in skip]
    edited = '--edited-corescripts' in sys.argv
    kind_name = args[0].lower() if args else 'client'
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
    name = kind['name']
    # Where each packed file comes from (the original CoreScripts unless
    # --edited-corescripts) and its SHA-256.
    sources = {}
    originals = 0
    for rel in files:
        source = os.path.join(ROOT, *rel.split('/'))
        original = os.path.join(ROOT, 'Client', 'corescripts-original', ORIGINALS[rel]) if rel in ORIGINALS else None
        if original and not edited and os.path.isfile(original):
            source = original
            originals += 1
        sources[rel] = source
    if originals:
        print(f'note: packed the {originals} original CoreScripts from Client/corescripts-original (--edited-corescripts packs the edited ones)')
    contents = {rel: sha256_file(source) for rel, source in sources.items()}
    version = content_version(contents)

    history_dir = os.path.join(OUT_DIR, 'history', name)
    os.makedirs(history_dir, exist_ok=True)
    seed_history(OUT_DIR, name, history_dir)
    # The same files as a version already handed out keep its name, so
    # launchers see no update (and download nothing).
    for entry in sorted(os.listdir(history_dir)):
        if entry.endswith('.json'):
            with open(os.path.join(history_dir, entry), encoding='utf-8') as handle:
                recorded = json.load(handle)
            if recorded.get('contents') == contents:
                version = recorded['version']
                break
    old_manifest = None
    if os.path.isfile(os.path.join(OUT_DIR, f'{name}.json')):
        with open(os.path.join(OUT_DIR, f'{name}.json'), encoding='utf-8') as handle:
            old_manifest = json.load(handle)

    # For launchers before 1.7.2. Kept as it is when the version did not change
    # (a new zip would differ in its timestamps and look like an update to them).
    zip_path = os.path.join(OUT_DIR, f'{name}.zip')
    if (old_manifest and old_manifest.get('version') == version and os.path.isfile(zip_path)
            and sha256_file(zip_path) == old_manifest.get('sha256')):
        zip_sha256 = old_manifest['sha256']
        print(f'{name}.zip: unchanged (version {version})')
    else:
        with zipfile.ZipFile(zip_path + '.new', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for rel in files:
                archive.write(sources[rel], rel)
        os.replace(zip_path + '.new', zip_path)
        zip_sha256 = sha256_file(zip_path)

    package = write_tar_zst(os.path.join(OUT_DIR, f'{name}.tar.zst'), [(rel, sources[rel]) for rel in files])
    print(f'{package["file"]}: {len(files)} files, {package["size"] / 1e6:.1f} MB (zip {os.path.getsize(zip_path) / 1e6:.1f} MB)')

    # This version joins the history; the oldest beyond KEEP_VERSIONS leave it.
    with open(os.path.join(history_dir, f'{version}.json'), 'w', encoding='utf-8') as handle:
        json.dump({'version': version, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), 'contents': contents}, handle)
    recorded = sorted((os.path.getmtime(os.path.join(history_dir, entry)), entry[:-5])
                      for entry in os.listdir(history_dir) if entry.endswith('.json'))
    for _, old_version in recorded[:-(KEEP_VERSIONS + 1)]:
        os.remove(os.path.join(history_dir, f'{old_version}.json'))
    kept = [old_version for _, old_version in recorded[-(KEEP_VERSIONS + 1):] if old_version != version]

    # "What changed" packages from each kept version.
    deltas = {}
    for old_version in kept:
        with open(os.path.join(history_dir, f'{old_version}.json'), encoding='utf-8') as handle:
            old_contents = json.load(handle)['contents']
        changed = [rel for rel in files if old_contents.get(rel) != contents[rel]]
        removed = sorted(rel for rel in old_contents if rel not in contents)
        delta_path = os.path.join(OUT_DIR, f'{name}-from-{old_version}.tar.zst')
        info = {'from': old_version, 'to': version, 'removed': removed, 'contents': contents}
        delta = write_tar_zst(delta_path, [(rel, sources[rel]) for rel in changed], info)
        if delta['size'] > package['size'] * DELTA_MAX_SHARE:
            os.remove(delta_path)
            print(f'  from {old_version}: {len(changed)} changed, not worth a separate package')
            continue
        delta['changed'] = len(changed)
        delta['removed'] = len(removed)
        deltas[old_version] = delta
        print(f'  from {old_version}: {len(changed)} changed, {len(removed)} removed, {delta["size"] / 1e6:.1f} MB')
    for entry in os.listdir(OUT_DIR):
        match = entry.startswith(f'{name}-from-') and entry.endswith('.tar.zst') and entry[len(name) + 6:-8]
        if match and match not in deltas:
            os.remove(os.path.join(OUT_DIR, entry))

    manifest = {
        'version': version,
        # The zip, for launchers before 1.7.2.
        'size': os.path.getsize(zip_path),
        'sha256': zip_sha256,
        'files': len(files),
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'package': package,
        'deltas': deltas,
    }
    with open(os.path.join(OUT_DIR, f'{name}.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
    print(f'{name}: version {version}, {len(files)} files, {len(deltas)} update package(s)')


if __name__ == '__main__':
    main()
