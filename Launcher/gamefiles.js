'use strict';

// Game files for installs from the small Setup.exe (no game client inside).
// On first run, and when the server has a newer version (checked before each
// game), the launcher downloads them from <server>/download/ and swaps the
// whole Client/ folder for the new one, so files the new version no longer
// has do not stay behind; config/client-files.json records the version. kind
// 'studio' does the same for Roblox Studio (studio-files, Studio/). No
// Electron here, so it can be tested with plain Node.
//
// What it downloads (tools/build-client-files.py makes them), smallest first:
//   <name>-from-<installed version>.tar.zst   only the files that changed:
//       applied to a copy of the installed folder, then every file is checked
//       against the new version's list (any mismatch: the full package instead)
//   <name>.tar.zst   every file, zstd-compressed
//   <name>.zip       servers from before 2026-11-14 have only this
// Downloads continue where they stopped after a dropped connection (a few
// tries), and after a restart within a day (downloads/<file>.part).
//
//   const files = require('./gamefiles')({ root, normalizeUrl, canPlay, onProgress, kind, log });
//   files.installed()            -> { version, ... } or null
//   await files.download(url)    -> { version, via }
//   await files.update(url)      -> { installed, available, size } or null

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const KINDS = {
  client: { file: 'client-files', folder: 'Client', what: 'the game files', missing: 'the client is missing', build: 'tools/build-client-files.py' },
  studio: { file: 'studio-files', folder: 'Studio', what: 'Studio', missing: 'Studio is missing', build: 'tools/build-client-files.py studio' },
};

// zstd is in Node 22.15 and newer (the launcher's Electron has it).
const HAS_ZSTD = typeof zlib.createZstdDecompress === 'function';
// Tries per download when the connection drops (each resumes).
const RETRIES = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Antivirus scanners hold new files for a moment, so a folder rename can
// fail at first.
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await sleep(500);
    }
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

