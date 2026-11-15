'use strict';

// Roblox's binary place and model format (.rbxl / .rbxm), both ways:
//
//   toXml(bytes)    a binary file -> the XML Roblox Studio writes for it
//                   (.rbxlx / .rbxmx). lib/placefile.js converts XML only.
//   fromXml(bytes)  an XML place -> a binary file the way a 2017 Studio
//                   wrote it (version 0, LZ4 chunks, only the chunk and
//                   value types of 2017), which the server stores for RCC.
//
// The format (rbx-dom's docs/binary.md describes it): a 32-byte header
// ("<roblox!", signature 89 FF 0D 0A 1A 0A, version 0, class and instance
// counts), then chunks: META (file metadata), SSTR (shared strings), INST
// (one per class: its instances' referents), PROP (one per class and
// property: every instance's value), PRNT (who is whose parent) and END.
// A chunk is LZ4 (block) or, from newer Studio, zstd compressed, or stored.
// Numbers in value arrays are big-endian and byte-interleaved (all first
// bytes, then all second bytes...); integers are zigzag encoded, floats have
// the sign bit moved to the end, referents are differences from the one
// before.

const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isUtf8 } = require('buffer');

const MAGIC = '<roblox!';
const SIGNATURE = Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZSTD_MAGIC = 0xfd2fb528;
const API_DUMP = path.join(__dirname, '..', '..', '..', 'Client', 'apidump.txt');

const T = {
  String: 0x01, Bool: 0x02, Int32: 0x03, Float32: 0x04, Float64: 0x05, UDim: 0x06, UDim2: 0x07, Ray: 0x08,
  Faces: 0x09, Axes: 0x0a, BrickColor: 0x0b, Color3: 0x0c, Vector2: 0x0d, Vector3: 0x0e, Vector2int16: 0x0f,
  CFrame: 0x10, Quaternion: 0x11, Enum: 0x12, Ref: 0x13, Vector3int16: 0x14, NumberSequence: 0x15,
  ColorSequence: 0x16, NumberRange: 0x17, Rect: 0x18, PhysicalProperties: 0x19, Color3uint8: 0x1a, Int64: 0x1b,
  SharedString: 0x1c, ProtectedString: 0x1d, OptionalCFrame: 0x1e, UniqueId: 0x1f, Font: 0x20,
  SecurityCapabilities: 0x21, Content: 0x22,
};
const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([name, id]) => [id, name]));
const typeName = (id) => TYPE_NAMES[id] || `0x${id.toString(16).padStart(2, '0')}`;

function isBinary(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.toString('latin1', 0, 8) === MAGIC;
}

// --- LZ4 (block format) ---------------------------------------------------------

function lz4Decompress(src, start, end, size) {
  const out = Buffer.allocUnsafe(size);
  let s = start;
  let o = 0;
  while (s < end) {
    const token = src[s++];
    let literals = token >>> 4;
    if (literals === 15) {
      let b;
      do { b = src[s++]; literals += b; } while (b === 255 && s < end);
    }
    if (s + literals > end || o + literals > size) throw new Error('bad LZ4 data');
    if (literals < 32) {
      for (let k = 0; k < literals; k++) out[o++] = src[s++];
    } else {
      src.copy(out, o, s, s + literals);
      o += literals;
      s += literals;
    }
    if (s >= end) break; // the last sequence has literals only
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    let length = token & 15;
    if (length === 15) {
      let b;
      do { b = src[s++]; length += b; } while (b === 255 && s < end);
    }
    length += 4;
    if (offset === 0 || offset > o || o + length > size) throw new Error('bad LZ4 data');
    let m = o - offset;
    if (offset >= length && length >= 32) {
      out.copyWithin(o, m, m + length);
      o += length;
    } else {
      for (let k = 0; k < length; k++) out[o++] = out[m++];
    }
  }
  if (o !== size) throw new Error('bad LZ4 data (wrong size)');
  return out;
}

// Greedy LZ4 block compression (any LZ4 decoder reads it). Keeps the format's
// end rules: the last 5 bytes are literals, no match starts in the last 12.
function lz4Compress(src) {
  const n = src.length;
  const out = Buffer.allocUnsafe(n + Math.ceil(n / 255) + 16);
  let o = 0;
  let anchor = 0;
  const emit = (literalEnd, matchLength, offset) => {
    const literals = literalEnd - anchor;
    const tokenAt = o++;
    let token = (literals >= 15 ? 15 : literals) << 4;
    if (literals >= 15) {
      let rest = literals - 15;
      while (rest >= 255) { out[o++] = 255; rest -= 255; }
      out[o++] = rest;
    }
    src.copy(out, o, anchor, literalEnd);
    o += literals;
    if (matchLength > 0) {
      out[o++] = offset & 255;
      out[o++] = offset >>> 8;
      const extra = matchLength - 4;
      token |= extra >= 15 ? 15 : extra;
      if (extra >= 15) {
        let rest = extra - 15;
        while (rest >= 255) { out[o++] = 255; rest -= 255; }
        out[o++] = rest;
      }
    }
    out[tokenAt] = token;
  };
  if (n > 12) {
    const table = new Int32Array(1 << 16).fill(-1);
    const matchStartLimit = n - 12;
    const matchEndLimit = n - 5;
    let s = 0;
    let misses = 0;
    while (s < matchStartLimit) {
      const sequence = src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24);
      const hash = Math.imul(sequence, 2654435761) >>> 16;
      let ref = table[hash];
      table[hash] = s;
      if (ref >= 0 && s - ref <= 65535
        && (src[ref] | (src[ref + 1] << 8) | (src[ref + 2] << 16) | (src[ref + 3] << 24)) === sequence) {
        let start = s;
        while (start > anchor && ref > 0 && src[start - 1] === src[ref - 1]) { start--; ref--; }
        let length = s - start + 4;
        while (start + length < matchEndLimit && src[start + length] === src[ref + length]) length++;
        emit(start, length, start - ref);
        s = start + length;
        anchor = s;
        misses = 0;
        if (s - 2 < matchStartLimit && s >= 2) {
          const p = s - 2;
          table[Math.imul(src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24), 2654435761) >>> 16] = p;
        }
      } else {
        s += 1 + (misses++ >> 6);
      }
    }
  }
  emit(n, 0, 0);
  return out.subarray(0, o);
}

// --- Chunks ---------------------------------------------------------------------------

function header(bytes) {
  if (!isBinary(bytes)) throw new Error('This is not a binary Roblox place or model file.');
  if (bytes.length < 32 || !bytes.subarray(8, 14).equals(SIGNATURE)) throw new Error('This binary place file is damaged (its header is wrong).');
  const version = bytes.readUInt16LE(14);
  if (version !== 0) throw new Error(`This binary place file uses format version ${version}, which is not supported.`);
  return { classCount: bytes.readInt32LE(16), instanceCount: bytes.readInt32LE(20) };
}

// Each chunk as { name, start, end, compressed, size }, data not yet unpacked.
function chunkList(bytes) {
  const chunks = [];
  let p = 32;
  while (p + 16 <= bytes.length) {
    const name = bytes.toString('latin1', p, p + 4).replace(/\0+$/, '');
    const compressed = bytes.readUInt32LE(p + 4);
    const size = bytes.readUInt32LE(p + 8);
    const start = p + 16;
    const end = start + (compressed || size);
    if (end > bytes.length) throw new Error(`This binary place file is cut short (in its ${name} chunk).`);
    chunks.push({ name, start, end, compressed, size });
    p = end;
    if (name === 'END') break;
  }
  return chunks;
}

function chunkData(bytes, chunk) {
  if (chunk.compressed === 0) return bytes.subarray(chunk.start, chunk.end);
  if (chunk.size === 0) return Buffer.alloc(0);
  if (chunk.end - chunk.start >= 4 && bytes.readUInt32LE(chunk.start) === ZSTD_MAGIC) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error(`This place was saved by a newer Roblox Studio with zstd compression, which needs Node.js 22.15 or newer (this server runs ${process.version}).`);
    }
    const out = zlib.zstdDecompressSync(bytes.subarray(chunk.start, chunk.end), { maxOutputLength: chunk.size });
    if (out.length !== chunk.size) throw new Error(`bad zstd data in a ${chunk.name} chunk`);
    return out;
  }
  return lz4Decompress(bytes, chunk.start, chunk.end, chunk.size);
}

// --- Value arrays -----------------------------------------------------------------

function need(d, p, bytes) {
  if (p + bytes > d.length) throw new Error('ends early');
}

function u32s(d, p, n) {
  need(d, p, 4 * n);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((d[p + i] << 24) | (d[p + n + i] << 16) | (d[p + 2 * n + i] << 8) | d[p + 3 * n + i]) >>> 0;
  return out;
}

function i32s(d, p, n) {
  need(d, p, 4 * n);
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const u = ((d[p + i] << 24) | (d[p + n + i] << 16) | (d[p + 2 * n + i] << 8) | d[p + 3 * n + i]) >>> 0;
    out[i] = (u >>> 1) ^ -(u & 1);
  }
  return out;
}

