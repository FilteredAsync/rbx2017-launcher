'use strict';

// Join codes: one code a host shares privately (Discord, a message) gets a
// player onto the game server's Tailscale network, without a Tailscale
// account or an invite. The code holds the server's address and a Tailscale
// auth key the host made for players (reusable, tagged so the network's
// access rules let it reach the game server only; see README-SERVER.txt).
//
// join() installs Tailscale if needed (the official, signed installer from
// pkgs.tailscale.com; Windows asks for permission once), signs this PC in
// with the key, and waits until the server answers.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
const MSI_URL = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi';
const PREFIX = 'RBX1-';

// "RBX1-<base64url JSON>" -> { server, authKey, name }
function parseJoinCode(text) {
  const code = String(text || '').trim().replace(/\s+/g, '');
  if (!code.toUpperCase().startsWith(PREFIX)) throw new Error('That is not a join code (join codes start with RBX1-).');
  let data;
  try {
    data = JSON.parse(Buffer.from(code.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error('That join code is damaged. Copy it again from your host.');
  }
  const server = typeof data.s === 'string' && /^https?:\/\/[A-Za-z0-9.[\]:-]+\/?$/.test(data.s) ? data.s.replace(/\/$/, '') : null;
  const authKey = typeof data.k === 'string' && /^tskey-[A-Za-z0-9-]{10,200}$/.test(data.k) ? data.k : null;
  if (!server || !authKey) throw new Error('That join code is incomplete. Ask your host for a new one.');
  return { server, authKey, name: typeof data.n === 'string' ? data.n.slice(0, 60) : '' };
}

function installed() {
  return fs.existsSync(EXE);
}

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// -> { state: 'Running' | 'NeedsLogin' | 'Stopped' | ..., ip } or null
async function status() {
  if (!installed()) return null;
  const result = await run(EXE, ['status', '--json'], 10000);
  try {
    const data = JSON.parse(result.stdout);
    const ip = ((data.Self && data.Self.TailscaleIPs) || []).find((value) => /^100\./.test(value)) || null;
    return { state: data.BackendState || 'Unknown', ip };
  } catch (error) {
    return { state: 'Unknown', ip: null };
  }
}

async function reachable(server, timeoutMs = 4000) {
  try {
    const response = await fetch(`${server}/api/games`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function downloadInstaller(folder, onProgress) {
  fs.mkdirSync(folder, { recursive: true });
  const response = await fetch(MSI_URL);
  if (!response.ok || !response.body) throw new Error(`Could not download Tailscale (HTTP ${response.status}).`);
  if (new URL(response.url).hostname !== 'pkgs.tailscale.com') throw new Error('The Tailscale download came from an unexpected place.');
  const file = path.join(folder, path.basename(new URL(response.url).pathname) || 'tailscale-setup.msi');
  const total = Number(response.headers.get('content-length')) || 0;
  const out = fs.openSync(file, 'w');
  let received = 0;
  let shown = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(out, value);
      received += value.length;
      if (Date.now() - shown > 250) {
        shown = Date.now();
        onProgress({ phase: 'tailscale-download', received, total });
      }
    }
  } finally {
    fs.closeSync(out);
  }
  return file;
}

// Runs only an installer signed by Tailscale Inc. (checked by Windows).
function verifySignature(file) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const [state, subject] = String(result.stdout || '').trim().split('|');
  if (state !== 'Valid' || !/O=Tailscale Inc\.?/i.test(subject || '')) {
    throw new Error('The downloaded Tailscale installer is not signed by Tailscale, so it was not run.');
  }
}

// Installs Tailscale; Windows asks the player for permission.
function installMsi(file) {
  const script = `try { $p = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList '/i', '"${file.replace(/'/g, "''")}"', '/qb!', '/norestart'; exit $p.ExitCode } catch { exit 1223 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status === 1223) throw new Error('Tailscale needs your permission to install. Try again and choose Yes.');
  if (result.status !== 0 && result.status !== 3010) throw new Error(`Tailscale did not install (code ${result.status}).`);
}

function hostnameFor(username) {
  const base = String(username || os.hostname() || 'player').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `rbx-${base || 'player'}`.slice(0, 40);
}

// The whole join: -> { server, alreadyConnected }
async function join({ code, username, workDir, onProgress = () => {} }) {
  const { server, authKey } = parseJoinCode(code);
  onProgress({ phase: 'checking' });
  // Already on the right network (the host, a member, or joined before).
  if (await reachable(server)) return { server, alreadyConnected: true };

  if (!installed()) {
    onProgress({ phase: 'tailscale-download', received: 0, total: 0 });
    const msi = await downloadInstaller(path.join(workDir, 'tailscale'), onProgress);
    onProgress({ phase: 'tailscale-verify' });
    verifySignature(msi);
    onProgress({ phase: 'tailscale-install' });
    installMsi(msi);
    try { fs.unlinkSync(msi); } catch (error) { /* in use */ }
    for (let i = 0; i < 30 && !installed(); i++) await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!installed()) throw new Error('Tailscale did not finish installing.');
    // Give its background service a moment to start.
    for (let i = 0; i < 20; i++) {
      const now = await status();
      if (now && now.state !== 'Unknown') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  onProgress({ phase: 'tailscale-connect' });
  const login = await run(EXE, ['login', `--auth-key=${authKey}`, `--hostname=${hostnameFor(username)}`, '--timeout=60s'], 75000);
  if (login.code !== 0) {
    const text = `${login.stderr} ${login.stdout}`.trim();
    if (/invalid key|expired|not valid/i.test(text)) throw new Error('This join code has expired or was revoked. Ask your host for a new one.');
    throw new Error(`Tailscale could not connect: ${text.slice(0, 160) || `code ${login.code}`}`);
  }
  onProgress({ phase: 'reaching-server' });
  for (let i = 0; i < 25; i++) {
    if (await reachable(server)) return { server, alreadyConnected: false };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Connected to Tailscale, but the server does not answer. Is it running? (Your host can check its access rules.)');
}

module.exports = { parseJoinCode, join, installed, status, reachable, hostnameFor, downloadInstaller, verifySignature, PREFIX };
