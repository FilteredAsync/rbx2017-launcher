'use strict';

// Schedules a launcher release (and, with --server, a server update) to go
// out at a time you pick, and tells every launcher about it until then.
//
//   cd Launcher && npm run dist && cd ..
//   node tools/schedule-release.js --at "2026-11-21 18:00" [--server share/RobloxServer-update-<build>.rbxupd] [--dry-run]
//
// --at is Eastern time (ET), "YYYY-MM-DD HH:MM" (24-hour, or "6:00 PM"), at
// least 30 minutes ahead. Makes a draft release v<version> with the same
// files and notes as tools/publish-release.js (notes from Launcher/changelog.json),
// plus a hidden "publish-at" line; with --server also a draft pre-release
// server-<build>. The "Scheduled releases" workflow on GitHub publishes them
// when the time comes (it runs every 5 minutes, often a few minutes late).
// Adds an "Update coming" notice to announcements.json on GitHub's main,
// as a commit of that file alone on top of what is on GitHub.
// --dry-run checks everything and prints what it would do, changing nothing.
//
// To call a scheduled release off: gh release delete v<version> --yes, and
// take its notice out of announcements.json.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const release = require('./publish-release.js');

const { ROOT, LAUNCHER, DIST } = release;
const TIME_ZONE = 'America/New_York';
const MIN_LEAD_MS = 30 * 60 * 1000;
const ANNOUNCEMENTS = 'announcements.json';
const BRANCH = 'main';

// --- Eastern time -----------------------------------------------------------------------

