'use strict';

// Unpacks a .zip with Node alone. Windows 7, 8 and 8.1 have no tar.exe
// (Windows 10 added it), so the Windows 7 launcher unpacks the game files
// with this. It reads the zip's directory, then each file: stored or
// deflated, Zip64 sizes too. Every path has to stay inside the destination.
// gamefiles.js checks the zip's SHA-256 before it gets here.
//
//   await require('./unzip')(file, destination)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// The zip's directory: where it is (end record, or the Zip64 one) and its bytes.
async function directory(handle, size) {
  const tailLength = Math.min(size, 22 + 65535);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  }
  if (at < 0) throw new Error('not a zip file');
  let count = tail.readUInt16LE(at + 10);
  let length = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    const locator = at - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('broken Zip64 file');
    const record = await readAt(handle, Number(tail.readBigUInt64LE(locator + 8)), 56);
    if (record.length < 56 || record.readUInt32LE(0) !== 0x06064b50) throw new Error('broken Zip64 file');
    count = Number(record.readBigUInt64LE(32));
    length = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  return { count, data: await readAt(handle, offset, length) };
}

function entries({ count, data }) {
  const list = [];
  let p = 0;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const flags = data.readUInt16LE(p + 8);
    const method = data.readUInt16LE(p + 10);
    let compressed = data.readUInt32LE(p + 20);
    let size = data.readUInt32LE(p + 24);
    const nameLength = data.readUInt16LE(p + 28);
    const extraLength = data.readUInt16LE(p + 30);
    const commentLength = data.readUInt16LE(p + 32);
    let local = data.readUInt32LE(p + 42);
    const name = data.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength);
    // Zip64: the real sizes and offset, for the fields that say 0xFFFFFFFF.
    const extraEnd = p + 46 + nameLength + extraLength;
    for (let q = p + 46 + nameLength; q + 4 <= extraEnd;) {
      const id = data.readUInt16LE(q);
      const fieldLength = data.readUInt16LE(q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (size === 0xffffffff) { size = Number(data.readBigUInt64LE(r)); r += 8; }
        if (compressed === 0xffffffff) { compressed = Number(data.readBigUInt64LE(r)); r += 8; }
        if (local === 0xffffffff) local = Number(data.readBigUInt64LE(r));
      }
      q += 4 + fieldLength;
    }
    list.push({ name, flags, method, compressed, size, local });
    p = extraEnd + commentLength;
  }
  return list;
}

module.exports = async function unzip(file, destination) {
  const root = path.resolve(destination);
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    for (const entry of entries(await directory(handle, size))) {
      const name = entry.name.replace(/\\/g, '/');
      const target = path.resolve(root, name);
      if (!target.startsWith(root + path.sep)) throw new Error(`a path outside the folder: ${entry.name}`);
      if (name.endsWith('/')) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      if (entry.flags & 0x1) throw new Error(`an encrypted file: ${entry.name}`);
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`compression ${entry.method} in ${entry.name}`);
      const header = await readAt(handle, entry.local, 30);
      if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error(`a broken entry: ${entry.name}`);
      const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (entry.compressed === 0) {
        await fsp.writeFile(target, Buffer.alloc(0));
      } else {
        const input = fs.createReadStream(file, { start, end: start + entry.compressed - 1 });
        const output = fs.createWriteStream(target);
        await (entry.method === 8 ? pipeline(input, zlib.createInflateRaw(), output) : pipeline(input, output));
      }
      if ((await fsp.stat(target)).size !== entry.size) throw new Error(`a broken entry: ${entry.name}`);
    }
  } finally {
    await handle.close();
  }
};
