// The full installer (npm run dist:full): the downloader edition from
// package.json plus the game client itself, so nothing needs downloading.
// It contains Roblox's 2017 client: share it privately, never on GitHub.

const base = require('../package.json').build;
const fs = require('fs');
const path = require('path');

const extraFiles = [
  ...base.extraFiles,
  {
    from: '../Client',
    to: 'Client',
    filter: [
      '**/*',
      '!RobloxPlayerBeta_aecandidate.exe',
      '!RobloxPlayerBeta_tracecandidate.exe',
      '!rbxsig_private.pem',
      '!corescripts-original{,/**}',
    ],
  },
];
// Record which game files version this is (tools/build-client-files.py), so
// the launcher can offer updates from the server later.
const stamp = path.join(__dirname, '..', '..', 'downloads', 'client-files.json');
if (fs.existsSync(stamp)) extraFiles.push({ from: '../downloads/client-files.json', to: 'config/client-files.json' });

module.exports = {
  ...base,
  extraFiles,
  nsis: { ...base.nsis, artifactName: 'RobloxClient-Setup-Full-${version}.${ext}' },
};