const formatter = (options) => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, ...options });
const PARTS = formatter({ hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const WEEKDAY = formatter({ weekday: 'long' });
const WEEKDAY_SHORT = formatter({ weekday: 'short' });
const MONTH_DAY = formatter({ month: 'long', day: 'numeric' });
const CLOCK = formatter({ hour: 'numeric', minute: '2-digit', hour12: true });
// Newer ICU puts a narrow no-break space before AM/PM.
const plainSpaces = (text) => text.replace(/[  ]/g, ' ');

// UTC milliseconds -> the wall clock in Eastern time.
function easternParts(ms) {
  const parts = {};
  for (const { type, value } of PARTS.formatToParts(new Date(ms))) parts[type] = Number(value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

// How far Eastern time is ahead of UTC at that moment (negative: -4 h or -5 h).
function easternOffset(ms) {
  const wall = easternParts(ms);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
}

// An Eastern wall time -> UTC milliseconds, or null when that time does not
// exist (the hour skipped when clocks go forward). In the repeated hour when
// clocks go back, the first one (EDT).
function easternToUtc({ year, month, day, hour, minute }) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall - easternOffset(wall);
  utc = wall - easternOffset(utc);
  const back = easternParts(utc);
  if (back.year !== year || back.month !== month || back.day !== day || back.hour !== hour || back.minute !== minute) return null;
  return utc;
}

// "2026-11-21 18:00", "2026-11-21T18:00", "2026-11-21 6:00 PM" -> wall-time parts, or null.
function parseAt(text) {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(String(text || ''));
  if (!match) return null;
  const [year, month, day, rawHour, minute] = match.slice(1, 6).map(Number);
  let hour = rawHour;
  if (match[6]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (/^p/i.test(match[6]) ? 12 : 0);
  }
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

const easternDay = (ms) => {
  const wall = easternParts(ms);
  return Date.UTC(wall.year, wall.month - 1, wall.day) / 86400000;
};

// "Saturday at 6:00 PM ET", or with the date when it is a week or more away.
function whenText(ms, now) {
  const clock = plainSpaces(CLOCK.format(ms));
  const weekday = WEEKDAY.format(ms);
  if (easternDay(ms) - easternDay(now) <= 6) return `${weekday} at ${clock} ET`;
  return `${weekday}, ${MONTH_DAY.format(ms)} at ${clock} ET`;
}

// For the commit message: "Sat 2026-11-21 6:00 PM ET".
function stampText(ms) {
  const wall = easternParts(ms);
  const date = `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
  return `${WEEKDAY_SHORT.format(ms)} ${date} ${plainSpaces(CLOCK.format(ms))} ET`;
}

// --- announcement -----------------------------------------------------------------------

function announcementFor(version, publishAt, now) {
  return {
    id: `release-${version}`,
    title: 'Update coming',
    text: `Launcher ${version} comes out ${whenText(publishAt, now)}.`,
    level: 'info',
    postedAt: new Date(now).toISOString(),
    expiresAt: new Date(publishAt).toISOString(),
  };
}

// announcements.json's data with the entry added (replacing one with its id) and expired ones dropped.
function updateAnnouncements(data, entry, now) {
  const list = data && Array.isArray(data.announcements) ? data.announcements : [];
  const kept = list.filter((item) => item && item.id !== entry.id && !(item.expiresAt && Date.parse(item.expiresAt) <= now));
  return { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}), announcements: [entry, ...kept] };
}

const marker = (publishAt) => `<!-- publish-at: ${new Date(publishAt).toISOString()} -->`;

// --- checks -----------------------------------------------------------------------------

// The built app must carry the server address new players connect to.
function checkBakedServer(version) {
  const archive = path.join(DIST, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(archive)) throw new Error(`Missing ${path.relative(ROOT, archive)}: run "npm run dist" in Launcher first.`);
  let asar;
  try {
    asar = require(require.resolve('@electron/asar', { paths: [LAUNCHER] }));
  } catch {
    throw new Error('Could not load @electron/asar from Launcher/node_modules: run "npm install" in Launcher.');
  }
  let address = '';
  try {
    address = asar.extractFile(archive, 'default-server.txt').toString('utf8').trim();
  } catch {
    address = '';
  }
  if (!address) throw new Error('The built app has no server address (default-server.txt is missing or empty in app.asar): put it in Launcher/default-server.txt and build again.');
  let built;
  try {
    built = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version;
  } catch {
    throw new Error('Could not read package.json in the built app: build again.');
  }
  if (built !== version) throw new Error(`The built app (win-unpacked) is version ${built}, not ${version}: build again.`);
}

const git = (args, input) => {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.error || '').trim()}`);
  return result.stdout.trim();
};

// Same checks as tools/publish-server-update.js.
function checkServerUpdate(file) {
  const updates = require(path.join(ROOT, 'Webserver', 'node', 'lib', 'updates.js'));
  if (!fs.existsSync(file) || !updates.ASSET.test(path.basename(file))) {
    throw new Error('--server needs a file like share/RobloxServer-update-<build>.rbxupd.');
  }
  let header;
  try {
    ({ header } = updates.unpack(fs.readFileSync(file)));
  } catch (error) {
    throw new Error(`Server update refused: ${error.message}`);
  }
  if (header.kind !== 'public') throw new Error('Server update refused: this is a private update. Upload it on the server\'s /manage page instead.');
  if (header.fromDisk) throw new Error('Server update refused: it was built from uncommitted files (--worktree). Commit, push, and build it again without --worktree.');
  const commit = git(['rev-parse', header.commit]);
  if (!git(['branch', '-r', '--contains', commit]).split('\n').some((line) => line.trim() === 'origin/main')) {
    throw new Error(`Server update refused: commit ${header.commit} is not on GitHub (origin/main) yet. Push it first.`);
  }
  const body = `Server update ${header.label} for always-on servers (installs by itself once nobody is playing; nothing to do for players).\n\n${header.notes || ''}`.trim();
  return { file, tag: `server-${header.build}`, commit, title: `Server update ${header.label}`, body };
}

// --- GitHub -----------------------------------------------------------------------------

function readAnnouncements(ref) {
  const result = spawnSync('git', ['show', `${ref}:${ANNOUNCEMENTS}`], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return { announcements: [] };
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${ANNOUNCEMENTS} on GitHub is not valid JSON: fix it first.`);
  }
}

// A commit on top of `base` that changes announcements.json alone (whatever is
// staged or changed in this folder stays out of it).
function announcementCommit(base, content, message) {
  const blob = git(['hash-object', '-w', '--stdin'], content);
  const entries = git(['ls-tree', base]).split('\n').filter((line) => line && !line.endsWith(`\t${ANNOUNCEMENTS}`));
  entries.push(`100644 blob ${blob}\t${ANNOUNCEMENTS}`);
  const tree = git(['mktree'], `${entries.join('\n')}\n`);
  return git(['commit-tree', tree, '-p', base, '-m', message]);
}

function pushAnnouncement(entry, now, message) {
  for (let attempt = 1; ; attempt += 1) {
    git(['fetch', '--quiet', 'origin', BRANCH]);
    const base = git(['rev-parse', `origin/${BRANCH}`]);
    const data = updateAnnouncements(readAnnouncements(base), entry, now);
    const commit = announcementCommit(base, `${JSON.stringify(data, null, 2)}\n`, message);
    const pushed = spawnSync('git', ['push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`], { cwd: ROOT, encoding: 'utf8' });
    if (pushed.status === 0) return { base, commit };
    if (attempt >= 3) throw new Error(`git push failed: ${String(pushed.stderr || '').trim()}`);
  }
}

// Brings the pushed commit into this folder when that is a plain fast-forward.
function syncLocal(base, commit) {
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (branch === BRANCH && head === base && spawnSync('git', ['merge', '--ff-only', '--quiet', commit], { cwd: ROOT }).status === 0) return true;
  return false;
}

// Relative to the repository, with / (gh takes it on Windows too; easier to read).
const repoPath = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const quote = (arg) => (/^[\w./:=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const show = (cmd, args) => `${cmd} ${args.map(quote).join(' ')}`;

// --- main -------------------------------------------------------------------------------

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node tools/schedule-release.js --at "YYYY-MM-DD HH:MM" [--server share/RobloxServer-update-<build>.rbxupd] [--dry-run] [--soon]\n       (--at is Eastern time, at least 30 minutes from now; with --soon, 10 minutes)');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { at: null, server: null, dryRun: false, soon: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--at') options.at = argv[++i];
    else if (arg === '--server') options.server = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--soon') options.soon = true;
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.at) usage('Missing --at.');
  if (options.server === undefined) usage('--server needs a file.');
  const wall = parseAt(options.at);
  if (!wall) usage(`Could not read --at "${options.at}".`);
  const publishAt = easternToUtc(wall);
  if (publishAt === null) usage(`${options.at} does not exist in Eastern time (clocks jump forward then): pick another time.`);
  const now = Date.now();

  const problems = [];
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      problems.push(error.message);
      return null;
    }
  };

  // --soon (test drops): 10 minutes' notice is enough.
  const minLead = options.soon ? 10 * 60 * 1000 : MIN_LEAD_MS;
  if (publishAt - now < minLead) {
    const minutes = Math.round(minLead / 60000);
    problems.push(`${stampText(publishAt)} is ${publishAt <= now ? 'in the past' : `less than ${minutes} minutes from now`}: pick a time at least ${minutes} minutes ahead.`);
  }
  const version = release.launcherVersion();
  const tag = `v${version}`;
  const build = attempt(() => release.checkBuild(version));
  const notes = attempt(() => release.changelogNotes(version));
  attempt(() => checkBakedServer(version));
  const server = options.server ? attempt(() => checkServerUpdate(options.server)) : null;
  for (const name of [tag, server && server.tag].filter(Boolean)) {
    const state = release.releaseState(name);
    if (state === 'draft') problems.push(`Release ${name} is already scheduled (a draft). To schedule it again, delete it first: gh release delete ${name} --yes`);
    else if (state) problems.push(`Release ${name} already exists.`);
  }

  // The tag goes on the commit the installer was built from (it must be
  // pushed), not on whatever main holds at drop time.
  let target = 'main';
  try {
    const head = git(['rev-parse', 'HEAD']);
    spawnSync('git', ['fetch', '-q', 'origin', BRANCH], { cwd: ROOT });
    if (spawnSync('git', ['merge-base', '--is-ancestor', head, `origin/${BRANCH}`], { cwd: ROOT }).status === 0) target = head;
    else problems.push(`Push your commits first: the release is tagged on the commit it was built from (${head.slice(0, 7)}).`);
  } catch (error) {
    problems.push(error.message);
  }

  const entry = announcementFor(version, publishAt, now);
  const message = `Announce launcher ${version} for ${stampText(publishAt)}`;
  const hidden = marker(publishAt);
  const files = build ? build.files : [`RobloxClient-Setup-${version}.exe`, `RobloxClient-Setup-${version}.exe.blockmap`, 'latest.yml'].map((name) => path.join(DIST, name));
  const launcherArgs = ['release', 'create', tag, ...files.map(repoPath),
    '--draft', '--title', `RobloxClient Launcher ${version}`, '--notes', `${notes || ''}\n${hidden}\n`, '--target', target];
  const serverArgs = server && ['release', 'create', server.tag, repoPath(path.resolve(server.file)), '--draft', '--prerelease', '--latest=false',
    '--title', server.title, '--notes', `${server.body}\n\n${hidden}\n`, '--target', server.commit];
  const notesShown = (args) => args.map((arg, i) => (args[i - 1] === '--notes' ? '<notes below>' : arg));

  console.log(`Launcher ${version} goes out ${stampText(publishAt)} (${new Date(publishAt).toISOString()}).`);

  if (options.dryRun) {
    console.log('\nDry run: nothing is changed. Would run:');
    console.log(`  ${show('gh', notesShown(launcherArgs))}`);
    if (serverArgs) console.log(`  ${show('gh', notesShown(serverArgs))}`);
    console.log(`  git fetch origin ${BRANCH}`);
    console.log(`  git hash-object -w --stdin / git mktree / git commit-tree -p origin/${BRANCH} -m ${quote(message)}`);
    console.log(`  git push origin <that commit>:refs/heads/${BRANCH}`);
    console.log(`\nLauncher release notes:\n${launcherArgs[launcherArgs.indexOf('--notes') + 1]}`);
    if (serverArgs) console.log(`Server release notes:\n${serverArgs[serverArgs.indexOf('--notes') + 1]}`);
    let current = null;
    try {
      current = readAnnouncements(`origin/${BRANCH}`);
    } catch (error) {
      problems.push(error.message);
    }
    console.log(`${ANNOUNCEMENTS} on GitHub would become (as of the last fetch; expired notices dropped):\n${JSON.stringify(updateAnnouncements(current, entry, now), null, 2)}`);
    if (problems.length) {
      console.log(`\nWould refuse:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      process.exit(1);
    }
    return;
  }

  if (problems.length) {
    console.error(`Not scheduling:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    process.exit(1);
  }

  const created = [];
  const run = (args) => {
    console.log(`> ${show('gh', notesShown(args))}`);
    const result = spawnSync('gh', args, { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`gh release create ${args[2]} failed.`);
      if (created.length) console.error(`Already made: ${created.join(', ')}. Delete with: ${created.map((name) => `gh release delete ${name} --yes`).join(' && ')}`);
      process.exit(1);
    }
    created.push(args[2]);
  };
  run(launcherArgs);
  if (serverArgs) run(serverArgs);

  let pushed;
  try {
    pushed = pushAnnouncement(entry, now, message);
  } catch (error) {
    console.error(`${error.message}\nThe draft release(s) are made, but the announcement is not on GitHub. Fix that and add it by hand, or delete the drafts (${created.map((name) => `gh release delete ${name} --yes`).join(' && ')}) and run this again.`);
    process.exit(1);
  }
  console.log(`Pushed "${message}" (${pushed.commit.slice(0, 7)}).`);
  if (!syncLocal(pushed.base, pushed.commit)) console.log(`Run "git pull" to get ${ANNOUNCEMENTS} here (this folder is not at GitHub's ${BRANCH}).`);
  console.log(`Scheduled ${created.join(' and ')}. Players see "${entry.text}"`);
}

module.exports = {
  TIME_ZONE, parseAt, easternParts, easternToUtc, whenText, stampText, announcementFor, updateAnnouncements, marker,
  checkBakedServer, pushAnnouncement, syncLocal,
};

if (require.main === module) main();
