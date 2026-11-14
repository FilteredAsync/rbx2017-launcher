'use strict';

// Converts a place saved by a newer Roblox Studio for the 2017 client and RCC.
//
//   node convert-place.js <place.rbxlx> [options]
//     --from-place <id>   the Roblox place ID it came from (finds its universe,
//                         for rbxgameasset:// images)
//     --universe <id>     the universe ID, if you already know it
//     --out <file>        where to write (default: <name>.2017.rbxlx beside it)
//     --install           also make it the hosted place (Server/content/place.rbxlx;
//                         the old one is kept as a .bak file)
//
// See lib/placefile.js for what is changed. convertPlace.bat runs this.

const fs = require('fs');
const path = require('path');
const core = require('./lib/core');
const placefile = require('./lib/placefile');
const assets = require('./lib/assets');
const unionshapes = require('./lib/unionshapes');

function usage() {
  console.log('Usage: convert-place.js <place.rbxlx> [--from-place <id>] [--universe <id>] [--out <file>] [--install]');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { input: null, fromPlace: null, universe: null, out: null, install: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-place') options.fromPlace = argv[++i];
    else if (arg === '--universe') options.universe = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--install') options.install = true;
    else if (arg === '--help' || arg === '-h') usage();
    else if (options.input === null) options.input = arg;
    else usage();
  }
  if (options.input === null) usage();
  return options;
}

function outputPath(input) {
  const parsed = path.parse(input);
  const ext = parsed.ext.toLowerCase() === '.rbxmx' ? '.rbxmx' : '.rbxlx';
  return path.join(parsed.dir, `${parsed.name.replace(/\.2017$/i, '')}.2017${ext}`);
}

// Copies `file` over the hosted place, keeping the old one as a .bak.
function install(file) {
  const target = core.rootPath('Server', 'content', 'place.rbxlx');
  let backup = null;
  if (core.isFile(target)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    backup = core.rootPath('Server', 'content', `place-${stamp}.rbxlx.bak`);
    fs.copyFileSync(target, backup);
  }
  fs.copyFileSync(file, target);
  return { target, backup };
}

async function convertFile(input, options) {
  let universeId = options.universe && /^\d+$/.test(options.universe) ? options.universe : null;
  if (universeId === null && options.fromPlace) {
    universeId = await placefile.universeForPlace(options.fromPlace);
    if (universeId === null) throw new Error(`Could not find the universe of Roblox place ${options.fromPlace}.`);
  }
  // Union collision shapes from the unions' meshes, downloaded from Roblox
  // (lib/unionshapes.js); without them unions keep the old rule.
  const bytes = fs.readFileSync(input);
  const fetchAsset = async (id) => {
    const download = await assets.downloadAsset('id', id);
    return download.ok ? assets.normalizeAsset(download.body).bytes : null;
  };
  const unionShapes = await unionshapes.buildShapes(placefile.unionsNeedingShapes(bytes), fetchAsset).catch(() => new Map());
  const result = placefile.convertPlace(bytes, { universeId, unionShapes });
  const out = options.out || outputPath(input);
  fs.writeFileSync(out, result.output);
  let installed = null;
  if (options.install) installed = install(out);
  return { out, universeId, summary: result.summary, installed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = path.resolve(options.input);
  console.log(`Converting ${input}`);
  const result = await convertFile(input, options);
  if (result.universeId) console.log(`Universe ${result.universeId}`);
  for (const line of result.summary) console.log(line);
  console.log(`Wrote ${result.out}`);
  if (result.installed) {
    console.log(`Now hosted: ${result.installed.target}${result.installed.backup ? ` (old place kept as ${path.basename(result.installed.backup)})` : ''}`);
    console.log('Restart hosting to load it.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { convertFile, outputPath, install };
