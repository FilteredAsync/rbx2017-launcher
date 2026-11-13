'use strict';

// Builds a signed server update (Webserver/node/lib/updates.js) for always-on
// servers set up with RobloxServer-Setup.exe or RobloxServer.zip.
//
//   node tools/build-server-update.js public [--worktree] [--notes "..."] [--exe]
//       This repository's server code as committed (HEAD), or as it is on disk
//       with --worktree. Makes share/RobloxServer-update-<build>.rbxupd, which
//       may be published (tools/publish-server-update.js): servers look for it
//       on GitHub and install it by themselves.
//   node tools/build-server-update.js private <file or folder>... [--notes "..."] [--exe]
//       Files that must not be published (Server/*.lua, downloads/..., the
//       game-server content). Makes share/RobloxServer-private-update-<build>.rbxupd:
//       upload it on the server's /manage page (Server > Install an update file).
//       Never publish it.
//   --exe  also makes share/RobloxServer-Update-<build>.exe, which installs the
//       same files on the server PC without /manage: it stops the server
//       (players saved first), copies the files and starts it again. For servers
//       from before the updater, or when the updater itself is stuck.
//
// Signs with config/update-signing-key.pem. Never share or commit it, and keep
// a backup: servers accept only updates signed with it.

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const updates = require(path.join(ROOT, 'Webserver', 'node', 'lib', 'updates.js'));
const KEY_FILE = path.join(ROOT, 'config', 'update-signing-key.pem');
const SHARE = path.join(ROOT, 'share');
// The scripts in the server folder's root (the same list as build-server-package.py).
const ROOT_SCRIPTS = ['patch-rcc-place-auth.ps1', 'patch-rcc-http-urls.ps1', 'add-hosts-entries.ps1', 'addHostsEntries.bat',
  'tailscale-firewall.ps1', 'tailscaleFirewall.bat', 'startServer.bat', 'restartServer.bat', 'restart-server.ps1',
  'autostart.ps1', 'autostartServer.bat', 'convertPlace.bat', 'Launcher.bat'];
// Repository file -> where it goes in the server folder.
const RENAMED = {
  'packaging/server/README-SERVER.txt': 'README-SERVER.txt',
  'packaging/server/setup-server.ps1': 'setup-server.ps1',
};
const STORED = new Set(['.zip', '.7z', '.rar', '.png', '.jpg', '.jpeg', '.mp3', '.ogg', '.gz', '.wav']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, maxBuffer: 512 * 1048576, windowsHide: true }, options));
}

// The repository's server files -> [{ path (in the server folder), source (in the repository) }]
// From the last commit, or (fromDisk) as on disk, new files that are not
// committed yet included.
function publicFiles(fromDisk) {
  const where = ['--', 'Webserver/node', 'config/README.txt', ...Object.keys(RENAMED), ...ROOT_SCRIPTS];
  const tracked = (fromDisk
    ? git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...where])
    : git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', ...where]))
    .toString('utf8').split('\0').filter(Boolean)
    .filter((source) => !fromDisk || fs.existsSync(path.join(ROOT, source)));
  const list = [];
  for (const source of tracked) {
    const target = RENAMED[source] || source;
    if (source.startsWith('packaging/') && !RENAMED[source]) continue;
    if (!updates.cleanPath(target)) continue; // data, logs: never part of an update
    list.push({ path: target, source });
  }
  return list;
}

function walk(relative, out) {
  const full = path.join(ROOT, relative);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full)) {
      if (!name.startsWith('.')) walk(`${relative}/${name}`, out);
    }
  } else {
    out.push(relative);
  }
}

function privateFiles(paths) {
  if (paths.length === 0) fail('Name the files or folders to include, e.g.: node tools/build-server-update.js private Server/appearance-hook.lua downloads');
  const found = [];
  for (const given of paths) {
    const relative = path.relative(ROOT, path.resolve(ROOT, given)).replace(/\\/g, '/');
    if (relative.startsWith('..') || !fs.existsSync(path.join(ROOT, relative))) fail(`not found in the project folder: ${given}`);
    walk(relative, found);
  }
  const list = [];
  for (const relative of [...new Set(found)]) {
    if (!updates.cleanPath(relative)) fail(`an update may not contain ${relative} (server data, settings, keys and saves are never replaced)`);
    list.push({ path: relative, source: relative });
  }
  return list;
}