// Every file under dir, as paths relative to base with "/" (Client/a/b.txt).
async function listFiles(base, dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(base, full, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function dropped(error) {
  const reason = error && error.cause && error.cause.code ? error.cause.code : error && error.message ? error.message : String(error);
  return Object.assign(new Error(`The connection dropped during the download (${reason}).`), { retry: true });
}

module.exports = function gameFiles({ root, normalizeUrl, canPlay, onProgress = () => {}, kind = 'client', log = () => {} }) {
  const k = KINDS[kind];
  const stateFile = path.join(root, 'config', `${k.file}.json`);
  const downloads = path.join(root, 'downloads');
  const target = path.join(root, k.folder);
  let busy = false;

  function installed() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {
      return null;
    }
  }

  async function manifestFrom(url, timeoutMs = 8000) {
    let response;
    try {
      response = await fetch(`${url}/download/${k.file}.json`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`Could not reach ${url}. Is Tailscale connected, and is the server running?`);
    }
    if (response.status === 404) throw new Error(`That server has no ${kind === 'studio' ? 'Studio' : 'game files'} to hand out yet (its host runs ${k.build}).`);
    if (!response.ok) throw new Error(`The server answered HTTP ${response.status}.`);
    const manifest = await response.json().catch(() => null);
    if (!manifest || !/^[0-9a-f]{64}$/.test(String(manifest.sha256)) || !Number.isFinite(manifest.size)) {
      throw new Error(`The server sent a broken list for ${k.what}.`);
    }
    return manifest;
  }

  // A package entry from the list: { file, size, sha256 } with one of our names.
  function validEntry(entry) {
    return Boolean(entry && typeof entry.file === 'string' && entry.file.startsWith(`${k.file}`)
      && /^[a-z]+-files(?:-from-[0-9a-f]{12})?\.tar\.zst$/.test(entry.file)
      && /^[0-9a-f]{64}$/.test(String(entry.sha256)) && Number.isFinite(entry.size) && entry.size > 0);
  }

  // What to download for an install at `current` (null: nothing installed).
  function planFor(manifest, current) {
    const zip = { type: 'zip', entry: { file: `${k.file}.zip`, size: manifest.size, sha256: manifest.sha256 } };
    if (!HAS_ZSTD || !validEntry(manifest.package)) return zip;
    const delta = current && manifest.deltas && typeof manifest.deltas === 'object' ? manifest.deltas[current.version] : null;
    if (validEntry(delta) && fs.existsSync(target)) return { type: 'delta', entry: delta };
    return { type: 'package', entry: manifest.package };
  }

  // Downloads <url>/download/<entry.file> to downloads/<entry.file>.part:
  // continues a part an earlier try left (same SHA-256, the server's ETag
  // unchanged), and after a dropped connection. Checks size and SHA-256.
  async function fetchEntry(url, entry) {
    const file = path.join(downloads, `${entry.file}.part`);
    const meta = `${file}.json`;
    let etag = null;
    let have = 0;
    try {
      const info = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (info.sha256 === entry.sha256 && typeof info.etag === 'string') {
        have = fs.statSync(file).size;
        etag = info.etag;
      }
    } catch (error) {
      have = 0;
    }
    if (have >= entry.size) have = 0;
    if (have > 0) log(`Continuing the download of ${entry.file} from ${Math.round(have / 1048576)} MB.`);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const headers = have > 0 && etag ? { Range: `bytes=${have}-`, 'If-Range': etag } : {};
        let response;
        try {
          response = await fetch(`${url}/download/${entry.file}`, { headers });
        } catch (error) {
          throw dropped(error);
        }
        if (response.status === 416) {
          have = 0;
          etag = null;
          throw Object.assign(new Error('The server would not continue the download.'), { retry: true });
        }
        if (!response.ok || !response.body) throw Object.assign(new Error(`The download failed (HTTP ${response.status}).`), { status: response.status });
        if (response.status !== 206) have = 0; // the whole file after all
        etag = response.headers.get('etag');
        fs.writeFileSync(meta, JSON.stringify({ sha256: entry.sha256, etag }));
        const out = fs.openSync(file, have > 0 ? 'a' : 'w');
        let received = have;
        let shown = 0;
        try {
          const reader = response.body.getReader();
          for (;;) {
            let chunk;
            try {
              chunk = await reader.read();
            } catch (error) {
              throw dropped(error);
            }
            if (chunk.done) break;
            fs.writeSync(out, chunk.value);
            received += chunk.value.length;
            if (Date.now() - shown > 200) {
              shown = Date.now();
              onProgress({ phase: 'download', received, total: entry.size });
            }
          }
        } finally {
          fs.closeSync(out);
          have = fs.statSync(file).size;
        }
        if (have < entry.size) throw dropped(new Error('the answer ended early'));
        break;
      } catch (error) {
        if (!error.retry || attempt >= RETRIES) throw error;
        log(`${error.message} Trying again (${attempt + 1} of ${RETRIES})…`);
        onProgress({ phase: 'retry', attempt: attempt + 1, received: have, total: entry.size });
        await sleep(1500 * (attempt + 1));
      }
    }
    onProgress({ phase: 'download', received: entry.size, total: entry.size });
    if (fs.statSync(file).size !== entry.size || await sha256File(file) !== entry.sha256) {
      fs.rmSync(file, { force: true });
      fs.rmSync(meta, { force: true });
      throw new Error('The download was damaged (its size or checksum did not match). Try again.');
    }
    return file;
  }

  function forgetPart(file) {
    for (const name of [file, `${file}.json`]) {
      try { fs.rmSync(name, { force: true }); } catch (error) { /* in use: tidied up later */ }
    }
  }

  function runTar(args, input) {
    return new Promise((resolve, reject) => {
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const child = spawn(tar, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
      let errors = '';
      let failed = null;
      child.stderr.on('data', (chunk) => { errors += chunk; });
      if (input) {
        child.stdin.on('error', (error) => { if (error.code !== 'EPIPE' && error.code !== 'EOF') failed = failed || error; });
        input(child.stdin, (error) => { failed = failed || error; try { child.kill(); } catch (ignored) { /* gone */ } });
      }
      child.on('error', (error) => reject(new Error(`Could not unpack ${k.what}: ${error.message}`)));
      child.on('exit', (code) => {
        if (failed) reject(new Error(`Could not unpack ${k.what}: ${failed.message}`));
        else if (code !== 0) reject(new Error(`Could not unpack ${k.what}: ${errors.trim().slice(0, 200) || `tar exit code ${code}`}`));
        else resolve();
      });
    });
  }

  // A .zip (Windows' tar reads zip) or a .tar.zst (unpacked here, fed to tar).
  function unpack(file, destination) {
    if (!/\.tar\.zst(\.part)?$/.test(file)) return runTar(['-xf', file, '-C', destination]);
    return runTar(['-xf', '-', '-C', destination], (stdin, fail) => {
      const source = fs.createReadStream(file);
      const unzstd = zlib.createZstdDecompress();
      source.on('error', fail);
      unzstd.on('error', fail);
      source.pipe(unzstd).pipe(stdin);
    });
  }

  // Unpacks with fill(stage) into downloads/<file>-new/ and swaps that folder
  // in for the old one (moved to downloads/<file>-old-<time>/, deleted once
  // the new one is in place; one still in use, say by a client started
  // outside the launcher, is deleted on a later update). If the old folder
  // cannot be moved, over(root) lays the new files over it as before.
  async function install(fill, over) {
    const stage = path.join(downloads, `${k.file}-new`);
    const old = path.join(downloads, `${k.file}-old-${Date.now()}`);
    for (const name of fs.existsSync(downloads) ? fs.readdirSync(downloads) : []) {
      if (name.startsWith(`${k.file}-old-`)) fs.rm(path.join(downloads, name), { recursive: true, force: true }, () => {});
    }
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    try {
      await fill(stage);
      const fresh = path.join(stage, k.folder);
      if (!fs.existsSync(fresh)) throw new Error(`The download has no ${k.folder} folder; ask your host to rebuild it (${k.build}).`);
      let movedOld = false;
      if (fs.existsSync(target)) {
        try {
          await renameRetry(target, old);
          movedOld = true;
        } catch (error) {
          await over(root);
          return;
        }
      }
      try {
        await renameRetry(fresh, target);
      } catch (error) {
        if (movedOld) {
          try { fs.renameSync(old, target); } catch (restoreError) { /* left in downloads */ }
        }
        throw new Error(`Could not put ${k.what} in place: ${error.message}`);
      }
      fs.rm(old, { recursive: true, force: true }, () => {});
    } finally {
      fs.rm(stage, { recursive: true, force: true }, () => {});
    }
  }

  // After a "what changed" package was unpacked into base: drops the files the
  // new version no longer has, then checks every file against its list
  // (contents: { "Client/a.txt": sha256 }); files not on it are removed.
  async function applyDeltaInfo(base, expect) {
    const infoFile = path.join(base, '.delta.json');
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    fs.rmSync(infoFile, { force: true });
    if (info.from !== expect.from || info.to !== expect.to || !info.contents || typeof info.contents !== 'object') {
      throw new Error('the update package is for another version');
    }
    const folder = path.resolve(base, k.folder);
    const inside = (rel) => {
      const full = path.resolve(base, ...String(rel).split('/'));
      return full.startsWith(folder + path.sep) ? full : null;
    };
    for (const rel of Array.isArray(info.removed) ? info.removed : []) {
      const full = inside(rel);
      if (full) fs.rmSync(full, { force: true });
    }
    const present = new Set(await listFiles(base, folder));
    for (const rel of present) {
      if (!Object.prototype.hasOwnProperty.call(info.contents, rel)) fs.rmSync(path.join(base, ...rel.split('/')), { force: true });
    }
    for (const [rel, sha256] of Object.entries(info.contents)) {
      const full = inside(rel);
      if (!full || !present.has(rel)) throw new Error(`${rel} is missing after the update`);
      if (await sha256File(full) !== sha256) throw new Error(`${rel} does not match after the update`);
    }
  }

  async function installDelta(url, manifest, current, entry) {
    const file = await fetchEntry(url, entry);
    onProgress({ phase: 'unpack' });
    const expect = { from: current.version, to: manifest.version };
    await install(
      async (stage) => {
        await fsp.cp(target, path.join(stage, k.folder), { recursive: true });
        await unpack(file, stage);
        await applyDeltaInfo(stage, expect);
      },
      async (base) => {
        await unpack(file, base);
        await applyDeltaInfo(base, expect);
      },
    );
    forgetPart(file);
  }

  async function installWhole(url, entry) {
    const file = await fetchEntry(url, entry);
    onProgress({ phase: 'unpack' });
    await install((stage) => unpack(file, stage), (base) => unpack(file, base));
    forgetPart(file);
  }

  async function download(centralUrl) {
    if (busy) throw new Error(`${kind === 'studio' ? 'Studio is' : 'The game files are'} already downloading.`);
    const url = normalizeUrl(centralUrl || '');
    if (url === null) throw new Error('Enter the server address first, for example http://100.101.102.103');
    busy = true;
    try {
      onProgress({ phase: 'checking' });
      const manifest = await manifestFrom(url);
      fs.mkdirSync(downloads, { recursive: true });
      const current = installed();
      let plan = planFor(manifest, current);
      if (plan.type === 'delta') {
        log(`Updating ${k.what} ${current.version} -> ${manifest.version}: ${plan.entry.changed !== undefined ? `${plan.entry.changed} changed files, ` : ''}${(plan.entry.size / 1048576).toFixed(1)} MB.`);
        try {
          await installDelta(url, manifest, current, plan.entry);
        } catch (error) {
          log(`The small update did not work (${error.message}); downloading all of ${k.what} instead.`);
          plan = planFor(manifest, null);
        }
      }
      if (plan.type !== 'delta') {
        log(`Downloading all of ${k.what} (version ${manifest.version}, ${(plan.entry.size / 1048576).toFixed(1)} MB${plan.type === 'zip' ? ', zip' : ''}).`);
        try {
          await installWhole(url, plan.entry);
        } catch (error) {
          // A server whose list names a package it cannot hand out yet: the zip.
          if (plan.type !== 'package' || error.status !== 404) throw error;
          plan = { type: 'zip', entry: { file: `${k.file}.zip`, size: manifest.size, sha256: manifest.sha256 } };
          log(`The server has no ${manifest.package.file} yet; downloading the zip instead.`);
          await installWhole(url, plan.entry);
        }
      }
      if (!canPlay()) throw new Error(`${kind === 'studio' ? 'Studio was' : 'The game files were'} unpacked but ${k.missing}; ask your host to rebuild ${kind === 'studio' ? 'it' : 'them'}.`);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ version: manifest.version, sha256: plan.entry.sha256, from: url, via: plan.type, installedAt: new Date().toISOString() }, null, 2));
      onProgress({ phase: 'done', version: manifest.version });
      return { version: manifest.version, via: plan.type };
    } finally {
      busy = false;
    }
  }

  // A newer version on the server, or null. size is what the download will be.
  async function update(centralUrl) {
    const current = installed();
    const url = normalizeUrl(centralUrl || '');
    if (!current || url === null) return null;
    try {
      const manifest = await manifestFrom(url, 3000);
      if (manifest.version === current.version) return null;
      return { installed: current.version, available: manifest.version, size: planFor(manifest, current).entry.size };
    } catch (error) {
      return null;
    }
  }

  return { installed, download, update, isBusy: () => busy, planFor };
};

module.exports.HAS_ZSTD = HAS_ZSTD;
