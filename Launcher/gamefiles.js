'use strict';

// Game files for installs from the small Setup.exe (no game client inside).
// On first run, and when the server has a newer version, the launcher
// downloads <server>/download/client-files.zip, checks its size and SHA-256,
// and unpacks it into the install folder; config/client-files.json records
// the version. No Electron here, so it can be tested with plain Node.
//
//   const files = require('./gamefiles')({ root, normalizeUrl, canPlay, onProgress });
//   files.installed()            -> { version, ... } or null
//   await files.download(url)    -> { version }
//   await files.update(url)      -> { installed, available, size } or null

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function gameFiles({ root, normalizeUrl, canPlay, onProgress = () => {} }) {
  const stateFile = path.join(root, 'config', 'client-files.json');
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
      response = await fetch(`${url}/download/client-files.json`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`Could not reach ${url}. Is Tailscale connected, and is the server running?`);
    }
    if (response.status === 404) throw new Error('That server has no game files to hand out yet (its host runs tools/build-client-files.py).');
    if (!response.ok) throw new Error(`The server answered HTTP ${response.status}.`);
    const manifest = await response.json().catch(() => null);
    if (!manifest || !/^[0-9a-f]{64}$/.test(String(manifest.sha256)) || !Number.isFinite(manifest.size)) {
      throw new Error('The server sent a broken game files list.');
    }
    return manifest;
  }

  function unpack(zip, destination) {
    return new Promise((resolve, reject) => {
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const child = spawn(tar, ['-xf', zip, '-C', destination], { windowsHide: true });
      let errors = '';
      child.stderr.on('data', (chunk) => { errors += chunk; });
      child.on('error', (error) => reject(new Error(`Could not unpack the game files: ${error.message}`)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack the game files: ${errors.trim().slice(0, 200) || `tar exit code ${code}`}`))));
    });
  }

  async function download(centralUrl) {
    if (busy) throw new Error('The game files are already downloading.');
    const url = normalizeUrl(centralUrl || '');
    if (url === null) throw new Error('Enter the server address first, for example http://100.101.102.103');
    busy = true;
    const folder = path.join(root, 'downloads');
    const part = path.join(folder, 'client-files.zip.part');
    try {
      onProgress({ phase: 'checking' });
      const manifest = await manifestFrom(url);
      fs.mkdirSync(folder, { recursive: true });
      let response;
      try {
        response = await fetch(`${url}/download/client-files.zip`);
      } catch (error) {
        throw new Error(`The download could not start: ${error.cause && error.cause.code ? error.cause.code : error.message}`);
      }
      if (!response.ok || !response.body) throw new Error(`The download failed (HTTP ${response.status}).`);
      const hash = crypto.createHash('sha256');
      const out = fs.openSync(part, 'w');
      let received = 0;
      let shown = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          fs.writeSync(out, value);
          hash.update(value);
          received += value.length;
          if (Date.now() - shown > 200) {
            shown = Date.now();
            onProgress({ phase: 'download', received, total: manifest.size });
          }
        }
      } catch (error) {
        throw new Error('The connection dropped during the download. Try again.');
      } finally {
        fs.closeSync(out);
      }
      onProgress({ phase: 'download', received, total: manifest.size });
      if (received !== manifest.size || hash.digest('hex') !== manifest.sha256) {
        throw new Error('The download was damaged (its size or checksum did not match). Try again.');
      }
      onProgress({ phase: 'unpack' });
      await unpack(part, root);
      if (!canPlay()) throw new Error('The game files were unpacked but the client is missing; ask your host to rebuild them.');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ version: manifest.version, sha256: manifest.sha256, from: url, installedAt: new Date().toISOString() }, null, 2));
      onProgress({ phase: 'done', version: manifest.version });
      return { version: manifest.version };
    } finally {
      busy = false;
      try { fs.unlinkSync(part); } catch (error) { /* none */ }
    }
  }

  // A newer version of the game files on the server, or null.
  async function update(centralUrl) {
    const current = installed();
    const url = normalizeUrl(centralUrl || '');
    if (!current || url === null) return null;
    try {
      const manifest = await manifestFrom(url, 3000);
      return manifest.version !== current.version ? { installed: current.version, available: manifest.version, size: manifest.size } : null;
    } catch (error) {
      return null;
    }
  }

  return { installed, download, update, isBusy: () => busy };
};
