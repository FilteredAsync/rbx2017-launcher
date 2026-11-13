'use strict';

// Publishes the small Setup.exe as a GitHub release that installed launchers
// update to on their own.
//
//   cd Launcher && npm run dist && cd ..
//   node tools/publish-release.js --notes release-notes.md
//
// Uploads RobloxClient-Setup-<version>.exe, its .blockmap and latest.yml
// (what electron-updater reads) to a new release v<version>, using the
// GitHub CLI (gh). Raise "version" in Launcher/package.json for each release.
// Never upload the full installer: it contains Roblox's client.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const DIST = path.join(ROOT, 'Launcher', 'dist-installer');
const version = require(path.join(ROOT, 'Launcher', 'package.json')).version;
const tag = `v${version}`;

const notesIndex = process.argv.indexOf('--notes');
const notes = notesIndex > 0 ? process.argv[notesIndex + 1] : null;
if (!notes || !fs.existsSync(notes)) {
  console.error('Usage: node tools/publish-release.js --notes <release-notes.md>');
  process.exit(2);
}

const setup = path.join(DIST, `RobloxClient-Setup-${version}.exe`);
const files = [setup, `${setup}.blockmap`, path.join(DIST, 'latest.yml')];
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(ROOT, file)}: run "npm run dist" in Launcher first.`);
    process.exit(1);
  }
}
const latest = fs.readFileSync(files[2], 'utf8');
if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(latest)) {
  console.error(`latest.yml is not for version ${version}: build again.`);
  process.exit(1);
}
if (/RobloxClient-Setup-Full/i.test(latest)) {
  console.error('latest.yml points at the full installer, which must never be published.');
  process.exit(1);
}

const exists = spawnSync('gh', ['release', 'view', tag], { cwd: ROOT, encoding: 'utf8' });
if (exists.status === 0) {
  console.error(`Release ${tag} already exists. Raise the version in Launcher/package.json.`);
  process.exit(1);
}
const result = spawnSync('gh', ['release', 'create', tag, ...files, '--title', `RobloxClient Launcher ${version}`, '--notes-file', notes, '--target', 'main'],
  { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
