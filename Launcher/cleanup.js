'use strict';

// Files the launcher and the 2017 programs leave behind, for Settings >
// Storage and the tidy-up at each start. No Electron here, so it can be
// tested with plain Node.
//
//   logs      the 2017 client's, Studio's and RCC's logs and crash reports in
//             %LOCALAPPDATA%\Roblox\logs (and its archive folder). That folder
//             is shared with the real Roblox, so only the 2017 names are
//             touched: log_<hex>_<n>.txt and "log_<hex> 0, 299, 0, <build>.*"
//             (0, 300 for RCC; 0, 254 for the 2016 ones). Today's Roblox names its logs
//             <version>_<time>_Player_<id>_last.log.
//   updates   the launcher's update downloads (electron-updater's folder,
//             %LOCALAPPDATA%\<name>-updater): pending\ holds the last update's
//             installer, installer.exe the current one (for smaller updates).
//   leftovers half-finished downloads in <install>\downloads: game file or
//             Studio folders from an interrupted swap, .part files and the
//             Tailscale installer. Never the .zip/.json a host serves.
//   studio    Roblox Studio as downloaded from the server (player installs
//             only: on a host's PC, Studio\ is the copy it hands out).
//
//   const cleaner = require('./cleanup')({ root, localAppData, updaterDir, appVersion, studioDownloaded, busy })
//   await cleaner.scan()          -> { logs, updates, leftovers, studio } each { bytes, files } or null
//   await cleaner.clean(kind)     -> { bytes, files, skipped }   (removes everything of that kind)
//   await cleaner.atStart()       -> { bytes, files }   logs older than a week, installed
//                                    updates and leftovers

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const LOG_TEXT = /^log_[0-9A-F]{4,8}_\d+\.txt$/i;
const LOG_CRASH = /^log_[0-9A-F]{4,8} 0, (?:254|299|300), 0, \d+(?:\.[A-Za-z]+)+$/i;
const LEFTOVER_DIR = /^(?:client|studio)-files(?:-\d{4})?-(?:new|old-\d+)$/;
// Unfinished downloads (gamefiles.js): kept a day at start so they can continue.
const LEFTOVER_FILE = /^(?:client|studio)-files.*\.part(?:\.json)?$/;
const PART_KEEP_MS = 24 * 3600 * 1000;

// "1.7.10" > "1.7.9"
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((part) => Number(part) || 0);
  const pb = String(b).split(/[.-]/).map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function statOrNull(file) {
  try { return await fsp.lstat(file); } catch (error) { return null; }
}

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (error) { return []; }
}

// Bytes and files under a folder (or one file); links are not followed.
async function sizeOf(target) {
  const stat = await statOrNull(target);
  if (!stat) return { bytes: 0, files: 0 };
  if (!stat.isDirectory()) return { bytes: stat.isFile() ? stat.size : 0, files: stat.isFile() ? 1 : 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of await listDir(target)) {
    if (entry.isSymbolicLink()) continue;
    const inner = await sizeOf(path.join(target, entry.name));
    bytes += inner.bytes;
    files += inner.files;
  }
  return { bytes, files };
}

// Removes one file or folder. A file in use (say, the log of a running game)
// stays; the result says what went.
async function remove(target) {
  const size = await sizeOf(target);
  try {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    return { bytes: size.bytes, files: size.files, skipped: 0 };
  } catch (error) {
    const left = await sizeOf(target);
    return { bytes: size.bytes - left.bytes, files: size.files - left.files, skipped: Math.max(1, left.files) };
  }
}

function add(total, part) {
  total.bytes += part.bytes;
  total.files += part.files;
  total.skipped = (total.skipped || 0) + (part.skipped || 0);
  return total;
}

