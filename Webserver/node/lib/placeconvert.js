'use strict';

// Converting a game's place file for the engine the game runs on
// (lib/placefile.js), and the report on it (lib/convertreport.js, shown on
// /manage). Once the converted file is stored, a throwaway game server of
// that engine checks it in the background (lib/convertcheck.js: scripts
// compile, the place loads and runs) and the report gets the results; one
// check at a time, none when config/host.json has "convertCheck": false.
// lib/routes.js uses it for uploads and "Convert again".

const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const path = require('path');
const core = require('./core');
const engines = require('./engines');
const placefile = require('./placefile');
const rbxbinary = require('./rbxbinary');
const unionshapes = require('./unionshapes');
const convertreport = require('./convertreport');
const convertcheck = require('./convertcheck');

const CHECK_SECONDS = 15;

function checksOn() {
  const config = core.readJsonFile(core.rootPath('config', 'host.json')) || {};
  return config.convertCheck !== false;
}

// A free TCP port (SOAP) and a free UDP port (the check's game server).
function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

module.exports = function placeconvert({ assetBytes, log = () => {} }) {
  // Collision shapes for a place's unions, made from their meshes
  // (lib/unionshapes.js); unions without one keep the converter's old rule.
  async function unionShapes(xml) {
    try {
      return await unionshapes.buildShapes(placefile.unionsNeedingShapes(xml), assetBytes);
    } catch (error) {
      return new Map();
    }
  }

  // A place file (XML, or binary read into XML: lib/rbxbinary.js) through the
  // converter for `engine` -> { bytes, notes, engine, counts, scripts };
  // bytes are what the server stores (binary when it can).
  async function convert(bytes, { universeId = null, engine = null } = {}) {
    const target = engines.known(engine) || engines.DEFAULT_ENGINE;
    const input = rbxbinary.placeXml(bytes);
    // The self-hosted years (2009, 2013; lib/engines.js) take places as they
    // were made then: stored as uploaded, as XML (they read no binary files).
    if (engines.selfHosted(target)) {
      const xml = Buffer.isBuffer(input.xml) ? input.xml : Buffer.from(input.xml);
      return { bytes: xml, notes: [...input.notes, `Stored as uploaded: ${target} games are not converted.`], engine: target, counts: null, scripts: [] };
    }
    const result = placefile.convertPlace(input.xml, { universeId, engine: target, unionShapes: await unionShapes(input.xml) });
    const stored = rbxbinary.placeToStore(result.output);
    let scripts = [];
    try {
      // Each with whether the converter changed it (the check tells errors
      // the original had apart).
      const before = new Map();
      const seen = new Map();
      const key = (x) => { const n = (seen.get(x.path) || 0) + 1; seen.set(x.path, n); return `${x.path}#${n}`; };
      for (const x of placefile.scriptsOf(input.xml)) before.set(key(x), x.source);
      seen.clear();
      scripts = placefile.scriptsOf(result.output).map((x) => {
        const original = before.get(key(x));
        return Object.assign({ path: x.path, className: x.className, source: x.source }, original === undefined ? {} : original !== x.source ? { original } : { unchanged: true });
      });
    } catch (error) { /* no compile check then */ }
    return { bytes: stored.bytes, notes: [...input.notes, ...result.summary, ...stored.notes], engine: target, counts: result.counts, scripts };
  }

  // A model (Studio's Toolbox inserts it) through the same converter, for
  // 2017 Studio -> its XML.
  async function convertModel(bytes) {
    const input = rbxbinary.placeXml(bytes);
    return placefile.convertPlace(input.xml, { unionShapes: await unionShapes(input.xml) }).output;
  }

  const queue = [];
  let checking = false;

  async function runChecks() {
    if (checking) return;
    checking = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        // A newer conversion of the same place is waiting: skip this one.
        if (queue.some((other) => other.placeId === job.placeId)) continue;
        const engine = engines.get(job.engine);
        const rccDir = core.rootPath(engine.server);
        if (!core.isFile(path.join(rccDir, 'RCCService.exe'))) continue;
        let place;
        try { place = fs.readFileSync(job.file); } catch (error) { continue; }
        const started = Date.now();
        let result;
        try {
          result = await convertcheck.check({
            engine: engine.id, rccDir, place, scripts: job.scripts, seconds: CHECK_SECONDS,
            soapPort: await freeTcpPort(), gamePort: await freeUdpPort(),
          });
        } catch (error) {
          log(`check of place ${job.placeId} failed: ${error.message}`);
          continue;
        }
        // Still the report of this conversion?
        const current = convertreport.read(job.placeId);
        if (!current || current.convertedAt !== job.report.convertedAt) continue;
        const report = convertreport.build({ placeId: job.placeId, engine: engine.id, convertedAt: job.report.convertedAt, counts: job.counts, check: result });
        convertreport.write(job.placeId, report);
        log(`place ${job.placeId} checked on ${engine.label} in ${Math.round((Date.now() - started) / 1000)} s: `
          + `${result.loads ? 'loads' : 'does not load'}, ${result.scriptsFailed === null ? '?' : result.scriptsFailed} of ${result.scripts} scripts fail to compile, ${result.runErrors.length} script errors`);
      }
    } finally {
      checking = false;
    }
  }

  // After the converted file is stored as the place's current file: its
  // report now, and the check in the background.
  function stored(placeId, converted, file) {
    const report = convertreport.build({ placeId, engine: converted.engine, counts: converted.counts, check: null });
    convertreport.write(placeId, report);
    if (!file || !checksOn()) return report;
    queue.push({ placeId: String(placeId), engine: converted.engine, counts: converted.counts, scripts: converted.scripts, file, report });
    setImmediate(() => runChecks().catch((error) => log(`converter check: ${error.message}`)));
    return report;
  }

  return { convert, convertModel, stored, unionShapes };
};