function signingKey() {
  if (!fs.existsSync(KEY_FILE)) fail(`No signing key (${path.relative(ROOT, KEY_FILE)}). It was made once on the developer's PC; restore it from your backup.`);
  const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const matches = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim() === updates.PUBLIC_KEY.trim();
  if (!matches) fail('config/update-signing-key.pem does not match PUBLIC_KEY in Webserver/node/lib/updates.js; servers would refuse this update.');
  return key;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    build: Number(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`),
    local: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

// --- the update installer (.exe) for servers without the updater -------------------------

function makensisPath() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  for (const outer of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    if (!/^nsis-3/.test(outer)) continue;
    for (const inner of fs.readdirSync(path.join(cache, outer))) {
      const exe = path.join(cache, outer, inner, 'Bin', 'makensis.exe');
      if (/^nsis-3/.test(inner) && fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

const nsis = (text) => String(text).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');

const SET_VERSION_PS1 = `param([string] $Root, [string] $Kind, [string] $Build, [string] $Label)
# Records an installed update in server-version.json (what /manage shows).
$file = Join-Path $Root "server-version.json"
$data = [ordered]@{}
if (Test-Path -LiteralPath $file) {
    try { (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $data[$PSItem.Name] = $PSItem.Value } } catch {}
}
$data[$Kind] = [int64] $Build
$data["$($Kind)Label"] = $Label
$data["updatedAt"] = (Get-Date).ToUniversalTime().ToString("o")
[IO.File]::WriteAllText($file, ($data | ConvertTo-Json) + [Environment]::NewLine)
"Recorded the $Kind update $Label in server-version.json."
`;

function buildExe(header, files, out) {
  const makensis = makensisPath();
  if (!makensis) fail('makensis not found: build the launcher installer once (cd Launcher && npm run dist) so electron-builder downloads NSIS.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'server-update-'));
  try {
    const helper = path.join(work, 'set-server-version.ps1');
    fs.writeFileSync(helper, SET_VERSION_PS1.replace(/\n/g, '\r\n'));
    const byFolder = new Map();
    for (const file of files) {
      const staged = path.join(work, 'files', ...file.path.split('/'));
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      fs.writeFileSync(staged, file.data);
      const folder = path.posix.dirname(file.path);
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(staged);
    }
    const fileLines = [];
    for (const folder of [...byFolder.keys()].sort()) {
      fileLines.push(`  SetOutPath "$INSTDIR${folder === '.' ? '' : `\\${nsis(folder.replace(/\//g, '\\'))}`}"`);
      for (const staged of byFolder.get(folder)) {
        const stored = STORED.has(path.extname(staged).toLowerCase());
        if (stored) fileLines.push('  SetCompress off');
        fileLines.push(`  File "${nsis(staged)}"`);
        if (stored) fileLines.push('  SetCompress auto');
      }
    }
    const script = `; Made by tools/build-server-update.js. Do not edit; build again.
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user
Name "Roblox Server update"
Caption "Roblox Server update ${nsis(header.label)}"
OutFile "${nsis(out)}"
InstallDir "C:\\RobloxServer"
InstallDirRegKey HKLM "Software\\RobloxServer" "InstallDir"
BrandingText "RobloxClient always-on server, ${header.kind} update ${nsis(header.label)}"
ShowInstDetails show

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define MUI_ICON "${nsis(path.join(ROOT, 'Launcher', 'build', 'icon.ico'))}"
!define MUI_DIRECTORYPAGE_TEXT_TOP "This updates the Roblox server in this folder (${files.length} files, ${header.kind} update ${nsis(header.label)}). The server is stopped first (players are saved), then updated and started again. Games, accounts, saves and settings are not touched."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "The server was updated and started again. Its window shows when it is running."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function DirectoryLeave
  \${IfNot} \${FileExists} "$INSTDIR\\startServer.bat"
    MessageBox MB_OK|MB_ICONEXCLAMATION "There is no Roblox server in $INSTDIR (no startServer.bat). Choose the server's folder."
    Abort
  \${EndIf}
FunctionEnd

Section
  \${If} \${RunningX64}
    StrCpy $0 "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"
  \${Else}
    StrCpy $0 "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"
  \${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${nsis(path.join(ROOT, 'restart-server.ps1'))}"
  File "${nsis(helper)}"
  DetailPrint "Stopping the server (players are saved first)..."
  nsExec::ExecToLog '"$0" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\\restart-server.ps1" -StopOnly -Root "$INSTDIR"'
  Pop $1
  DetailPrint "Copying the new files..."
${fileLines.join('\n')}
  SetOutPath "$PLUGINSDIR"
  nsExec::ExecToLog '"$0" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\\set-server-version.ps1" -Root "$INSTDIR" -Kind ${header.kind} -Build ${header.build} -Label "${nsis(header.label)}"'
  Pop $1
  DetailPrint "Starting the server..."
  Exec '"$WINDIR\\explorer.exe" "$INSTDIR\\startServer.bat"'
SectionEnd
`;
    const nsi = path.join(work, 'update.nsi');
    fs.writeFileSync(nsi, `\ufeff${script.replace(/\r?\n/g, '\r\n')}`);
    const result = spawnSync(makensis, ['-V2', '-NOCD', nsi], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) fail(`makensis failed (${result.status})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// --- main ------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const kind = args[0];
  if (kind !== 'public' && kind !== 'private') {
    fail('Usage: node tools/build-server-update.js public [--worktree] [--notes "..."] [--exe]\n'
      + '       node tools/build-server-update.js private <file or folder>... [--notes "..."] [--exe]');
  }
  const flags = new Set(args.filter((arg) => arg === '--worktree' || arg === '--exe'));
  const notesAt = args.indexOf('--notes');
  const notes = notesAt > 0 ? String(args[notesAt + 1] || '') : '';
  const positional = args.slice(1).filter((arg, index, all) => !arg.startsWith('--') && all[index - 1] !== '--notes');
  const key = signingKey();
  const { build, local } = stamp();
  const commit = git(['rev-parse', '--short', 'HEAD']).toString().trim();

  let list;
  let fromDisk = true;
  if (kind === 'public') {
    if (positional.length > 0) fail('A public update is always the whole server code; name files only for a private one.');
    fromDisk = flags.has('--worktree');
    list = publicFiles(fromDisk);
  } else {
    list = privateFiles(positional);
  }
  const files = list.map((item) => ({
    path: item.path,
    data: fromDisk ? fs.readFileSync(path.join(ROOT, item.source)) : git(['cat-file', 'blob', `HEAD:${item.source}`]),
  }));
  if (kind === 'public' && !fromDisk) {
    const changed = list.filter((item, index) => !fs.readFileSync(path.join(ROOT, item.source)).equals(files[index].data));
    if (changed.length > 0) console.log(`note: built from the last commit (${commit}); ${changed.length} of these files have uncommitted changes that are not included (${changed.slice(0, 5).map((item) => item.source).join(', ')}${changed.length > 5 ? ', ...' : ''})`);
  }

  // A public update replaces the whole server code: every local require() in
  // it must point at a file that is in it (or a server would not start).
  if (kind === 'public') {
    const inPackage = new Set(files.map((file) => file.path));
    const missing = [];
    for (const file of files) {
      if (!file.path.endsWith('.js')) continue;
      for (const match of file.data.toString('utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        let target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]));
        if (!/\.(js|json)$/.test(target)) target += '.js';
        if (!inPackage.has(target)) missing.push(`${file.path} needs ${target}`);
      }
    }
    if (missing.length > 0) fail(`Not built: the update would be missing files:\n  ${[...new Set(missing)].join('\n  ')}`);
  }

  const label = kind === 'public' ? `${local} (${commit}${fromDisk ? ', not committed' : ''})` : local;
  const header = { kind, build, label, notes, commit: kind === 'public' ? commit : null, fromDisk };
  const bytes = updates.pack(header, files, key);
  updates.unpack(bytes); // check it the way a server will
  fs.mkdirSync(SHARE, { recursive: true });
  const name = kind === 'public' ? `RobloxServer-update-${build}.rbxupd` : `RobloxServer-private-update-${build}.rbxupd`;
  const out = path.join(SHARE, name);
  fs.writeFileSync(out, bytes);
  const total = files.reduce((sum, file) => sum + file.data.length, 0);
  console.log(`${path.relative(ROOT, out)}: ${kind} update ${label}, ${files.length} files, ${(total / 1048576).toFixed(1)} MB -> ${(bytes.length / 1048576).toFixed(1)} MB`);

  if (flags.has('--exe')) {
    const exe = path.join(SHARE, `RobloxServer-Update-${build}.exe`);
    buildExe(Object.assign({}, header, { files: files.length }), files, exe);
    console.log(`${path.relative(ROOT, exe)}: ${(fs.statSync(exe).size / 1048576).toFixed(1)} MB (runs on the server PC, no administrator needed)`);
  }
  if (kind === 'private' || fromDisk) console.log('Not for publishing: hand it over privately, or upload it on the server\'s /manage page.');
}

main();
