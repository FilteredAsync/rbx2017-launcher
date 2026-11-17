// The Windows 7, 8 and 8.1 launcher (npm run dist:win7): the same app on
// Electron 22, the last Electron for those Windows versions (legacy.js fills
// in what it lacks). It is 32-bit like the 2017 client, so 32-bit Windows 7
// runs it too. Its updates come from win7.yml in each release, so every
// release needs both installers (tools/publish-release.js checks).

const { electronDist, ...base } = require('../package.json').build;

module.exports = {
  ...base,
  electronVersion: '22.3.27',
  publish: base.publish.map((target) => ({ ...target, channel: 'win7' })),
  nsis: { ...base.nsis, artifactName: 'RobloxClient-Setup-Win7-${version}.${ext}' },
};
