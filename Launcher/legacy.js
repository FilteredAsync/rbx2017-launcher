'use strict';

// Windows 7, 8 and 8.1 get the launcher on Electron 22, the last Electron
// for them (npm run dist:win7, build/win7.config.js). Its Node 16 has no
// fetch and its protocol module no handle(); this adds both, so the rest of
// the launcher is the same code on either Electron. On the normal build it
// changes nothing.
//
//   require('./legacy')   first thing in main.js
//   legacy.nodeFlags      flags for Node scripts run on Electron's Node

const { protocol } = require('electron');

const OLD_NODE = Number(process.versions.node.split('.')[0]) < 18;

if (typeof globalThis.fetch !== 'function') {
  const undici = require('undici');
  for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData']) {
    if (typeof globalThis[name] !== 'function') globalThis[name] = undici[name];
  }
}

if (typeof protocol.handle !== 'function') {
  // handler(request) -> Response, on the older buffer protocol.
  protocol.handle = (scheme, handler) => protocol.registerBufferProtocol(scheme, (request, callback) => {
    Promise.resolve()
      .then(() => handler({ url: request.url, method: request.method, headers: request.headers || {} }))
      .then(async (response) => {
        const headers = {};
        response.headers.forEach((value, name) => { headers[name] = value; });
        const mimeType = String(headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        callback({ statusCode: response.status, mimeType, headers, data: Buffer.from(await response.arrayBuffer()) });
      })
      .catch(() => callback({ statusCode: 500, mimeType: 'text/plain', data: Buffer.from('launcher error') }));
  });
}

module.exports = {
  // Node 16 has fetch only behind a flag (the web server's scripts use it).
  nodeFlags: OLD_NODE ? ['--experimental-fetch', '--no-warnings'] : [],
};
