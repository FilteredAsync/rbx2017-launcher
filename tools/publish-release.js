'use strict';

// Publishes the small Setup.exe as a GitHub release that installed launchers
// update to on their own.
//
//   cd Launcher && npm run dist && cd ..
//   node tools/publish-release.js                  notes from Launcher/changelog.json
//   node tools/publish-release.js --notes notes.md
//
// Uploads RobloxClient-Setup-<version>.exe, its .blockmap and latest.yml
// (what electron-updater reads) to a new release v<version>, using the
// GitHub CLI (gh). Raise "version" in Launcher/package.json for each release
// and add its entry at the top of Launcher/changelog.json.
// Never upload the full installer: it contains Roblox's client.
// tools/schedule-release.js uses the same checks for releases that go out later.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const LAUNCHER = path.join(ROOT, 'Launcher');
const DIST = path.join(LAUNCHER, 'dist-installer');
const CHANGELOG = path.join(LAUNCHER, 'changelog.json');

const launcherVersion = () => JSON.parse(fs.readFileSync(path.join(LAUNCHER, 'package.json'), 'utf8')).version;

// The built installer files for the version in package.json -> { version, tag, files }, or throws why not.
function checkBuild(version = launcherVersion()) {
  const setup = path.join(DIST, `RobloxClient-Setup-${version}.exe`);
  const files = [setup, `${setup}.blockmap`, path.join(DIST, 'latest.yml')];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(ROOT, file)}: run "npm run dist" in Launcher first.`);
  }
  const latest = fs.readFileSync(files[2], 'utf8');
  if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(latest)) {
    throw new Error(`latest.yml is not for version ${version}: build again.`);
  }
  if (/RobloxClient-Setup-Full/i.test(latest)) {
    throw new Error('latest.yml points at the full installer, which must never be published.');
  }
  return { version, tag: `v${version}`, files };
}

// Release notes ("## title" and "- item" lines) from the version's entry in Launcher/changelog.json.
function changelogNotes(version) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(CHANGELOG, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read Launcher/changelog.json (${error.code === 'ENOENT' ? 'missing' : error.message}).`);
  }
  const entry = Array.isArray(list) ? list.find((item) => item && item.version === version) : null;
  const items = entry && Array.isArray(entry.items) ? entry.items.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!entry || !String(entry.title || '').trim() || !items.length) {
    throw new Error(`Launcher/changelog.json has no entry for ${version}. Add one at the top: { "version": "${version}", "date": "YYYY-MM-DD", "title": "...", "items": ["..."] }`);
  }
  return `## ${String(entry.title).trim()}\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
}

// 'published', 'draft' (scheduled with tools/schedule-release.js) or null when there is no such release.
function releaseState(tag) {
  const result = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).isDraft ? 'draft' : 'published';
  } catch {
    return 'published';
  }
}

function main() {
  const notesAt = process.argv.indexOf('--notes');
  const notesFile = notesAt > 0 ? process.argv[notesAt + 1] : null;
  if (notesAt > 0 && (!notesFile || !fs.existsSync(notesFile))) {
    console.error('Usage: node tools/publish-release.js [--notes <release-notes.md>]   (without --notes: Launcher/changelog.json)');
    process.exit(2);
  }
  let build;
  let notesArgs;
  try {
    build = checkBuild();
    notesArgs = notesFile ? ['--notes-file', notesFile] : ['--notes', changelogNotes(build.version)];
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const state = releaseState(build.tag);
  if (state === 'draft') {
    console.error(`Release ${build.tag} is already scheduled (a draft). It goes out by itself; to drop it, delete it on GitHub or run: gh release delete ${build.tag} --yes`);
    process.exit(1);
  }
  if (state) {
    console.error(`Release ${build.tag} already exists. Raise the version in Launcher/package.json.`);
    process.exit(1);
  }
  const result = spawnSync('gh', ['release', 'create', build.tag, ...build.files, '--title', `RobloxClient Launcher ${build.version}`, ...notesArgs, '--target', 'main'],
    { cwd: ROOT, stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { ROOT, LAUNCHER, DIST, CHANGELOG, launcherVersion, checkBuild, changelogNotes, releaseState };

if (require.main === module) main();
