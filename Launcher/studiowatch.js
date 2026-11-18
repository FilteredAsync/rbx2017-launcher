'use strict';

// Keeps the local proxy up while Roblox Studio from this install is open.
// Studio reaches the server only through that proxy (http and https on
// localhost), which closes when its last holder lets go. A game holds it while
// it runs; Studio needs a hold of its own, or it can publish only while a game
// is open and otherwise says just "Error while publishing:".
//
// Studio may be open before this launcher is: the launcher restarted for an
// update, was closed and opened again, or Studio was started from its own
// folder. So this looks for it every 20 s (main.js) instead of holding only
// when the launcher starts it, and lets go only once Studio is surely closed.
//
//   const watch = require('./studiowatch')({ studioDir, acquire, log })
//   await watch.state()     'running' | 'stopped' | 'unknown' (Windows could not say)
//   await watch.hold(url)   hold the proxy now (the launcher is starting Studio)
//   await watch.check(url)  one look: hold while Studio runs, let go after it closed
//   watch.held()            true while holding (or about to)
//
// acquire(url) -> Promise<{ release() }> (lib/proxy.js acquireProxy).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Two looks in a row without Studio before letting go: a place opening in a
// new Studio window can leave a moment with none.
const STOPPED_CHECKS = 2;

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout || ''));
    });
  });
}

// The paths of the running RobloxStudioBeta.exe processes ('' for one whose
// path Windows will not give, such as an elevated one), or null when that
// could not be checked. tasklist is quick; PowerShell runs only when it finds one.
async function studioProcessPaths() {
  const list = await run('tasklist', ['/FI', 'IMAGENAME eq RobloxStudioBeta.exe', '/FO', 'CSV', '/NH']);
  if (list === null) return null;
  if (!/robloxstudiobeta\.exe/i.test(list)) return [];
  const paths = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $_.Path } else { '?' } }"]);
  if (paths === null) return null;
  return paths.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => (line === '?' ? '' : line));
}

module.exports = function studioWatch({ studioDir, acquire, log = () => {}, listPaths = studioProcessPaths }) {
  let holding = null; // Promise<{ release }> while acquiring or held
  let stoppedChecks = 0;
  let checking = false;
  let lastError = null;

  // The Studio folder as Windows may report it (also through a junction).
  function folders() {
    const list = [path.resolve(studioDir)];
    try { list.push(fs.realpathSync.native(studioDir)); } catch (error) { /* not there yet */ }
    return list.map((dir) => dir.replace(/[\\/]+$/, '').toLowerCase());
  }

  async function state() {
    const paths = await listPaths();
    if (paths === null) return 'unknown';
    const ours = folders();
    let unreadable = false;
    for (const file of paths) {
      if (!file) unreadable = true;
      else if (ours.includes(path.dirname(file).toLowerCase())) return 'running';
    }
    return unreadable ? 'unknown' : 'stopped';
  }

  function hold(url) {
    stoppedChecks = 0;
    if (!holding) {
      const attempt = Promise.resolve().then(() => acquire(url));
      holding = attempt;
      attempt.then(() => { lastError = null; }, () => { if (holding === attempt) holding = null; });
    }
    return holding.then(() => {});
  }

  async function release(line) {
    const current = holding;
    holding = null;
    stoppedChecks = 0;
    if (!current) return;
    let entry;
    try { entry = await current; } catch (error) { return; }
    entry.release();
    log(line);
  }

  async function check(url) {
    if (checking) return;
    checking = true;
    try {
      const now = await state();
      if (now === 'running') {
        stoppedChecks = 0;
        if (!holding && url) {
          try {
            await hold(url);
            log(`Studio is open: forwarding its requests to ${url}.`);
          } catch (error) {
            if (error.message !== lastError) log(`Studio is open, but cannot reach the server: ${error.message}`);
            lastError = error.message;
          }
        }
      } else if (now === 'stopped' && holding) {
        stoppedChecks += 1;
        if (stoppedChecks >= STOPPED_CHECKS) await release('Studio closed; stopped forwarding its requests.');
      }
    } finally {
      checking = false;
    }
  }

  return { state, hold, check, held: () => holding !== null };
};
