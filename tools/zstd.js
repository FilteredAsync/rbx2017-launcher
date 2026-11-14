'use strict';

// Compresses standard input into a zstd file (used by tools/build-client-files.py,
// since Python before 3.14 has no zstd). Launchers unpack it with Node's zlib.
//
//   node tools/zstd.js <output file> [level, default 19]

const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const [output, levelText] = process.argv.slice(2);
if (!output) {
  console.error('usage: node tools/zstd.js <output file> [level]');
  process.exit(2);
}
if (typeof zlib.createZstdCompress !== 'function') {
  console.error(`This Node (${process.version}) has no zstd: use Node 22.15 or newer.`);
  process.exit(1);
}
const level = Number(levelText || 19);
pipeline(
  process.stdin,
  zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: level, [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
  fs.createWriteStream(output),
).catch((error) => {
  console.error(`zstd: ${error.message}`);
  process.exit(1);
});