function f32s(d, p, n) {
  need(d, p, 4 * n);
  const out = new Float32Array(n);
  const bits = new Uint32Array(out.buffer);
  for (let i = 0; i < n; i++) {
    const u = ((d[p + i] << 24) | (d[p + n + i] << 16) | (d[p + 2 * n + i] << 8) | d[p + 3 * n + i]) >>> 0;
    bits[i] = (u >>> 1) | (u << 31);
  }
  return out;
}

function refs(d, p, n) {
  const out = i32s(d, p, n);
  for (let i = 1; i < n; i++) out[i] += out[i - 1];
  return out;
}

// n interleaved big-endian values of `width` bytes -> n * width bytes, value by value.
function deinterleave(d, p, n, width) {
  need(d, p, n * width);
  const out = Buffer.allocUnsafe(n * width);
  for (let b = 0; b < width; b++) {
    for (let i = 0; i < n; i++) out[i * width + b] = d[p + b * n + i];
  }
  return out;
}

function i64s(d, p, n) {
  const raw = deinterleave(d, p, n, 8);
  const out = new BigInt64Array(n);
  for (let i = 0; i < n; i++) {
    const u = raw.readBigUInt64BE(i * 8);
    out[i] = BigInt.asIntN(64, (u >> 1n) ^ -(u & 1n));
  }
  return out;
}

function u64s(d, p, n) {
  const raw = deinterleave(d, p, n, 8);
  const out = new BigUint64Array(n);
  for (let i = 0; i < n; i++) out[i] = raw.readBigUInt64BE(i * 8);
  return out;
}

// Rotation IDs: two axis directions (normal IDs Right, Top, Back, Left,
// Bottom, Front) -> the 24 axis-aligned rotations. id - 1 = 6 * (direction
// of the right vector) + (direction of the up vector).
const NORMALS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
const ROTATIONS = new Map(); // id -> [R00, R01, R02, R10, ..., R22]
for (let id = 1; id <= 36; id++) {
  const x = NORMALS[Math.floor((id - 1) / 6)];
  const y = NORMALS[(id - 1) % 6];
  if (x[0] * y[0] + x[1] * y[1] + x[2] * y[2] !== 0) continue;
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  ROTATIONS.set(id, [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]].map((v) => v + 0));
}

// -> { rotation: Float32Array(9n), x, y, z: Float32Array(n), end }
function cframes(d, p, n) {
  const rotation = new Float32Array(9 * n);
  for (let i = 0; i < n; i++) {
    need(d, p, 1);
    const id = d[p++];
    if (id === 0) {
      need(d, p, 36);
      for (let k = 0; k < 9; k++) rotation[9 * i + k] = d.readFloatLE(p + 4 * k);
      p += 36;
    } else {
      const matrix = ROTATIONS.get(id);
      if (!matrix) throw new Error(`unknown rotation ID ${id}`);
      rotation.set(matrix, 9 * i);
    }
  }
  const x = f32s(d, p, n);
  const y = f32s(d, p + 4 * n, n);
  const z = f32s(d, p + 8 * n, n);
  return { rotation, x, y, z, end: p + 12 * n };
}

function lengthString(d, p) {
  need(d, p, 4);
  const length = d.readUInt32LE(p);
  need(d, p + 4, length);
  return [p + 4, length];
}

// One PROP chunk's values (n of them) -> { col, end }. col holds typed arrays;
// strings stay as positions in the chunk data `d`.
function readValues(type, d, p, n) {
  switch (type) {
    case T.String:
    case T.ProtectedString: {
      const starts = new Uint32Array(n);
      const lengths = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const [start, length] = lengthString(d, p);
        starts[i] = start;
        lengths[i] = length;
        p = start + length;
      }
      return { col: { d, starts, lengths }, end: p };
    }
    case T.Bool:
      need(d, p, n);
      return { col: { v: d.subarray(p, p + n) }, end: p + n };
    case T.Int32:
      return { col: { v: i32s(d, p, n) }, end: p + 4 * n };
    case T.Float32:
      return { col: { v: f32s(d, p, n) }, end: p + 4 * n };
    case T.Float64: {
      need(d, p, 8 * n);
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) v[i] = d.readDoubleLE(p + 8 * i);
      return { col: { v }, end: p + 8 * n };
    }
    case T.UDim:
      return { col: { s: f32s(d, p, n), o: i32s(d, p + 4 * n, n) }, end: p + 8 * n };
    case T.UDim2:
      return {
        col: { xs: f32s(d, p, n), ys: f32s(d, p + 4 * n, n), xo: i32s(d, p + 8 * n, n), yo: i32s(d, p + 12 * n, n) },
        end: p + 16 * n,
      };
    case T.Ray: {
      need(d, p, 24 * n);
      const v = new Float32Array(6 * n);
      for (let i = 0; i < 6 * n; i++) v[i] = d.readFloatLE(p + 4 * i);
      return { col: { v }, end: p + 24 * n };
    }
    case T.Faces:
    case T.Axes:
      need(d, p, n);
      return { col: { v: d.subarray(p, p + n) }, end: p + n };
    case T.BrickColor:
    case T.Enum:
    case T.SharedString:
      return { col: { v: u32s(d, p, n) }, end: p + 4 * n };
    case T.Color3:
      return { col: { r: f32s(d, p, n), g: f32s(d, p + 4 * n, n), b: f32s(d, p + 8 * n, n) }, end: p + 12 * n };
    case T.Vector2:
      return { col: { x: f32s(d, p, n), y: f32s(d, p + 4 * n, n) }, end: p + 8 * n };
    case T.Vector3:
      return { col: { x: f32s(d, p, n), y: f32s(d, p + 4 * n, n), z: f32s(d, p + 8 * n, n) }, end: p + 12 * n };
    case T.Vector2int16:
    case T.Vector3int16: {
      const parts = type === T.Vector2int16 ? 2 : 3;
      need(d, p, 2 * parts * n);
      const v = new Int16Array(parts * n);
      for (let i = 0; i < parts * n; i++) v[i] = d.readInt16LE(p + 2 * i);
      return { col: { v }, end: p + 2 * parts * n };
    }
    case T.CFrame: {
      const c = cframes(d, p, n);
      return { col: c, end: c.end };
    }
    case T.OptionalCFrame: {
      need(d, p, 1);
      if (d[p] !== T.CFrame) throw new Error('unexpected layout');
      const c = cframes(d, p + 1, n);
      need(d, c.end, 1 + n);
      if (d[c.end] !== T.Bool) throw new Error('unexpected layout');
      c.present = d.subarray(c.end + 1, c.end + 1 + n);
      return { col: c, end: c.end + 1 + n };
    }
    case T.Ref:
      return { col: { v: refs(d, p, n) }, end: p + 4 * n };
    case T.NumberSequence:
    case T.ColorSequence: {
      const floats = type === T.NumberSequence ? 3 : 5;
      const v = new Array(n);
      for (let i = 0; i < n; i++) {
        need(d, p, 4);
        const keys = d.readUInt32LE(p);
        p += 4;
        need(d, p, 4 * floats * keys);
        const seq = new Float32Array(floats * keys);
        for (let k = 0; k < seq.length; k++) seq[k] = d.readFloatLE(p + 4 * k);
        p += 4 * floats * keys;
        v[i] = seq;
      }
      return { col: { v, floats }, end: p };
    }
    case T.NumberRange: {
      need(d, p, 8 * n);
      const v = new Float32Array(2 * n);
      for (let i = 0; i < 2 * n; i++) v[i] = d.readFloatLE(p + 4 * i);
      return { col: { v }, end: p + 8 * n };
    }
    case T.Rect:
      return {
        col: { x0: f32s(d, p, n), y0: f32s(d, p + 4 * n, n), x1: f32s(d, p + 8 * n, n), y1: f32s(d, p + 12 * n, n) },
        end: p + 16 * n,
      };
    case T.PhysicalProperties: {
      // A flag byte: bit 1 custom (Density, Friction, Elasticity,
      // FrictionWeight, ElasticityWeight follow); bit 2 (newer files) a sixth,
      // AcousticAbsorption, when custom. 0 or 2: the material's own.
      const v = new Array(n);
      for (let i = 0; i < n; i++) {
        need(d, p, 1);
        const flag = d[p++];
        if (flag & ~3) throw new Error(`unknown PhysicalProperties flag ${flag}`);
        if (!(flag & 1)) { v[i] = null; continue; }
        const count = flag & 2 ? 6 : 5;
        need(d, p, 4 * count);
        const values = new Float32Array(count);
        for (let k = 0; k < count; k++) values[k] = d.readFloatLE(p + 4 * k);
        p += 4 * count;
        v[i] = { flag, values };
      }
      return { col: { v }, end: p };
    }
    case T.Color3uint8:
      need(d, p, 3 * n);
      return { col: { r: d.subarray(p, p + n), g: d.subarray(p + n, p + 2 * n), b: d.subarray(p + 2 * n, p + 3 * n) }, end: p + 3 * n };
    case T.Int64:
      return { col: { v: i64s(d, p, n) }, end: p + 8 * n };
    case T.SecurityCapabilities:
      return { col: { v: u64s(d, p, n) }, end: p + 8 * n };
    case T.UniqueId: {
      // 16 bytes each, interleaved (see the XML side for the layout).
      const raw = deinterleave(d, p, n, 16);
      return { col: { raw }, end: p + 16 * n };
    }
    case T.Font: {
      const v = new Array(n);
      for (let i = 0; i < n; i++) {
        const [familyAt, familyLength] = lengthString(d, p);
        p = familyAt + familyLength;
        need(d, p, 3);
        const weight = d.readUInt16LE(p);
        const style = d[p + 2];
        p += 3;
        const [cachedAt, cachedLength] = lengthString(d, p);
        p = cachedAt + cachedLength;
        v[i] = {
          family: d.toString('latin1', familyAt, familyAt + familyLength), weight, style,
          cached: d.toString('latin1', cachedAt, cachedAt + cachedLength),
        };
      }
      return { col: { v }, end: p };
    }
    case T.Content: {
      // Source types (i32: 0 none, 1 address, 2 object), then the addresses
      // (count, strings), the objects (count, referents) and external
      // objects (count, referents; files have none).
      const kinds = i32s(d, p, n);
      p += 4 * n;
      need(d, p, 4);
      const uriCount = d.readUInt32LE(p);
      p += 4;
      const uris = [];
      for (let i = 0; i < uriCount; i++) {
        const [start, length] = lengthString(d, p);
        uris.push(d.toString('latin1', start, start + length));
        p = start + length;
      }
      need(d, p, 4);
      const objectCount = d.readUInt32LE(p);
      p += 4;
      const objects = refs(d, p, objectCount);
      p += 4 * objectCount;
      need(d, p, 4);
      const externalCount = d.readUInt32LE(p);
      p += 4;
      need(d, p, 4 * externalCount);
      p += 4 * externalCount;
      let u = 0;
      let o = 0;
      const v = new Array(n);
      for (let i = 0; i < n; i++) {
        if (kinds[i] === 1 && u < uris.length) v[i] = { uri: uris[u++] };
        else if (kinds[i] === 2 && o < objects.length) v[i] = { ref: objects[o++] };
        else v[i] = null;
      }
      return { col: { v }, end: p };
    }
    default:
      throw new Error('unknown type');
  }
}

