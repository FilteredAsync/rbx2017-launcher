'use strict';

// Tailscale on players' PCs. Players reach the server through the VPS relay
// now (no Tailscale, no join codes); the launcher only offers to remove a
// Tailscale that earlier join codes installed.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');

function installed() {
  return fs.existsSync(EXE);
}

// Tailscale's uninstall command from Windows' list of apps. Its setup.exe
// bundle (which removes the MSI inside too) before the bare MSI.
function uninstallCommand() {
  const found = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | "
    + "Where-Object { $_.DisplayName -like 'Tailscale*' -and $_.UninstallString } | ForEach-Object { $_.UninstallString }"], { encoding: 'utf8', windowsHide: true });
  const commands = String(found.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return commands.find((line) => /\.exe"?\s+\/uninstall/i.test(line) && !/msiexec/i.test(line)) || commands.find((line) => /msiexec/i.test(line)) || commands[0] || '';
}

// Once the server is reachable over the internet (the VPS relay), players no
// longer need Tailscale: this starts its own uninstaller (Windows shows its
// prompts) and resolves when that has finished -> { removed }.
async function uninstall() {
  if (!installed()) return { removed: true };
  const command = uninstallCommand();
  let file;
  let args;
  const msi = /msiexec(?:\.exe)?"?\s+\/[IX]\s*(\{[0-9A-Fa-f-]+\})/i.exec(command);
  if (msi) {
    file = 'msiexec.exe';
    args = ['/x', msi[1]];
  } else {
    const exe = /^"([^"]+)"\s*(.*)$/.exec(command) || /^(\S+\.exe)\s*(.*)$/i.exec(command);
    if (!exe) throw new Error('Could not find Tailscale\'s uninstaller. Remove it in Windows Settings > Apps.');
    file = exe[1];
    args = exe[2] ? exe[2].split(/\s+/).filter(Boolean) : [];
  }
  // Not hidden: the uninstaller's own window and Windows' permission prompt show.
  const code = await new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: false });
    child.on('error', () => resolve(-1));
    child.on('exit', (exitCode) => resolve(exitCode));
  });
  return { removed: !installed(), code };
}

module.exports = { installed, uninstall, uninstallCommand };
