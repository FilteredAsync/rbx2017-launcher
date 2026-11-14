'use strict';

// Compression between this server and players' launchers. The 2017 client,
// RCC and Studio never see it: they talk to the launcher's local proxy
// (lib/proxy.js), which asks for compressed answers (X-Launcher-Proxy plus
// an Accept-Encoding), undoes the compression itself, and hands them plain
// bytes. Only routes that set ctx.compress (assets and place files) compress,
// and only bytes that are not already compressed (pictures, sounds, archives).
//
//   encodingFor(req)          'zstd' | 'br' | 'gzip' | null
//   worthCompressing(head)    false for PNG, JPEG, GIF, WebP, OGG, MP3, zip, gzip, zstd
//   compressSync(encoding, buffer) / encoder(encoding)

const zlib = require('zlib');

const MIN_BYTES = 1024;
const HAS_ZSTD = typeof zlib.createZstdCompress === 'function';

// What the launcher's proxy asked for, best first; null for everyone else.
function encodingFor(req) {
  if (!req || !req.headers['x-launcher-proxy']) return null;
  const offered = new Set();
  for (const part of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)).find(Boolean);
    if (name && !(q && Number(q[1]) === 0)) offered.add(name.trim());
  }
  if (HAS_ZSTD && offered.has('zstd')) return 'zstd';
  if (offered.has('br')) return 'br';
  if (offered.has('gzip')) return 'gzip';
  return null;
}

// The first bytes of an answer: false when it is already compressed.
function worthCompressing(head) {
  if (!head || head.length < 4) return false;
  const text = head.subarray(0, 12).toString('latin1');
  if (text.startsWith('\x89PNG') || text.startsWith('GIF8') || text.startsWith('OggS') || text.startsWith('ID3') || text.startsWith('fLaC')) return false;
  if (text.startsWith('PK\x03\x04') || text.startsWith('\x28\xb5\x2f\xfd') || text.startsWith('BZh')) return false;
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return false;
  if (head[0] === 0xff && head[1] === 0xd8) return false; // JPEG
  if (head[0] === 0x1f && head[1] === 0x8b) return false; // gzip
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return false; // MP3 frame
  return true;
}

// Fast settings: the server compresses while it answers.
function encoder(encoding) {
  if (encoding === 'zstd') return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
  if (encoding === 'br') return zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
  return zlib.createGzip({ level: 6 });
}

function compressSync(encoding, buffer) {
  if (encoding === 'zstd') return zlib.zstdCompressSync(buffer, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length } });
  }
  return zlib.gzipSync(buffer, { level: 6 });
}

module.exports = { encodingFor, worthCompressing, encoder, compressSync, MIN_BYTES, HAS_ZSTD };