// --- Reading a whole file ------------------------------------------------------------

// bytes (a binary file) -> the model: { meta, shared, classes, parents, notes }.
// classes[id] = { name, count, refs, service, props: [{ name, type, col }] }.
function read(bytes) {
  const head = header(bytes);
  const model = { meta: [], shared: [], classes: [], children: null, parents: null, notes: [], unknownTypes: new Map(), unreadable: [], chunkNames: [] };
  for (const chunk of chunkList(bytes)) {
    model.chunkNames.push(chunk.name);
    if (!['META', 'SSTR', 'INST', 'PROP', 'PRNT'].includes(chunk.name)) continue; // END, SIGN, newer ones
    const d = chunkData(bytes, chunk);
    if (chunk.name === 'META') {
      let p = 4;
      const count = d.readUInt32LE(0);
      for (let i = 0; i < count; i++) {
        const [keyAt, keyLength] = lengthString(d, p);
        const [valueAt, valueLength] = lengthString(d, keyAt + keyLength);
        model.meta.push([d.toString('latin1', keyAt, keyAt + keyLength), d.toString('latin1', valueAt, valueAt + valueLength)]);
        p = valueAt + valueLength;
      }
    } else if (chunk.name === 'SSTR') {
      const count = d.readUInt32LE(4);
      let p = 8;
      for (let i = 0; i < count; i++) {
        need(d, p, 16);
        const [start, length] = lengthString(d, p + 16);
        model.shared.push(d.subarray(start, start + length));
        p = start + length;
      }
    } else if (chunk.name === 'INST') {
      const classId = d.readUInt32LE(0);
      const [nameAt, nameLength] = lengthString(d, 4);
      let p = nameAt + nameLength;
      const service = d[p++] === 1;
      const count = d.readUInt32LE(p);
      p += 4;
      model.classes[classId] = { name: d.toString('latin1', nameAt, nameAt + nameLength), count, refs: refs(d, p, count), service, props: [] };
    } else if (chunk.name === 'PROP') {
      const classId = d.readUInt32LE(0);
      const [nameAt, nameLength] = lengthString(d, 4);
      const name = d.toString('latin1', nameAt, nameAt + nameLength);
      const type = d[nameAt + nameLength];
      const cls = model.classes[classId];
      if (!cls) continue;
      const where = `${cls.name}.${name}`;
      if (!TYPE_NAMES[type] || type === T.Quaternion) {
        const key = typeName(type);
        model.unknownTypes.set(key, (model.unknownTypes.get(key) || []).concat(where));
        continue;
      }
      try {
        const { col, end } = readValues(type, d, nameAt + nameLength + 1, cls.count);
        if (end !== d.length) throw new Error(`${d.length - end} bytes left over`);
        cls.props.push({ name, type, col });
      } catch (error) {
        model.unreadable.push(`${where} (${typeName(type)}: ${error.message})`);
      }
    } else if (chunk.name === 'PRNT') {
      const count = d.readUInt32LE(1);
      model.children = refs(d, 5, count);
      model.parents = refs(d, 5 + 4 * count, count);
    }
  }
  model.declaredClasses = head.classCount;
  model.declaredInstances = head.instanceCount;
  return model;
}

// --- XML text ---------------------------------------------------------------------------

// Text (one char per byte) -> XML character data. Studio's escapes, and
// &#N; for control characters (XML cannot hold them raw).
const NEEDS_ESCAPE = /[&<>\x00-\x08\x0b-\x1f]/;
function escapeText(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.replace(/[&<>\x00-\x08\x0b-\x1f]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : `&#${c.charCodeAt(0)};`));
}

function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}

function stripZeros(s) {
  if (s.indexOf('.') < 0) return s;
  let k = s.length;
  while (s.charCodeAt(k - 1) === 48) k--;
  if (s.charCodeAt(k - 1) === 46) k--;
  return s.slice(0, k);
}

