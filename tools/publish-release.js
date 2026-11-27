'use strict';

// Publishes the small Setup.exe as a GitHub release that installed launchers
// update to on their own.
//
//   cd Launcher && npm run dist && npm run dist:win7 && cd ..
//   node tools/publish-release.js                  notes from Launcher/changelog.json
//   node tools/publish-release.js --notes notes.md
//
// Uploads RobloxClient-Setup-<version>.exe, its .blockmap and latest.yml
// (what electron-updater reads), and the same three for the Windows 7, 8 and
// 8.1 build (RobloxClient-Setup-Win7-<version>.exe, win7.yml) to a new
// release v<version>, using the
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

// The two installers each release has: Windows 10 and 11 (latest.yml), and
// Windows 7, 8 and 8.1 (Electron 22, win7.yml). Installed launchers update
// from their own .yml in the newest release, so both must be in every one.
const BUILDS = [
  { setup: (version) => `RobloxClient-Setup-${version}.exe`, yml: 'latest.yml', command: 'npm run dist' },
  { setup: (version) => `RobloxClient-Setup-Win7-${version}.exe`, yml: 'win7.yml', command: 'npm run dist:win7' },
];

// The built installer files for the version in package.json -> { version, tag, files }, or throws why not.
function checkBuild(version = launcherVersion()) {
  const files = [];
  for (const build of BUILDS) {
    const setup = path.join(DIST, build.setup(version));
    const yml = path.join(DIST, build.yml);
    for (const file of [setup, `${setup}.blockmap`, yml]) {
      if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(ROOT, file)}: run "${build.command}" in Launcher first.`);
    }
    const text = fs.readFileSync(yml, 'utf8');
    if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(text)) {
      throw new Error(`${build.yml} is not for version ${version}: run "${build.command}" again.`);
    }
    if (/RobloxClient-Setup-Full/i.test(text)) {
      throw new Error(`${build.yml} points at the full installer, which must never be published.`);
    }
    if (!new RegExp(`^path: ${build.setup(version).replace(/\./g, '\\.')}\\s*$`, 'm').test(text)) {
      throw new Error(`${build.yml} does not point at ${build.setup(version)}: run "${build.command}" again.`);
    }
    files.push(setup, `${setup}.blockmap`, yml);
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
  // --latest: launchers (electron-updater) and the website follow GitHub's
  // "Latest" release. Left to GitHub, 1.21.0 and 1.21.1 never became Latest,
  // so players stayed on 1.20.0 until 1.22.0.
  const result = spawnSync('gh', ['release', 'create', build.tag, ...build.files, '--title', `RobloxClient Launcher ${build.version}`, ...notesArgs, '--target', 'main', '--latest'],
    { cwd: ROOT, stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { ROOT, LAUNCHER, DIST, CHANGELOG, launcherVersion, checkBuild, changelogNotes, releaseState };

if (require.main === module) main();
