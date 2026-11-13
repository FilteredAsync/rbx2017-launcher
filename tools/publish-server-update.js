'use strict';

// Publishes a public server update as a GitHub pre-release "server-<build>".
// Always-on servers look for the newest RobloxServer-update-<build>.rbxupd in
// the releases and install it by themselves (lib/updates.js); launchers ignore
// pre-releases, so their own updates are not affected.
//
//   node tools/build-server-update.js public
//   node tools/publish-server-update.js share/RobloxServer-update-<build>.rbxupd [--notes "what changed"]
//
// Refuses private updates and ones built from uncommitted files (--worktree):
// what servers install must be the code that is on GitHub. Uses the GitHub CLI (gh).

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const updates = require(path.join(ROOT, 'Webserver', 'node', 'lib', 'updates.js'));

const file = process.argv[2];
const notesAt = process.argv.indexOf('--notes');
if (!file || !fs.existsSync(file) || !updates.ASSET.test(path.basename(file))) {
  console.error('Usage: node tools/publish-server-update.js share/RobloxServer-update-<build>.rbxupd [--notes "what changed"]');
  process.exit(2);
}

let header;
try {
  ({ header } = updates.unpack(fs.readFileSync(file)));
} catch (error) {
  console.error(`Not publishing: ${error.message}`);
  process.exit(1);
}
if (header.kind !== 'public') {
  console.error('Not publishing: this is a private update. Upload it on the server\'s /manage page instead.');
  process.exit(1);
}
if (header.fromDisk) {
  console.error('Not publishing: this update was built from uncommitted files (--worktree). Commit, push, and build it again without --worktree.');
  process.exit(1);
}
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', header.commit]);
if (!git(['branch', '-r', '--contains', commit]).split('\n').some((line) => line.trim() === 'origin/main')) {
  console.error(`Not publishing: commit ${header.commit} is not on GitHub (origin/main) yet. Push it first.`);
  process.exit(1);
}

const tag = `server-${header.build}`;
const notes = notesAt > 0 ? String(process.argv[notesAt + 1] || '') : (header.notes || '');
const body = `Server update ${header.label} for always-on servers (installs by itself once nobody is playing; nothing to do for players).\n\n${notes}`.trim();
const exists = spawnSync('gh', ['release', 'view', tag], { cwd: ROOT, encoding: 'utf8' });
if (exists.status === 0) {
  console.error(`Release ${tag} already exists.`);
  process.exit(1);
}
const result = spawnSync('gh', ['release', 'create', tag, file, '--prerelease', '--latest=false', '--title', `Server update ${header.label}`, '--notes', body, '--target', commit],
  { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
