'use strict';

// Installs staged server updates (lib/updates.js). dedicated.js copies this
// file to updates/, writes updates/apply.json, saves the players, stops the
// games and the web server, starts this and exits. This then:
//   1. waits for the old server (and its startServer window) to be gone,
//   2. backs up every file it replaces or deletes (updates/backup/<time>/)
//      and copies the new ones in, checking each against the package's SHA-256,
//   3. records the versions in server-version.json,
//   4. starts the server again through Explorer (as a double-click does),
//   5. waits for the web server and the always-on server to report in; if
//      they do not within 3 minutes, stops it, puts the old files back and
//      starts that instead.
// Progress goes to updates/update.log, the outcome to updates/last-result.json.
// Uses only Node's own modules: the server's code changes underneath it.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = job.root;
const updatesDir = path.join(root, 'updates');
const versionFile = path.join(root, 'server-version.json');
const resultFile = path.join(updatesDir, 'last-result.json');
const pidFile = path.join(root, 'Webserver', 'node', 'dedicated.pid');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function log(line) {
  try { fs.appendFileSync(path.join(updatesDir, 'update.log'), `${new Date().toISOString()}  ${line}\r\n`); } catch (error) { /* nowhere to log */ }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitGone(pid, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (!alive(pid)) return true;
    await sleep(500);
  }
  return !alive(pid);
}

function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

function get(urlPath) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: 80, path: urlPath, timeout: 4000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

// The web server answers and an always-on server started after `since`
// reports itself running.
async function serverUp(seconds, since) {
  for (let i = 0; i < seconds / 3; i++) {
    const answer = await get('/api/places');
    if (answer && answer.status === 200) {
      try {
        const runner = JSON.parse(answer.body).runner;
        if (runner.running && Date.parse(runner.updatedAt) > since) return true;
      } catch (error) { /* an older page; keep waiting */ }
    }
    await sleep(3000);
  }
  return false;
}

function startServer() {
  const explorer = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
  spawn(explorer, [path.join(root, 'startServer.bat')], { detached: true, stdio: 'ignore' }).unref();
}

// The server this started, when it has to be rolled back.
async function stopStartedServer() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch (error) { /* not running */ }
  if (pid && alive(pid)) killTree(pid);
  // Its window (title set by startServer.bat), which may wait at "Press any key".
  spawnSync('taskkill', ['/FI', 'WINDOWTITLE eq Roblox always-on server*', '/T', '/F'], { windowsHide: true });
  await sleep(3000);
}

function writeResult(result) {
  try {
    fs.writeFileSync(resultFile, `${JSON.stringify(Object.assign({ at: new Date().toISOString() }, result), null, 2)}\n`);
  } catch (error) { log(`could not write last-result.json: ${error.message}`); }
}

function restore(changed) {
  for (const item of changed.slice().reverse()) {
    try {
      if (item.backup) {
        fs.mkdirSync(path.dirname(item.target), { recursive: true });
        fs.copyFileSync(item.backup, item.target);
      }
      else fs.rmSync(item.target, { force: true });
    } catch (error) { log(`could not put back ${item.target}: ${error.message}`); }
  }
}

function markFailed(error) {
  for (const dir of job.staged) {
    try { fs.writeFileSync(path.join(dir, 'failed.json'), `${JSON.stringify({ error, at: new Date().toISOString() }, null, 2)}\n`); } catch (e) { /* gone */ }
  }
}

function pruneBackups(keep) {
  const dir = path.join(updatesDir, 'backup');
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch (error) { return; }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

async function main() {
  const headers = job.staged.map((dir) => JSON.parse(fs.readFileSync(path.join(dir, 'update.json'), 'utf8')));
  const names = headers.map((header) => `${header.kind} ${header.label || header.build}`).join(' and ');
  log(`installing ${names} (${job.reason})`);

  if (!(await waitGone(job.runnerPid, 180))) {
    log('the old server did not stop within 3 minutes; ending it');
    killTree(job.runnerPid);
  }
  if (job.windowPid && !(await waitGone(job.windowPid, 10))) killTree(job.windowPid);
  await sleep(1000);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const backupDir = path.join(updatesDir, 'backup', stamp);
  const changed = [];
  const versionsBefore = fs.existsSync(versionFile) ? fs.readFileSync(versionFile) : null;
  try {
    const versions = versionsBefore ? JSON.parse(versionsBefore.toString('utf8')) : {};
    headers.forEach((header, index) => {
      for (const file of header.files) {
        const data = fs.readFileSync(path.join(job.staged[index], 'files', ...file.path.split('/')));
        if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`the staged copy of ${file.path} is damaged`);
        const target = path.join(root, ...file.path.split('/'));
        let backup = null;
        if (fs.existsSync(target)) {
          backup = path.join(backupDir, ...file.path.split('/'));
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.copyFileSync(target, backup);
        }
        changed.push({ target, backup });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      }
      // Files the update removes (e.g. a script that was renamed): backed up first.
      for (const name of header.delete || []) {
        const target = path.join(root, ...name.split('/'));
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
        const backup = path.join(backupDir, ...name.split('/'));
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup);
        changed.push({ target, backup });
        fs.rmSync(target, { force: true });
      }
      versions[header.kind] = Number(header.build);
      versions[`${header.kind}Label`] = header.label || String(header.build);
    });
    versions.updatedAt = new Date().toISOString();
    fs.writeFileSync(versionFile, `${JSON.stringify(versions, null, 2)}\n`);
  } catch (error) {
    log(`could not copy the new files (${error.message}); putting the old ones back`);
    restore(changed);
    if (versionsBefore) fs.writeFileSync(versionFile, versionsBefore);
    markFailed(error.message);
    const restartedAt = Date.now();
    startServer();
    writeResult({ ok: false, updates: names, error: `could not copy the files: ${error.message}`, restored: await serverUp(180, restartedAt) });
    return;
  }
  log(`copied ${changed.length} files (old ones in updates\\backup\\${stamp}); starting the server`);

  const startedAt = Date.now();
  startServer();
  if (await serverUp(180, startedAt)) {
    log(`the updated server is running: ${names} installed`);
    for (const dir of job.staged) fs.rmSync(dir, { recursive: true, force: true });
    pruneBackups(5);
    writeResult({ ok: true, updates: names, files: changed.length });
    return;
  }

  log('the updated server did not come up within 3 minutes; putting the old files back');
  await stopStartedServer();
  restore(changed);
  if (versionsBefore) fs.writeFileSync(versionFile, versionsBefore);
  else fs.rmSync(versionFile, { force: true });
  markFailed('the updated server did not start; the previous version was put back');
  const restartedAt = Date.now();
  startServer();
  const back = await serverUp(180, restartedAt);
  log(back ? 'the previous version is running again' : 'the previous version did not come up either; look at the server window');
  writeResult({ ok: false, updates: names, error: 'the updated server did not start, so the previous version was put back', restored: back });
}

main().catch((error) => {
  log(`update failed: ${error.stack || error.message}`);
  writeResult({ ok: false, error: error.message });
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch (e) { /* not running */ }
  if (!alive(pid)) startServer();
});