// float32 as Studio writes it: C's "%.9g" (9 significant digits, which
// read back as the same float).
function f32(x) {
  if (Number.isInteger(x) && x < 1e9 && x > -1e9) return x === 0 && 1 / x < 0 ? '-0' : String(x);
  if (x !== x) return 'NAN';
  if (x === Infinity) return 'INF';
  if (x === -Infinity) return '-INF';
  const s = x.toExponential(8);
  const at = s.indexOf('e');
  const e = Number(s.slice(at + 1));
  if (e < -4 || e >= 9) return `${stripZeros(s.slice(0, at))}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  return stripZeros(x.toFixed(8 - e));
}

function f64(x) {
  if (x !== x) return 'NAN';
  if (x === Infinity) return 'INF';
  if (x === -Infinity) return '-INF';
  return x === 0 && 1 / x < 0 ? '-0' : String(x);
}

// --- Which XML type a String property is ------------------------------------------------

// The binary format has one string type; XML has string, Content,
// ProtectedString and BinaryString. The 2017 API dump knows the types of
// most properties; the hidden ones (not in it) are listed here.
const BINARY_NAMES = new Set([
  'Tags', 'AttributesSerialize', 'PhysicsData', 'MeshData', 'ChildData', 'PhysicalConfigData', 'SmoothGrid',
  'PhysicsGrid', 'MaterialColors', 'ClusterGridV3', 'CollisionGroupData', 'LODData', 'ModelMeshData',
]);
const CONTENT_NAMES = new Set([
  'AssetId', 'MeshID', 'MeshId', 'TextureID', 'TextureId', 'Texture', 'Image', 'SoundId', 'AnimationId',
  'ShirtTemplate', 'PantsTemplate', 'Graphic', 'LinkedSource', 'SkyboxBk', 'SkyboxDn', 'SkyboxFt', 'SkyboxLf',
  'SkyboxRt', 'SkyboxUp', 'SunTextureId', 'MoonTextureId', 'HoverImage', 'PressedImage', 'TopImage', 'MidImage',
  'BottomImage', 'CursorIcon', 'ColorMap', 'MetalnessMap', 'NormalMap', 'RoughnessMap', 'Video', 'BaseTextureId',
  'OverlayTextureId', 'ExplorerIcon', 'ActivatedCursorIcon', 'HoverCursorIcon',
]);
const CLASS_STRING_KINDS = { BinaryStringValue: { Value: 'BinaryString' } };

let api = null;
function apiDump() {
  if (api !== null) return api;
  api = { classes: new Map(), enums: new Set() };
  let text = '';
  try { text = fs.readFileSync(API_DUMP, 'latin1'); } catch (error) { return api; }
  for (const line of text.split('\n')) {
    let m = /^Class (\w+)(?: : (\w+))?/.exec(line);
    if (m) { api.classes.set(m[1], { parent: m[2] || null, props: new Map() }); continue; }
    m = /^\s+Property (\S+) (\w+)\.(\w+)/.exec(line);
    if (m) { const cls = api.classes.get(m[2]); if (cls) cls.props.set(m[3], m[1]); continue; }
    m = /^Enum (\w+)/.exec(line);
    if (m) api.enums.add(m[1]);
  }
  return api;
}

// The 2017 type of a property (with its class's ancestors), or null.
function apiType(className, prop) {
  const dump = apiDump();
  for (let c = className, guard = 0; c && guard < 50; guard++) {
    const cls = dump.classes.get(c);
    if (!cls) return null;
    const type = cls.props.get(prop);
    if (type) return type;
    c = cls.parent;
  }
  return null;
}

const STRING_KINDS = new Set(['string', 'Content', 'ProtectedString', 'BinaryString']);
function stringKind(className, prop, type, sample) {
  if (type === T.ProtectedString) return 'ProtectedString';
  const special = CLASS_STRING_KINDS[className] && CLASS_STRING_KINDS[className][prop];
  if (special) return special;
  const known = apiType(className, prop);
  if (known && STRING_KINDS.has(known)) return known;
  if (BINARY_NAMES.has(prop)) return 'BinaryString';
  if (CONTENT_NAMES.has(prop)) return 'Content';
  if (prop === 'Source') return 'ProtectedString';
  // Not known: binary-looking bytes stay exact as BinaryString.
  return sample && sample() ? 'BinaryString' : 'string';
}

// --- Binary -> XML ------------------------------------------------------------------------

function referentName(ref) {
  return ref >= 0 ? `RBX${ref.toString(16).toUpperCase().padStart(8, '0')}` : `RBXN${-ref}`;
}

// Writes XML text into Buffers of a few MB (one string of a whole big place
// would pass Node's string limit) and joins them at the end.
class Output {
  constructor() { this.parts = []; this.text = ''; this.total = 0; }
  write(text) {
    this.text += text;
    if (this.text.length > 4 * 1024 * 1024) this.flush();
  }
  flush() {
    if (this.text === '') return;
    const bytes = Buffer.from(this.text, 'latin1');
    this.parts.push(bytes);
    this.total += bytes.length;
    this.text = '';
  }
  finish() {
    this.flush();
    const max = require('buffer').constants.MAX_LENGTH;
    if (this.total > max) throw new Error(`This place is too big to convert (as XML it would be ${(this.total / 1073741824).toFixed(1)} GB).`);
    const out = Buffer.concat(this.parts, this.total);
    this.parts = [];
    return out;
  }
}

// One property's XML for instance i of its class: a function (i) -> text.
function formatter(cls, prop, model, notes) {
  const { col, type } = prop;
  const name = escapeAttr(prop.name);
  const tag = (xmlType, body) => `<${xmlType} name="${name}">${body}</${xmlType}>`;
  const ref = (r) => (model.refExists(r) ? referentName(r) : 'null');
  const vec3 = (x, y, z) => `<X>${f32(x)}</X><Y>${f32(y)}</Y><Z>${f32(z)}</Z>`;
  const cframe = (c, i) => {
    const r = c.rotation;
    const k = 9 * i;
    return `${vec3(c.x[i], c.y[i], c.z[i])}<R00>${f32(r[k])}</R00><R01>${f32(r[k + 1])}</R01><R02>${f32(r[k + 2])}</R02>`
      + `<R10>${f32(r[k + 3])}</R10><R11>${f32(r[k + 4])}</R11><R12>${f32(r[k + 5])}</R12>`
      + `<R20>${f32(r[k + 6])}</R20><R21>${f32(r[k + 7])}</R21><R22>${f32(r[k + 8])}</R22>`;
  };
  switch (type) {
    case T.String:
    case T.ProtectedString: {
      const { d, starts, lengths } = col;
      const kind = stringKind(cls.name, prop.name, type, () => {
        for (let i = 0; i < starts.length; i++) {
          const bytes = d.subarray(starts[i], starts[i] + lengths[i]);
          if (!isUtf8(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(bytes.toString('latin1'))) return true;
        }
        return false;
      });
      const text = (i) => d.toString('latin1', starts[i], starts[i] + lengths[i]);
      if (kind === 'BinaryString') return (i) => tag('BinaryString', d.toString('base64', starts[i], starts[i] + lengths[i]));
      if (kind === 'Content') return (i) => (lengths[i] === 0 ? tag('Content', '<null></null>') : tag('Content', `<url>${escapeText(text(i))}</url>`));
      if (kind === 'ProtectedString') {
        return (i) => {
          const source = text(i);
          // CDATA as Studio writes it; text with "]]>" in it is escaped instead.
          return source.includes(']]>') ? tag('ProtectedString', escapeText(source).replace(/\r/g, '&#13;')) : tag('ProtectedString', `<![CDATA[${source}]]>`);
        };
      }
      return (i) => tag('string', escapeText(text(i)).replace(/\r/g, '&#13;'));
    }
    case T.Bool: return (i) => tag('bool', col.v[i] ? 'true' : 'false');
    case T.Int32: return (i) => tag('int', String(col.v[i]));
    case T.Float32: return (i) => tag('float', f32(col.v[i]));
    case T.Float64: return (i) => tag('double', f64(col.v[i]));
    case T.UDim: return (i) => tag('UDim', `<S>${f32(col.s[i])}</S><O>${col.o[i]}</O>`);
    case T.UDim2: return (i) => tag('UDim2', `<XS>${f32(col.xs[i])}</XS><XO>${col.xo[i]}</XO><YS>${f32(col.ys[i])}</YS><YO>${col.yo[i]}</YO>`);
    case T.Ray: return (i) => {
      const v = col.v;
      const k = 6 * i;
      return tag('Ray', `<origin>${vec3(v[k], v[k + 1], v[k + 2])}</origin><direction>${vec3(v[k + 3], v[k + 4], v[k + 5])}</direction>`);
    };
    case T.Faces: return (i) => tag('Faces', `<faces>${col.v[i]}</faces>`);
    case T.Axes: return (i) => tag('Axes', `<axes>${col.v[i]}</axes>`);
    case T.BrickColor: return (i) => tag('int', String(col.v[i]));
    case T.Color3: return (i) => tag('Color3', `<R>${f32(col.r[i])}</R><G>${f32(col.g[i])}</G><B>${f32(col.b[i])}</B>`);
    case T.Vector2: return (i) => tag('Vector2', `<X>${f32(col.x[i])}</X><Y>${f32(col.y[i])}</Y>`);
    case T.Vector3: return (i) => tag('Vector3', vec3(col.x[i], col.y[i], col.z[i]));
    case T.Vector2int16: return (i) => tag('Vector2int16', `<X>${col.v[2 * i]}</X><Y>${col.v[2 * i + 1]}</Y>`);
    case T.Vector3int16: return (i) => tag('Vector3int16', `<X>${col.v[3 * i]}</X><Y>${col.v[3 * i + 1]}</Y><Z>${col.v[3 * i + 2]}</Z>`);
    case T.CFrame: return (i) => tag('CoordinateFrame', cframe(col, i));
    case T.OptionalCFrame: return (i) => tag('OptionalCoordinateFrame', col.present[i] ? `<CFrame>${cframe(col, i)}</CFrame>` : '');
    case T.Enum: return (i) => tag('token', String(col.v[i]));
    case T.Ref: return (i) => tag('Ref', ref(col.v[i]));
    case T.NumberSequence:
    case T.ColorSequence: return (i) => {
      let text = '';
      for (const value of col.v[i]) text += `${f32(value)} `;
      return tag(type === T.NumberSequence ? 'NumberSequence' : 'ColorSequence', text);
    };
    case T.NumberRange: return (i) => tag('NumberRange', `${f32(col.v[2 * i])} ${f32(col.v[2 * i + 1])} `);
    case T.Rect: return (i) => tag('Rect2D', `<min><X>${f32(col.x0[i])}</X><Y>${f32(col.y0[i])}</Y></min><max><X>${f32(col.x1[i])}</X><Y>${f32(col.y1[i])}</Y></max>`);
    case T.PhysicalProperties: return (i) => {
      const value = col.v[i];
      if (!value || !(value.flag & 1)) return tag('PhysicalProperties', '<CustomPhysics>false</CustomPhysics>');
      const v = value.values;
      return tag('PhysicalProperties', `<CustomPhysics>true</CustomPhysics><Density>${f32(v[0])}</Density><Friction>${f32(v[1])}</Friction>`
        + `<Elasticity>${f32(v[2])}</Elasticity><FrictionWeight>${f32(v[3])}</FrictionWeight><ElasticityWeight>${f32(v[4])}</ElasticityWeight>`
        + (value.flag & 2 ? `<AcousticAbsorption>${f32(v[5])}</AcousticAbsorption>` : ''));
    };
    case T.Color3uint8: return (i) => tag('Color3uint8', String((0xff000000 | (col.r[i] << 16) | (col.g[i] << 8) | col.b[i]) >>> 0));
    case T.Int64: return (i) => tag('int64', String(col.v[i]));
    case T.SecurityCapabilities: return (i) => tag('SecurityCapabilities', String(col.v[i]));
    case T.SharedString: return (i) => tag('SharedString', model.sharedKey(col.v[i]));
    case T.UniqueId: return (i) => {
      // Index (u32), Time (u32), Random (i64, rotated left by one bit); XML
      // writes Random, Time, Index in hex.
      const raw = col.raw;
      const stored = raw.readBigUInt64BE(16 * i + 8);
      const random = ((stored >> 1n) | ((stored & 1n) << 63n)) & 0xffffffffffffffffn;
      return tag('UniqueId', random.toString(16).padStart(16, '0') + raw.toString('hex', 16 * i + 4, 16 * i + 8) + raw.toString('hex', 16 * i, 16 * i + 4));
    };
    case T.Font: return (i) => {
      const f = col.v[i];
      return tag('Font', `<Family><url>${escapeText(f.family)}</url></Family><Weight>${f.weight}</Weight>`
        + `<Style>${f.style === 1 ? 'Italic' : 'Normal'}</Style>`
        + (f.cached ? `<CachedFaceId><url>${escapeText(f.cached)}</url></CachedFaceId>` : ''));
    };
    case T.Content: return (i) => {
      const value = col.v[i];
      if (value && value.uri !== undefined) return tag('Content', `<uri>${escapeText(value.uri)}</uri>`);
      if (value && value.ref !== undefined) return tag('Content', `<Ref>${ref(value.ref)}</Ref>`);
      return tag('Content', '<null></null>');
    };
    default:
      notes.push(`${cls.name}.${prop.name}: ${typeName(type)} values left out`);
      return null;
  }
}

// bytes (a binary .rbxl/.rbxm) -> { xml: Buffer, notes: [lines], stats }.
function toXml(bytes) {
  const model = read(bytes);
  const classes = model.classes.filter(Boolean);
  // Every instance gets a slot: classes in order, instances in class order.
  let total = 0;
  for (const cls of classes) { cls.first = total; total += cls.count; }
  const slotClass = new Int32Array(total);
  const slotRef = new Int32Array(total);
  let maxRef = -1;
  let minRef = 0;
  for (let c = 0; c < classes.length; c++) {
    const cls = classes[c];
    for (let i = 0; i < cls.count; i++) {
      slotClass[cls.first + i] = c;
      slotRef[cls.first + i] = cls.refs[i];
      if (cls.refs[i] > maxRef) maxRef = cls.refs[i];
      if (cls.refs[i] < minRef) minRef = cls.refs[i];
    }
  }
  // Referent -> slot (an array when referents are 0..about the count, as Studio writes them).
  let slotOf;
  if (minRef >= 0 && maxRef < 4 * total + 1024) {
    const table = new Int32Array(maxRef + 1).fill(-1);
    for (let s = 0; s < total; s++) if (table[slotRef[s]] === -1) table[slotRef[s]] = s;
    slotOf = (r) => (r >= 0 && r <= maxRef ? table[r] : -1);
  } else {
    const map = new Map();
    for (let s = 0; s < total; s++) if (!map.has(slotRef[s])) map.set(slotRef[s], s);
    slotOf = (r) => (map.has(r) ? map.get(r) : -1);
  }
  model.refExists = (r) => slotOf(r) !== -1;
  const sharedKeys = model.shared.map((value) => crypto.createHash('md5').update(value).digest('base64'));
  model.sharedKey = (index) => sharedKeys[index] || '';

  // The tree, from PRNT (its order is the children's order).
  const parent = new Int32Array(total).fill(-1);
  const firstChild = new Int32Array(total).fill(-1);
  const lastChild = new Int32Array(total).fill(-1);
  const next = new Int32Array(total).fill(-1);
  const linked = new Uint8Array(total);
  let firstRoot = -1;
  let lastRoot = -1;
  const link = (s, p) => {
    linked[s] = 1;
    parent[s] = p;
    if (p === -1) {
      if (lastRoot === -1) firstRoot = s; else next[lastRoot] = s;
      lastRoot = s;
    } else {
      if (lastChild[p] === -1) firstChild[p] = s; else next[lastChild[p]] = s;
      lastChild[p] = s;
    }
  };
  const children = model.children || new Int32Array(0);
  for (let k = 0; k < children.length; k++) {
    const s = slotOf(children[k]);
    if (s === -1 || linked[s]) continue;
    let p = model.parents[k] === -1 ? -1 : slotOf(model.parents[k]);
    if (p === s) p = -1;
    link(s, p);
  }
  for (let s = 0; s < total; s++) if (!linked[s]) link(s, -1);

  const notes = [];
  const formats = classes.map((cls) => cls.props.map((prop) => formatter(cls, prop, model, notes)).filter(Boolean));
  const out = new Output();
  out.write('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">');
  for (const [key, value] of model.meta) out.write(`\n\t<Meta name="${escapeAttr(key)}">${escapeText(value)}</Meta>`);
  out.write('\n\t<External>null</External>\n\t<External>nil</External>');
  const indents = [];
  const indent = (depth) => indents[depth] || (indents[depth] = `\n${'\t'.repeat(depth)}`);
  let properties = 0;
  let written = 0;
  const open = (s, depth) => {
    const cls = classes[slotClass[s]];
    const i = s - cls.first;
    const inner = indent(depth + 2);
    let text = `${indent(depth)}<Item class="${escapeAttr(cls.name)}" referent="${referentName(slotRef[s])}">${indent(depth + 1)}<Properties>`;
    for (const format of formats[slotClass[s]]) text += inner + format(i);
    text += `${indent(depth + 1)}</Properties>`;
    out.write(text);
    properties += formats[slotClass[s]].length;
    written++;
  };
  const close = (depth) => out.write(`${indent(depth)}</Item>`);
  let node = firstRoot;
  let depth = 1;
  while (node !== -1) {
    open(node, depth);
    if (firstChild[node] !== -1) {
      node = firstChild[node];
      depth++;
      continue;
    }
    close(depth);
    while (node !== -1 && next[node] === -1) {
      node = parent[node];
      if (node === -1) break;
      depth--;
      close(depth);
    }
    if (node !== -1) node = next[node];
  }
  if (model.shared.length > 0) {
    out.write('\n\t<SharedStrings>');
    model.shared.forEach((value, index) => out.write(`\n\t\t<SharedString md5="${sharedKeys[index]}">${value.toString('base64')}</SharedString>`));
    out.write('\n\t</SharedStrings>');
  }
  out.write('\n</roblox>');
  const xml = out.finish();

  for (const [type, where] of model.unknownTypes) notes.push(`values of an unknown type (${type}) left out: ${where.slice(0, 5).join(', ')}${where.length > 5 ? ', ...' : ''}`);
  if (model.unreadable.length > 0) notes.push(`values that could not be read, left out: ${model.unreadable.slice(0, 5).join(', ')}${model.unreadable.length > 5 ? ', ...' : ''}`);
  if (written !== total) notes.push(`${total - written} objects in a parent loop left out`);
  return {
    xml, notes,
    stats: { instances: written, properties, classes: classes.length, shared: model.shared.length, meta: model.meta, chunks: model.chunkNames, unknownTypes: model.unknownTypes, unreadable: model.unreadable },
  };
}

// --- XML -> model ------------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// XML character data -> text with one char per byte (UTF-8 kept as bytes).
function decodeText(text) {
  if (text.indexOf('&') < 0) return text;
  return text.replace(/&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (match, named, dec, hex) => {
    if (named) return ENTITIES[named];
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (!(code >= 0 && code <= 0x10ffff)) return match;
    return code < 128 ? String.fromCharCode(code) : Buffer.from(String.fromCodePoint(code), 'utf8').toString('latin1');
  });
}

function isSpace(c) {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function find(x, text, from) {
  const at = x.indexOf(text, from, 'latin1');
  if (at < 0) throw new Error(`the XML ends early (no ${text})`);
  return at;
}

// The tag at x[lt] === '<' -> { name, attrs, end (after '>'), empty (/>) }.
function openTag(x, lt) {
  let p = lt + 1;
  while (p < x.length && !isSpace(x[p]) && x[p] !== 0x3e && x[p] !== 0x2f) p++;
  const name = x.toString('latin1', lt + 1, p);
  const attrs = {};
  for (;;) {
    while (p < x.length && isSpace(x[p])) p++;
    if (p >= x.length) throw new Error('the XML ends early (in a tag)');
    if (x[p] === 0x3e) return { name, attrs, end: p + 1, empty: false };
    if (x[p] === 0x2f && x[p + 1] === 0x3e) return { name, attrs, end: p + 2, empty: true };
    const eq = x.indexOf(0x3d, p);
    if (eq < 0) throw new Error('the XML ends early (in a tag)');
    const key = x.toString('latin1', p, eq).trim();
    let q = eq + 1;
    while (isSpace(x[q])) q++;
    const quote = x[q];
    if (quote !== 0x22 && quote !== 0x27) throw new Error(`bad attribute in a <${name}> tag`);
    const close = x.indexOf(quote, q + 1);
    if (close < 0) throw new Error('the XML ends early (in a tag)');
    attrs[key] = decodeText(x.toString('latin1', q + 1, close));
    p = close + 1;
  }
}

// An element's content from p (after its open tag) -> { text, kids, end }:
// text with CDATA and entities resolved; kids: [[name, node], ...] or null.
function content(x, p) {
  let text = '';
  let kids = null;
  for (;;) {
    const lt = x.indexOf(0x3c, p);
    if (lt < 0) throw new Error('the XML ends early');
    if (lt > p) text += decodeText(x.toString('latin1', p, lt));
    const c = x[lt + 1];
    if (c === 0x2f) return { text, kids, end: find(x, '>', lt) + 1 };
    if (c === 0x21) {
      if (x[lt + 2] === 0x5b) { // <![CDATA[
        const close = find(x, ']]>', lt + 9);
        text += x.toString('latin1', lt + 9, close);
        p = close + 3;
      } else {
        p = find(x, '-->', lt) + 3;
      }
      continue;
    }
    const tag = openTag(x, lt);
    const node = tag.empty ? { text: '', kids: null, end: tag.end } : content(x, tag.end);
    (kids || (kids = [])).push([tag.name, node]);
    p = node.end;
  }
}

function kid(node, name) {
  if (!node.kids) return null;
  for (const [key, value] of node.kids) if (key === name) return value;
  return null;
}

function number(text) {
  const n = Number(text.trim());
  if (n === n) return n;
  const t = text.trim().toUpperCase();
  if (t === 'INF' || t === '+INF' || t === 'INFINITY' || t === '1.#INF') return Infinity;
  if (t === '-INF' || t === '-INFINITY' || t === '-1.#INF') return -Infinity;
  if (t === 'NAN' || t === '-NAN' || t === 'NAN(IND)') return NaN;
  const loose = parseFloat(text);
  return loose === loose ? loose : 0;
}

const kidNumber = (node, name, fallback = 0) => {
  const value = kid(node, name);
  return value ? number(value.text) : fallback;
};

// Value types of 2017: what XML types become (others are left out).
const XML_TYPES = {
  string: T.String, ProtectedString: T.String, Content: T.String, BinaryString: T.String, SharedString: T.String,
  bool: T.Bool, int: T.Int32, float: T.Float32, double: T.Float64, token: T.Enum, BrickColor: T.BrickColor,
  UDim: T.UDim, UDim2: T.UDim2, Ray: T.Ray, Faces: T.Faces, Axes: T.Axes, Color3: T.Color3, Vector2: T.Vector2,
  Vector3: T.Vector3, Vector3int16: T.Vector3int16, CoordinateFrame: T.CFrame, Ref: T.Ref,
  NumberSequence: T.NumberSequence, ColorSequence: T.ColorSequence, NumberRange: T.NumberRange, Rect2D: T.Rect,
  PhysicalProperties: T.PhysicalProperties, Color3uint8: T.Color3uint8,
};
// 2017 API dump types -> binary types.
const API_TYPES = {
  string: T.String, Content: T.String, ProtectedString: T.String, BinaryString: T.String, bool: T.Bool, int: T.Int32,
  float: T.Float32, double: T.Float64, BrickColor: T.BrickColor, UDim: T.UDim, UDim2: T.UDim2, Ray: T.Ray, Faces: T.Faces,
  Axes: T.Axes, Color3: T.Color3, Vector2: T.Vector2, Vector3: T.Vector3, Vector3int16: T.Vector3int16,
  CoordinateFrame: T.CFrame, Object: T.Ref, NumberSequence: T.NumberSequence, ColorSequence: T.ColorSequence,
  NumberRange: T.NumberRange, Rect2D: T.Rect, PhysicalProperties: T.PhysicalProperties,
};
const SCALARS = new Set([T.Int32, T.Float32, T.Float64, T.Enum, T.BrickColor]);

// The binary type a property gets: the XML's, or the 2017 engine's own when
// they differ but convert (int / token / float / double...); null leaves it out.
function binaryType(className, prop, xmlType) {
  const fromXml = XML_TYPES[xmlType];
  if (fromXml === undefined) return null;
  const known = apiType(className, prop);
  if (!known) return fromXml;
  const engine = API_TYPES[known] !== undefined ? API_TYPES[known] : apiDump().enums.has(known) ? T.Enum : null;
  if (engine === null || engine === fromXml) return fromXml;
  if (SCALARS.has(engine) && SCALARS.has(fromXml)) return engine;
  return null;
}

// Per binary type: values per instance (stride), and the typed array.
const LAYOUT = {
  [T.Bool]: [1, Uint8Array], [T.Int32]: [1, Float64Array], [T.Float32]: [1, Float32Array], [T.Float64]: [1, Float64Array],
  [T.UDim]: [2, Float64Array], [T.UDim2]: [4, Float64Array], [T.Ray]: [6, Float32Array], [T.Faces]: [1, Uint8Array],
  [T.Axes]: [1, Uint8Array], [T.BrickColor]: [1, Float64Array], [T.Color3]: [3, Float32Array], [T.Vector2]: [2, Float32Array],
  [T.Vector3]: [3, Float32Array], [T.Vector3int16]: [3, Int16Array], [T.CFrame]: [12, Float32Array], [T.Enum]: [1, Float64Array],
  [T.Ref]: [1, Int32Array], [T.NumberRange]: [2, Float32Array], [T.Rect]: [4, Float32Array], [T.Color3uint8]: [3, Uint8Array],
  [T.PhysicalProperties]: [6, Float32Array],
};
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const CFRAME_KEYS = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];

class Column {
  constructor(type, name) {
    this.type = type;
    this.name = name;
    this.cap = 0;
    this.present = new Uint8Array(0);
    const layout = LAYOUT[type];
    if (layout) { this.stride = layout[0]; this.values = new layout[1](0); } else { this.stride = 0; this.values = []; }
  }

  slot(i) {
    if (i >= this.cap) {
      let cap = Math.max(16, this.cap * 2);
      while (cap <= i) cap *= 2;
      const present = new Uint8Array(cap);
      present.set(this.present);
      this.present = present;
      if (this.stride) {
        const values = new this.values.constructor(cap * this.stride);
        values.set(this.values);
        this.values = values;
      }
      this.cap = cap;
    }
    this.present[i] = 1;
    return i * this.stride;
  }

  // One XML value (node from content()) for instance i of the class.
  // -> false when it does not fit this column.
  set(i, xmlType, node, doc) {
    const type = this.type;
    const text = node.text;
    if (type === T.String) {
      let value;
      if (xmlType === 'BinaryString') value = Buffer.from(text.replace(/\s+/g, ''), 'base64');
      else if (xmlType === 'Content') {
        const url = kid(node, 'url') || kid(node, 'uri');
        value = url ? url.text : '';
      } else if (xmlType === 'SharedString') value = { shared: text.trim() };
      else if (XML_TYPES[xmlType] === T.String) value = text;
      else return false;
      this.slot(i);
      this.values[i] = value;
      return true;
    }
    if (type === T.NumberSequence || type === T.ColorSequence) {
      if (XML_TYPES[xmlType] !== type) return false;
      const numbers = text.trim().split(/\s+/).filter(Boolean).map(number);
      const per = type === T.NumberSequence ? 3 : 5;
      this.slot(i);
      this.values[i] = Float32Array.from(numbers.slice(0, numbers.length - (numbers.length % per)));
      return true;
    }
    const fromXml = XML_TYPES[xmlType];
    if (fromXml !== type && !(SCALARS.has(type) && SCALARS.has(fromXml))) return false;
    const k = this.slot(i);
    const v = this.values;
    switch (type) {
      case T.Bool: v[k] = text.trim().toLowerCase() === 'true' ? 1 : 0; break;
      case T.Int32: case T.Float32: case T.Float64: case T.Enum: case T.BrickColor: {
        let n = number(text);
        if (type === T.Int32) n = Math.trunc(n) | 0;
        else if (type === T.Enum || type === T.BrickColor) n = Math.trunc(n) >>> 0;
        v[k] = n;
        break;
      }
      case T.UDim: v[k] = kidNumber(node, 'S'); v[k + 1] = kidNumber(node, 'O') | 0; break;
      case T.UDim2:
        v[k] = kidNumber(node, 'XS'); v[k + 1] = kidNumber(node, 'XO') | 0;
        v[k + 2] = kidNumber(node, 'YS'); v[k + 3] = kidNumber(node, 'YO') | 0;
        break;
      case T.Ray: {
        const origin = kid(node, 'origin') || { kids: null };
        const direction = kid(node, 'direction') || { kids: null };
        v[k] = kidNumber(origin, 'X'); v[k + 1] = kidNumber(origin, 'Y'); v[k + 2] = kidNumber(origin, 'Z');
        v[k + 3] = kidNumber(direction, 'X'); v[k + 4] = kidNumber(direction, 'Y'); v[k + 5] = kidNumber(direction, 'Z');
        break;
      }
      case T.Faces: v[k] = kidNumber(node, 'faces', number(text)) & 63; break;
      case T.Axes: v[k] = kidNumber(node, 'axes', number(text)) & 7; break;
      case T.Color3:
        if (node.kids) {
          v[k] = kidNumber(node, 'R'); v[k + 1] = kidNumber(node, 'G'); v[k + 2] = kidNumber(node, 'B');
        } else { // older files: one packed number
          const packed = number(text) >>> 0;
          v[k] = ((packed >>> 16) & 255) / 255; v[k + 1] = ((packed >>> 8) & 255) / 255; v[k + 2] = (packed & 255) / 255;
        }
        break;
      case T.Vector2: v[k] = kidNumber(node, 'X'); v[k + 1] = kidNumber(node, 'Y'); break;
      case T.Vector3: case T.Vector3int16:
        v[k] = kidNumber(node, 'X'); v[k + 1] = kidNumber(node, 'Y'); v[k + 2] = kidNumber(node, 'Z');
        break;
      case T.CFrame:
        for (let c = 0; c < 12; c++) v[k + c] = kidNumber(node, CFRAME_KEYS[c], c < 3 ? 0 : IDENTITY[c - 3]);
        break;
      case T.Ref: v[k] = doc.refId(text.trim()); break;
      case T.NumberRange: {
        const numbers = text.trim().split(/\s+/).map(number);
        v[k] = numbers[0] || 0; v[k + 1] = numbers.length > 1 ? numbers[1] : v[k];
        break;
      }
      case T.Rect: {
        const min = kid(node, 'min') || { kids: null };
        const max = kid(node, 'max') || { kids: null };
        v[k] = kidNumber(min, 'X'); v[k + 1] = kidNumber(min, 'Y'); v[k + 2] = kidNumber(max, 'X'); v[k + 3] = kidNumber(max, 'Y');
        break;
      }
      case T.PhysicalProperties: {
        const custom = kid(node, 'CustomPhysics');
        v[k] = custom && custom.text.trim().toLowerCase() === 'true' ? 1 : 0;
        if (v[k]) {
          v[k + 1] = kidNumber(node, 'Density'); v[k + 2] = kidNumber(node, 'Friction'); v[k + 3] = kidNumber(node, 'Elasticity');
          v[k + 4] = kidNumber(node, 'FrictionWeight'); v[k + 5] = kidNumber(node, 'ElasticityWeight');
        }
        break;
      }
      case T.Color3uint8: {
        const packed = number(text) >>> 0;
        v[k] = (packed >>> 16) & 255; v[k + 1] = (packed >>> 8) & 255; v[k + 2] = packed & 255;
        break;
      }
      default: return false;
    }
    return true;
  }
}

// A parsed XML file: instances in document order (which are the binary
// referents, as 2017 Studio numbered them: depth first).
class Doc {
  constructor() {
    this.meta = [];
    this.shared = new Map();
    this.classes = new Map(); // name -> { name, members: [instance], props: Map name -> Column|null }
    this.classOf = [];
    this.local = [];
    this.parent = [];
    this.closeOrder = [];
    this.refIds = new Map();
    this.refTargets = [];
    this.dropped = new Map();
    this.conflicts = 0;
  }

  refId(name) {
    if (name === '' || name === 'null' || name === 'nil') return -1;
    let id = this.refIds.get(name);
    if (id === undefined) {
      id = this.refTargets.length;
      this.refIds.set(name, id);
      this.refTargets.push(-1);
    }
    return id;
  }

  addInstance(className, referent, parent) {
    let cls = this.classes.get(className);
    if (!cls) {
      cls = { name: className, members: [], props: new Map() };
      this.classes.set(className, cls);
    }
    const index = this.classOf.length;
    this.classOf.push(cls);
    this.local.push(cls.members.length);
    cls.members.push(index);
    this.parent.push(parent);
    if (referent) {
      const id = this.refId(referent);
      if (id >= 0 && this.refTargets[id] === -1) this.refTargets[id] = index;
    }
    return index;
  }

  setProperty(index, xmlType, prop, node) {
    const cls = this.classOf[index];
    let column = cls.props.get(prop);
    if (column === undefined) {
      const type = binaryType(cls.name, prop, xmlType);
      column = type === null ? null : new Column(type, prop);
      cls.props.set(prop, column);
    }
    if (column === null || !column.set(this.local[index], xmlType, node, this)) {
      if (column !== null) this.conflicts++;
      const key = `${xmlType}`;
      this.dropped.set(key, (this.dropped.get(key) || 0) + 1);
    }
  }
}

function parseXml(x) {
  if (!/<roblox[\s>]/.test(x.toString('latin1', 0, Math.min(x.length, 512)))) {
    throw new Error('This is not a Roblox XML place or model file (.rbxlx / .rbxmx).');
  }
  const doc = new Doc();
  const open = [];
  let p = 0;
  for (;;) {
    const lt = x.indexOf(0x3c, p);
    if (lt < 0) break;
    const c = x[lt + 1];
    if (c === 0x3f) { p = find(x, '?>', lt) + 2; continue; }
    if (c === 0x21) {
      p = x[lt + 2] === 0x5b ? find(x, ']]>', lt) + 3 : x[lt + 2] === 0x2d ? find(x, '-->', lt) + 3 : find(x, '>', lt) + 1;
      continue;
    }
    if (c === 0x2f) {
      if (x.toString('latin1', lt + 2, lt + 7) === 'Item>') {
        const index = open.pop();
        if (index !== undefined) doc.closeOrder.push(index);
      }
      p = find(x, '>', lt) + 1;
      continue;
    }
    const tag = openTag(x, lt);
    p = tag.end;
    if (tag.name === 'Item') {
      const index = doc.addInstance(tag.attrs.class || 'Folder', tag.attrs.referent || '', open.length > 0 ? open[open.length - 1] : -1);
      if (tag.empty) doc.closeOrder.push(index); else open.push(index);
    } else if (tag.name === 'Properties' && !tag.empty) {
      const index = open.length > 0 ? open[open.length - 1] : -1;
      for (;;) {
        const at = x.indexOf(0x3c, p);
        if (at < 0) throw new Error('the XML ends early (in <Properties>)');
        if (x[at + 1] === 0x2f) { p = find(x, '>', at) + 1; break; }
        if (x[at + 1] === 0x21) { p = find(x, '-->', at) + 3; continue; }
        const prop = openTag(x, at);
        const node = prop.empty ? { text: '', kids: null, end: prop.end } : content(x, prop.end);
        p = node.end;
        if (index >= 0 && prop.attrs.name !== undefined) doc.setProperty(index, prop.name, prop.attrs.name, node);
      }
    } else if ((tag.name === 'Meta' || tag.name === 'SharedString') && !tag.empty) {
      const node = content(x, tag.end);
      p = node.end;
      if (tag.name === 'Meta') doc.meta.push([tag.attrs.name || '', node.text]);
      else if (tag.attrs.md5 !== undefined) doc.shared.set(tag.attrs.md5, Buffer.from(node.text.replace(/\s+/g, ''), 'base64'));
    } else if (tag.name === 'External' && !tag.empty) {
      p = content(x, tag.end).end;
    }
  }
  while (open.length > 0) doc.closeOrder.push(open.pop());
  return doc;
}

// --- Model -> binary (as 2017 Studio wrote it) --------------------------------------------

class Writer {
  constructor() { this.parts = []; this.length = 0; this.buf = Buffer.allocUnsafe(1 << 16); this.at = 0; }
  room(n) {
    if (this.at + n <= this.buf.length) return;
    this.parts.push(this.buf.subarray(0, this.at));
    this.length += this.at;
    this.buf = Buffer.allocUnsafe(Math.max(1 << 16, n, this.buf.length * 2 > 1 << 24 ? 1 << 24 : this.buf.length * 2));
    this.at = 0;
  }
  u8(v) { this.room(1); this.buf[this.at++] = v; }
  u32(v) { this.room(4); this.buf.writeUInt32LE(v >>> 0, this.at); this.at += 4; }
  f32le(v) { this.room(4); this.buf.writeFloatLE(v, this.at); this.at += 4; }
  f64le(v) { this.room(8); this.buf.writeDoubleLE(v, this.at); this.at += 8; }
  i16le(v) { this.room(2); this.buf.writeInt16LE(v, this.at); this.at += 2; }
  bytes(b) { this.room(b.length); b.copy(this.buf, this.at); this.at += b.length; }
  string(s) {
    if (Buffer.isBuffer(s)) { this.u32(s.length); this.bytes(s); return; }
    this.u32(s.length);
    this.room(s.length);
    this.at += this.buf.write(s, this.at, 'latin1');
  }
  // n big-endian u32s (from get(i)), interleaved.
  interleaved(n, get) {
    this.room(4 * n);
    const b = this.buf;
    const o = this.at;
    for (let i = 0; i < n; i++) {
      const u = get(i) >>> 0;
      b[o + i] = u >>> 24; b[o + n + i] = (u >>> 16) & 255; b[o + 2 * n + i] = (u >>> 8) & 255; b[o + 3 * n + i] = u & 255;
    }
    this.at += 4 * n;
  }
  ints(n, get) { this.interleaved(n, (i) => { const v = get(i) | 0; return (v << 1) ^ (v >> 31); }); }
  floats(n, get) {
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    this.interleaved(n, (i) => { f[0] = get(i); return (u[0] << 1) | (u[0] >>> 31); });
  }
  refs(n, get) {
    let last = 0;
    this.ints(n, (i) => { const v = get(i); const delta = v - last; last = v; return delta; });
  }
  finish() {
    this.parts.push(this.buf.subarray(0, this.at));
    this.length += this.at;
    return this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length);
  }
}

function rotationId(m) {
  for (let k = 0; k < 9; k++) if (m[k] !== 0 && m[k] !== 1 && m[k] !== -1) return 0;
  for (const [id, r] of ROTATIONS) {
    let same = true;
    for (let k = 0; k < 9; k++) if (m[k] !== r[k] || (m[k] === 0 && 1 / m[k] < 0)) { same = false; break; }
    if (same) return id;
  }
  return 0;
}

// One PROP chunk's values: column `col` for the class's members (n), with
// `fill` for instances the XML gave no value.
function writeValues(w, col, n, doc, notes) {
  const v = col.values;
  const s = col.stride;
  const has = (i) => i < col.cap && col.present[i] === 1;
  const num = (i, k, fallback) => (has(i) ? v[i * s + k] : fallback);
  switch (col.type) {
    case T.String:
      for (let i = 0; i < n; i++) {
        let value = has(i) ? v[i] : '';
        if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
          value = doc.shared.get(value.shared) || '';
          notes.inlined++;
        }
        w.string(value);
      }
      return;
    case T.Bool: case T.Faces: case T.Axes:
      for (let i = 0; i < n; i++) w.u8(num(i, 0, 0));
      return;
    case T.Int32: return w.ints(n, (i) => num(i, 0, 0));
    case T.Float32: return w.floats(n, (i) => num(i, 0, 0));
    case T.Float64: for (let i = 0; i < n; i++) w.f64le(num(i, 0, 0)); return;
    case T.Enum: return w.interleaved(n, (i) => num(i, 0, 0));
    case T.BrickColor: return w.interleaved(n, (i) => num(i, 0, 194));
    case T.UDim:
      w.floats(n, (i) => num(i, 0, 0));
      w.ints(n, (i) => num(i, 1, 0));
      return;
    case T.UDim2:
      w.floats(n, (i) => num(i, 0, 0));
      w.floats(n, (i) => num(i, 2, 0));
      w.ints(n, (i) => num(i, 1, 0));
      w.ints(n, (i) => num(i, 3, 0));
      return;
    case T.Ray:
      for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) w.f32le(num(i, k, 0));
      return;
    case T.Color3: case T.Vector2: case T.Vector3:
      for (let k = 0; k < s; k++) w.floats(n, (i) => num(i, k, 0));
      return;
    case T.Vector3int16:
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) w.i16le(num(i, k, 0));
      return;
    case T.CFrame: {
      const m = new Float32Array(9);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 9; k++) m[k] = num(i, 3 + k, IDENTITY[k]);
        const id = rotationId(m);
        w.u8(id);
        if (id === 0) for (let k = 0; k < 9; k++) w.f32le(m[k]);
      }
      for (let k = 0; k < 3; k++) w.floats(n, (i) => num(i, k, 0));
      return;
    }
    case T.Ref: return w.refs(n, (i) => {
      if (!has(i) || v[i] < 0) return -1;
      return doc.refTargets[v[i]];
    });
    case T.NumberSequence: case T.ColorSequence: {
      const per = col.type === T.NumberSequence ? 3 : 5;
      const fallback = per === 3 ? Float32Array.from([0, 0, 0, 1, 0, 0]) : Float32Array.from([0, 1, 1, 1, 0, 1, 1, 1, 1, 0]);
      for (let i = 0; i < n; i++) {
        const seq = has(i) && v[i].length >= 2 * per ? v[i] : fallback;
        w.u32(seq.length / per);
        for (const value of seq) w.f32le(value);
      }
      return;
    }
    case T.NumberRange:
      for (let i = 0; i < n; i++) { w.f32le(num(i, 0, 0)); w.f32le(num(i, 1, 0)); }
      return;
    case T.Rect:
      for (let k = 0; k < 4; k++) w.floats(n, (i) => num(i, k, 0));
      return;
    case T.PhysicalProperties:
      for (let i = 0; i < n; i++) {
        const custom = num(i, 0, 0) ? 1 : 0;
        w.u8(custom);
        if (custom) for (let k = 1; k <= 5; k++) w.f32le(v[i * s + k]);
      }
      return;
    case T.Color3uint8: {
      const fallback = [163, 162, 165];
      for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) w.u8(num(i, k, fallback[k]));
      return;
    }
    default:
      throw new Error(`cannot write ${typeName(col.type)}`);
  }
}

function chunk(out, name, data, compress) {
  const head = Buffer.alloc(16);
  head.write(name, 0, 'latin1');
  if (compress) {
    const packed = lz4Compress(data);
    head.writeUInt32LE(packed.length, 4);
    head.writeUInt32LE(data.length, 8);
    out.push(head, packed);
  } else {
    head.writeUInt32LE(0, 4);
    head.writeUInt32LE(data.length, 8);
    out.push(head, data);
  }
}

// bytes (an XML .rbxlx/.rbxmx) -> { bytes: Buffer (binary, 2017 format), notes, stats }.
function fromXml(bytes) {
  const doc = parseXml(bytes);
  const total = doc.classOf.length;
  const classes = [...doc.classes.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const isPlace = classes.some((cls) => cls.name === 'Workspace' && cls.members.some((index) => doc.parent[index] === -1));
  const notes = { inlined: 0, filled: 0 };
  const filledProps = new Map();
  const out = [];
  const head = Buffer.alloc(32);
  head.write(MAGIC, 0, 'latin1');
  SIGNATURE.copy(head, 8);
  head.writeUInt16LE(0, 14);
  head.writeInt32LE(classes.length, 16);
  head.writeInt32LE(total, 20);
  out.push(head);
  let properties = 0;
  classes.forEach((cls, id) => {
    const n = cls.members.length;
    // Services: in a place, the classes found only at the top (as 2017
    // Studio marked them). The flag has the engine use its own Workspace,
    // Lighting... instead of making new ones.
    const service = isPlace && cls.members.every((index) => doc.parent[index] === -1);
    const w = new Writer();
    w.u32(id);
    w.string(cls.name);
    w.u8(service ? 1 : 0);
    w.u32(n);
    w.refs(n, (i) => cls.members[i]);
    if (service) for (let i = 0; i < n; i++) w.u8(1);
    chunk(out, 'INST', w.finish(), true);
  });
  classes.forEach((cls, id) => {
    const n = cls.members.length;
    const names = [...cls.props.keys()].filter((name) => cls.props.get(name) !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const col = cls.props.get(name);
      let present = 0;
      for (let i = 0; i < Math.min(n, col.cap); i++) present += col.present[i];
      notes.filled += n - present;
      if (present < n) filledProps.set(`${cls.name}.${name}`, n - present);
      properties += present;
      const w = new Writer();
      w.u32(id);
      w.string(name);
      w.u8(col.type);
      writeValues(w, col, n, doc, notes);
      chunk(out, 'PROP', w.finish(), true);
    }
  });
  // PRNT in the order 2017 Studio wrote it: each object after its children.
  const w = new Writer();
  w.u8(0);
  w.u32(total);
  w.refs(total, (k) => doc.closeOrder[k]);
  w.refs(total, (k) => doc.parent[doc.closeOrder[k]]);
  chunk(out, 'PRNT', w.finish(), true);
  chunk(out, 'END', Buffer.from('</roblox>', 'latin1'), false);

  const lines = [];
  const left = [...doc.dropped].map(([type, n]) => `${n} ${type}`);
  if (left.length > 0) lines.push(`values of types the 2017 engine cannot read left out: ${left.join(', ')}`);
  if (notes.filled > 0) lines.push(`${notes.filled} values the XML left out written as defaults`);
  if (notes.inlined > 0) lines.push(`${notes.inlined} shared strings written in place`);
  return {
    bytes: Buffer.concat(out),
    notes: lines,
    stats: { instances: total, classes: classes.length, properties, dropped: doc.dropped, filled: notes.filled, filledProps, meta: doc.meta },
  };
}

// --- For the upload paths ---------------------------------------------------------------

// Any place file -> { xml, notes }: XML as it is, binary read into XML.
function placeXml(bytes) {
  if (!isBinary(bytes)) return { xml: bytes, notes: [] };
  const result = toXml(bytes);
  return { xml: result.xml, notes: ['Read from a binary .rbxl', ...result.notes.map((note) => `  - ${note}`)] };
}

// The converter's XML -> { bytes, notes } to store: binary, checked by
// reading it back; the XML itself when that fails. (What the writer leaves
// out, the converter has already removed and noted.)
function placeToStore(xml) {
  let result;
  try {
    result = fromXml(xml);
    const check = read(result.bytes);
    let count = 0;
    for (const cls of check.classes) if (cls) count += cls.count;
    if (count !== result.stats.instances || check.unreadable.length > 0) throw new Error('it did not read back the same');
  } catch (error) {
    return { bytes: xml, notes: [`Saved as XML (could not write binary: ${error.message})`] };
  }
  return { bytes: result.bytes, notes: [] };
}

module.exports = { isBinary, read, toXml, fromXml, parseXml, placeXml, placeToStore, lz4Compress, lz4Decompress, ROTATIONS, T, typeName };