module.exports = function cleanup({ root, localAppData, privateLocalAppData = null, updaterDir = null, appVersion = '0.0.0', studioDownloaded = () => false, busy = () => false }) {
  // Since 1.9.0 the 2017 programs log into their own profile (lib/joining.js
  // isolatedEnv); older logs are still in the shared folder.
  const logDirs = [privateLocalAppData, localAppData].filter(Boolean)
    .flatMap((base) => [path.join(base, 'Roblox', 'logs'), path.join(base, 'Roblox', 'logs', 'archive')]);
  const downloads = path.join(root, 'downloads');

  // The 2017 programs' logs and crash reports: [{ file, size, mtimeMs }]
  async function logFiles() {
    const found = [];
    for (const dir of logDirs) {
      for (const entry of await listDir(dir)) {
        if (!entry.isFile() || !(LOG_TEXT.test(entry.name) || LOG_CRASH.test(entry.name))) continue;
        const stat = await statOrNull(path.join(dir, entry.name));
        if (stat) found.push({ file: path.join(dir, entry.name), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    return found;
  }

  // keepRecentParts: leave unfinished downloads younger than a day (they
  // continue on the next try).
  async function leftoverPaths(keepRecentParts = false, now = Date.now()) {
    const found = [];
    for (const entry of await listDir(downloads)) {
      const full = path.join(downloads, entry.name);
      if (entry.isDirectory() && LEFTOVER_DIR.test(entry.name)) {
        found.push(full);
      } else if (entry.isFile() && LEFTOVER_FILE.test(entry.name)) {
        const stat = await statOrNull(full);
        if (!(keepRecentParts && stat && now - stat.mtimeMs < PART_KEEP_MS)) found.push(full);
      }
    }
    if (await statOrNull(path.join(downloads, 'tailscale'))) found.push(path.join(downloads, 'tailscale'));
    return found;
  }

  // The update in pending\ (its installer name carries the version), or null.
  function pendingVersion() {
    if (!updaterDir) return null;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(updaterDir, 'pending', 'update-info.json'), 'utf8'));
      const match = /(\d+\.\d+\.\d+)/.exec(String(info.fileName || ''));
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  async function scan() {
    const logs = await logFiles();
    const leftovers = { bytes: 0, files: 0 };
    for (const target of await leftoverPaths()) add(leftovers, await sizeOf(target));
    delete leftovers.skipped;
    return {
      logs: { bytes: logs.reduce((sum, item) => sum + item.size, 0), files: logs.length },
      updates: updaterDir ? await sizeOf(updaterDir) : null,
      leftovers,
      studio: studioDownloaded() ? await sizeOf(path.join(root, 'Studio')) : null,
    };
  }

  // Studio goes in one move first, so a Studio that is open (or a file it
  // holds) leaves it whole instead of half deleted.
  async function removeStudio() {
    if (!studioDownloaded()) throw new Error('Studio was not downloaded by this launcher.');
    const studio = path.join(root, 'Studio');
    const size = await sizeOf(studio);
    const aside = path.join(downloads, `studio-files-old-${Date.now()}`);
    await fsp.mkdir(downloads, { recursive: true });
    try {
      await fsp.rename(studio, aside);
    } catch (error) {
      if (error.code === 'ENOENT') return { bytes: 0, files: 0, skipped: 0 };
      throw new Error('Studio is in use. Close it and try again.');
    }
    try { fs.unlinkSync(path.join(root, 'config', 'studio-files.json')); } catch (error) { /* none */ }
    const removed = await remove(aside);
    // Anything still held is picked up as a leftover later.
    return { bytes: size.bytes, files: size.files, skipped: removed.skipped };
  }

  async function clean(kind) {
    const total = { bytes: 0, files: 0, skipped: 0 };
    if (kind === 'logs') {
      for (const item of await logFiles()) add(total, await remove(item.file));
    } else if (kind === 'updates') {
      if (!updaterDir) return total;
      for (const entry of await listDir(updaterDir)) add(total, await remove(path.join(updaterDir, entry.name)));
    } else if (kind === 'leftovers') {
      if (busy()) throw new Error('A download is running. Try again when it is done.');
      for (const target of await leftoverPaths()) add(total, await remove(target));
    } else if (kind === 'studio') {
      if (busy()) throw new Error('A download is running. Try again when it is done.');
      return removeStudio();
    } else {
      throw new Error(`Unknown storage kind: ${kind}`);
    }
    return total;
  }

  // At each start: logs and crash reports older than a week, the installer of
  // an update that is now installed, and leftovers.
  async function atStart(now = Date.now()) {
    const total = { bytes: 0, files: 0, skipped: 0 };
    for (const item of await logFiles()) {
      if (now - item.mtimeMs > WEEK_MS) add(total, await remove(item.file));
    }
    const pending = pendingVersion();
    if (pending && compareVersions(pending, appVersion) <= 0) add(total, await remove(path.join(updaterDir, 'pending')));
    if (!busy()) for (const target of await leftoverPaths(true, now)) add(total, await remove(target));
    return total;
  }

  return { scan, clean, atStart, pendingVersion };
};

module.exports.compareVersions = compareVersions;
module.exports.LOG_TEXT = LOG_TEXT;
module.exports.LOG_CRASH = LOG_CRASH;
