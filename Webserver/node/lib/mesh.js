'use strict';

// Mesh conversion for the 2017 client, which reads mesh versions 1.00, 1.01
// and 2.00 only. Port of Webserver/lib/legacy-assets.php (legacy_mesh_to_v2)
// and Webserver/lib/legacy-draco.php; both produce identical bytes.
//
// 2.00 (40-byte vertices), 3.0x, 4.0x, 5.00, 6.00 and 7.00 (Draco) become a
// plain 2.00 mesh: highest-detail LOD, 36-byte vertices, no skinning.
// Draco support covers the sequential encoding Roblox uses; edgebreaker,
// octahedral normals and metadata are rejected.

const zlib = require('zlib');
const { assetLog } = require('./core');

class DracoError extends Error {}

let lastMeshError = '';
function meshError() {
  return lastMeshError;
}

// --- Draco -----------------------------------------------------------------

class Reader {
  constructor(buf, start, end) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  need(count) {
    if (count < 0 || this.pos + count > this.end) {
      throw new DracoError(`unexpected end of Draco data at byte ${this.pos}`);
    }
  }

  u8() { this.need(1); return this.buf[this.pos++]; }
  i8() { const v = this.u8(); return v >= 128 ? v - 256 : v; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }

  u32() {
    const v = this.i32();
    if (v < 0) throw new DracoError('32-bit count out of range');
    return v;
  }

  varint() {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        if (value > 2147483647) throw new DracoError('varint out of range');
        return value;
      }
      multiplier *= 128;
    }
    throw new DracoError('varint too long');
  }

  skip(count) {
    this.need(count);
    this.pos += count;
  }
}

// rANS symbol decoder (Draco's RAnsSymbolDecoder + RAnsDecoder).
class Rans {
  static precisionForBitLength(bitLength) {
    return Math.max(12, Math.min(20, Math.floor((3 * bitLength) / 2)));
  }

  constructor(reader, precisionBits) {
    const precision = 1 << precisionBits;
    this.precision = precision;
    this.mask = precision - 1;
    this.base = precision * 4;

    const count = reader.varint();
    if (Math.floor(count / 64) > reader.end - reader.pos) throw new DracoError('rANS symbol table too large');
    this.count = count;
    const probabilities = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const first = reader.u8();
      const token = first & 3;
      if (token === 3) {
        const run = first >> 2;
        if (i + run >= count) throw new DracoError('rANS zero run past the table');
        for (let j = 0; j <= run; j++) probabilities[i + j] = 0;
        i += run;
      } else {
        let probability = first >> 2;
        for (let b = 0; b < token; b++) probability |= reader.u8() << (8 * (b + 1) - 2);
        probabilities[i] = probability;
      }
    }
    const cumulative = new Uint32Array(count);
    let total = 0;
    for (let i = 0; i < count; i++) {
      cumulative[i] = total;
      total += probabilities[i];
      if (total > precision) throw new DracoError('rANS probabilities exceed the precision');
    }
    if (count > 0 && total !== precision) throw new DracoError('rANS probabilities do not sum to the precision');
    this.probabilities = probabilities;
    this.cumulative = cumulative;

    const bytes = reader.varint();
    reader.need(bytes);
    this.buf = reader.buf;
    this.start = reader.pos;
    reader.pos += bytes;
    if (bytes < 1) {
      if (count > 0) throw new DracoError('empty rANS stream');
      this.offset = 0;
      this.state = this.base;
      return;
    }

    const last = this.buf[this.start + bytes - 1];
    const kind = last >> 6;
    if (kind === 0) {
      this.offset = bytes - 1;
      this.state = last & 0x3f;
    } else if (kind === 1) {
      if (bytes < 2) throw new DracoError('bad rANS header');
      this.offset = bytes - 2;
      this.state = this.buf.readUInt16LE(this.start + bytes - 2) & 0x3fff;
    } else if (kind === 2) {
      if (bytes < 3) throw new DracoError('bad rANS header');
      this.offset = bytes - 3;
      this.state = this.buf.readUIntLE(this.start + bytes - 3, 3) & 0x3fffff;
    } else {
      if (bytes < 4) throw new DracoError('bad rANS header');
      this.offset = bytes - 4;
      this.state = this.buf.readUInt32LE(this.start + bytes - 4) & 0x3fffffff;
    }
    this.state += this.base;
    if (this.state >= this.base * 256) throw new DracoError('bad rANS initial state');
  }

  next() {
    while (this.state < this.base && this.offset > 0) {
      this.state = this.state * 256 + this.buf[this.start + (--this.offset)];
    }
    const quotient = Math.floor(this.state / this.precision);
    const remainder = this.state & this.mask;
    // Last symbol whose cumulative start is <= remainder (zero-probability
    // symbols share their successor's start, so they are never chosen).
    let low = 0;
    let high = this.count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.cumulative[middle] <= remainder) low = middle;
      else high = middle - 1;
    }
    this.state = quotient * this.probabilities[low] + remainder - this.cumulative[low];
    return low;
  }
}

// Draco DecodeSymbols(): $count unsigned symbols, or null when not kept.
function decodeSymbols(reader, count, components, keep) {
  if (count === 0) return keep ? new Uint32Array(0) : null;
  const scheme = reader.u8();
  if (scheme === 0) {
    // Tagged: rANS-coded bit lengths, then raw bits (least significant first).
    const tags = new Rans(reader, 12);
    if (tags.count === 0) throw new DracoError('tagged symbols without tags');
    const bitStart = reader.pos;
    const available = (reader.end - bitStart) * 8;
    const buf = reader.buf;
    const values = keep ? new Uint32Array(Math.ceil(count / components) * components) : null;
    let written = 0;
    let bit = 0;
    for (let i = 0; i < count; i += components) {
      const length = tags.next();
      if (length > 30) throw new DracoError('tagged value wider than 30 bits');
      for (let j = 0; j < components; j++) {
        if (!keep) {
          bit += length;
          continue;
        }
        let value = 0;
        for (let k = 0; k < length; k++) {
          if (bit < available) value |= ((buf[bitStart + (bit >> 3)] >> (bit & 7)) & 1) << k;
          bit++;
        }
        values[written++] = value;
      }
    }
    reader.pos = bitStart + Math.floor((bit + 7) / 8);
    if (reader.pos > reader.end) throw new DracoError('tagged values run past the data');
    return values ? values.subarray(0, count) : null;
  }
  if (scheme === 1) {
    const maxBitLength = reader.u8();
    if (maxBitLength < 1 || maxBitLength > 18) throw new DracoError(`bad raw symbol bit length ${maxBitLength}`);
    const decoder = new Rans(reader, Rans.precisionForBitLength(maxBitLength));
    if (decoder.count === 0) throw new DracoError('raw symbols without a table');
    if (!keep) return null;
    const values = new Uint32Array(count);
    for (let i = 0; i < count; i++) values[i] = decoder.next();
    return values;
  }
  throw new DracoError(`unknown symbol coding scheme ${scheme}`);
}

// SequentialIntegerAttributeDecoder::DecodeValues(): signed, un-predicted
// values (as plain numbers), or null when not kept.
function decodeIntegers(reader, count, components, keep) {
  const method = reader.i8();
  let wrap = false;
  if (method !== -2) {
    if (method < -1 || method > 6) throw new DracoError(`bad prediction method ${method}`);
    const transform = reader.i8();
    if (transform !== 1) throw new DracoError(`unsupported prediction transform ${transform}`);
    // The sequential decoder has no corner table: every method is delta.
    wrap = true;
  }

  let symbols = null;
  const compressed = reader.u8();
  if (compressed > 0) {
    symbols = decodeSymbols(reader, count, components, keep);
  } else {
    const width = reader.u8();
    if (width < 1 || width > 4) throw new DracoError(`bad integer width ${width}`);
    if (!keep) {
      reader.skip(width * count);
    } else {
      reader.need(width * count);
      symbols = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        const value = reader.buf.readUIntLE(reader.pos + i * width, width);
        if (value > 2147483647) throw new DracoError('integer symbol out of range');
        symbols[i] = value;
      }
      reader.pos += width * count;
    }
  }

  let values = null;
  if (symbols !== null) {
    values = new Float64Array(symbols.length);
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      values[i] = (symbol & 1) ? -(symbol >>> 1) - 1 : (symbol >>> 1);
    }
  }

  if (wrap) {
    const min = reader.i32();
    const max = reader.i32();
    if (min > max || max - min >= 2147483647) throw new DracoError('bad wrap bounds');
    if (values !== null) {
      const span = max - min + 1;
      const previous = new Array(components).fill(0);
      for (let i = 0; i < count; i += components) {
        for (let c = 0; c < components; c++) {
          let predicted = previous[c];
          if (predicted > max) predicted = max;
          else if (predicted < min) predicted = min;
          let value = predicted + values[i + c];
          if (value > max) value -= span;
          else if (value < min) value += span;
          values[i + c] = value;
          previous[c] = value;
        }
      }
    }
  }
  return values;
}

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 8, 8: 8, 9: 4, 10: 8, 11: 1 };

function dracoDecode(buf, start, length, keepAll) {
  const reader = new Reader(buf, start, start + length);
  reader.need(11);
  if (buf.toString('latin1', start, start + 5) !== 'DRACO') throw new DracoError('missing DRACO header');
  reader.pos += 5;
  const major = reader.u8();
  const minor = reader.u8();
  const encoderType = reader.u8();
  const method = reader.u8();
  const flags = reader.u16();
  if (major !== 2 || minor > 2) throw new DracoError(`unsupported Draco version ${major}.${minor}`);
  if (encoderType !== 1) throw new DracoError('not a triangle mesh');
  if (method !== 0) throw new DracoError('edgebreaker meshes are not supported');
  if (flags & 0x8000) throw new DracoError('Draco metadata is not supported');
  const v22 = minor >= 2;

  // Connectivity (MeshSequentialDecoder::DecodeConnectivity)
  const faceCount = v22 ? reader.varint() : reader.u32();
  const pointCount = v22 ? reader.varint() : reader.u32();
  if (faceCount <= 0 || pointCount <= 0 || faceCount > 8000000 || pointCount > 4000000) {
    throw new DracoError('implausible mesh size');
  }
  const indexCount = faceCount * 3;
  let faces;
  const connectivity = reader.u8();
  if (connectivity === 0) {
    const deltas = decodeSymbols(reader, indexCount, 1, true);
    faces = new Uint32Array(indexCount);
    let last = 0;
    for (let i = 0; i < indexCount; i++) {
      const encoded = deltas[i];
      const difference = encoded >>> 1;
      last = (encoded & 1) ? last - difference : last + difference;
      if (last < 0) throw new DracoError('negative face index');
      faces[i] = last;
    }
  } else {
    faces = new Uint32Array(indexCount);
    if (pointCount < 256) {
      reader.need(indexCount);
      for (let i = 0; i < indexCount; i++) faces[i] = buf[reader.pos + i];
      reader.pos += indexCount;
    } else if (pointCount < 65536) {
      reader.need(indexCount * 2);
      for (let i = 0; i < indexCount; i++) faces[i] = buf.readUInt16LE(reader.pos + i * 2);
      reader.pos += indexCount * 2;
    } else if (pointCount < 2097152 && v22) {
      for (let i = 0; i < indexCount; i++) faces[i] = reader.varint();
    } else {
      for (let i = 0; i < indexCount; i++) faces[i] = reader.u32();
    }
  }
  for (let i = 0; i < indexCount; i++) {
    if (faces[i] >= pointCount) throw new DracoError('face index out of range');
  }

  // Attributes (PointCloudDecoder::DecodePointAttributes)
  const decoderCount = reader.u8();
  const groups = [];
  for (let d = 0; d < decoderCount; d++) {
    const attributeCount = reader.varint();
    const group = [];
    for (let a = 0; a < attributeCount; a++) {
      group.push({
        type: reader.u8(),
        dataType: reader.u8(),
        components: reader.u8(),
        normalized: reader.u8(),
        id: reader.varint(),
      });
    }
    for (let a = 0; a < attributeCount; a++) group[a].decoder = reader.u8();
    groups.push(group);
  }

  // Keep position, texture coordinates and the normal (Roblox stores it as a
  // generic 3-float attribute).
  const wanted = {};
  groups.forEach((group, d) => {
    group.forEach((attribute, a) => {
      let key = null;
      if (attribute.type === 0 && !wanted.position) key = 'position';
      else if (attribute.type === 3 && !wanted.uv) key = 'uv';
      else if ((attribute.type === 1 || (attribute.type === 4 && attribute.dataType === 9 && attribute.components === 3))
        && !wanted.normal) key = 'normal';
      if (key !== null) {
        wanted[key] = true;
        attribute.keep = key;
      } else if (keepAll) {
        attribute.keep = `${d}.${a}`;
      }
    });
  });

  const result = { points: pointCount, faces, position: null, normal: null, uv: null, attributes: {} };
  for (const group of groups) {
    // DecodePortableAttributes
    const portable = [];
    group.forEach((attribute, a) => {
      const keep = attribute.keep !== undefined;
      const components = attribute.components;
      if (components < 1) throw new DracoError('attribute without components');
      const count = pointCount * components;
      if (attribute.decoder === 0) {
        const size = TYPE_SIZES[attribute.dataType];
        if (!size) throw new DracoError(`unknown attribute data type ${attribute.dataType}`);
        const bytes = count * size;
        reader.need(bytes);
        if (keep && attribute.dataType === 9) {
          const values = new Float64Array(count);
          for (let i = 0; i < count; i++) values[i] = buf.readFloatLE(reader.pos + i * 4);
          portable[a] = values;
        } else if (keep && !attribute.keep.includes('.')) {
          throw new DracoError('kept raw attribute is not float32');
        }
        reader.pos += bytes;
      } else if (attribute.decoder === 1 || attribute.decoder === 2) {
        if (attribute.decoder === 2 && attribute.dataType !== 9) throw new DracoError('quantized attribute is not float32');
        portable[a] = decodeIntegers(reader, count, components, keep);
      } else {
        throw new DracoError(`attribute decoder type ${attribute.decoder} is not supported`);
      }
    });
    // DecodeDataNeededByPortableTransforms + TransformAttributesToOriginalFormat
    group.forEach((attribute, a) => {
      const keep = attribute.keep !== undefined;
      if (attribute.decoder === 2) {
        const minimums = [];
        for (let c = 0; c < attribute.components; c++) minimums.push(reader.f32());
        const range = reader.f32();
        const bits = reader.u8();
        if (bits < 1 || bits > 30) throw new DracoError(`bad quantization bits ${bits}`);
        if (keep) {
          const delta = range / (Math.pow(2, bits) - 1);
          const values = portable[a];
          const components = attribute.components;
          for (let i = 0; i < values.length; i++) values[i] = values[i] * delta + minimums[i % components];
          if (attribute.keep.includes('.')) result.attributes[attribute.keep] = values;
          else result[attribute.keep] = values;
        }
      } else if (keep && attribute.keep.includes('.')) {
        result.attributes[attribute.keep] = portable[a] === undefined ? null : portable[a];
      } else if (keep) {
        if (attribute.decoder === 1) throw new DracoError('kept attribute is integer-coded');
        result[attribute.keep] = portable[a];
      }
    });
  }

  result.consumed = reader.pos - start;
  result.length = length;
  return result;
}

function dracoToV2Parts(buf, start, length) {
  const mesh = dracoDecode(buf, start, length, false);
  if (mesh.position === null) throw new DracoError('mesh has no positions');
  const points = mesh.points;
  const vertices = Buffer.alloc(points * 36);
  for (let i = 0; i < points; i++) {
    const o = i * 36;
    vertices.writeFloatLE(mesh.position[i * 3], o);
    vertices.writeFloatLE(mesh.position[i * 3 + 1], o + 4);
    vertices.writeFloatLE(mesh.position[i * 3 + 2], o + 8);
    vertices.writeFloatLE(mesh.normal ? mesh.normal[i * 3] : 0, o + 12);
    vertices.writeFloatLE(mesh.normal ? mesh.normal[i * 3 + 1] : 0, o + 16);
    vertices.writeFloatLE(mesh.normal ? mesh.normal[i * 3 + 2] : 0, o + 20);
    vertices.writeFloatLE(mesh.uv ? mesh.uv[i * 2] : 0, o + 24);
    vertices.writeFloatLE(mesh.uv ? mesh.uv[i * 2 + 1] : 0, o + 28);
  }
  const faces = Buffer.alloc(mesh.faces.length * 4);
  for (let i = 0; i < mesh.faces.length; i++) faces.writeUInt32LE(mesh.faces[i], i * 4);
  return { vertexCount: points, vertices, faceCount: mesh.faces.length / 3, faces };
}

// --- Mesh version conversion ---------------------------------------------

function readU32List(buf, offset, count) {
  if (count <= 0) return [];
  if (offset < 0 || offset + count * 4 > buf.length) return null;
  const list = [];
  for (let i = 0; i < count; i++) list.push(buf.readUInt32LE(offset + i * 4));
  return list;
}

// Returns a version 2.00 mesh, or null when the mesh is already readable or
// cannot be converted (meshError() then says why).
function meshToV2(buf) {
  lastMeshError = '';
  const length = buf.length;
  const newline = buf.indexOf(0x0a);
  if (newline < 0 || newline > 20) return null;
  const match = /^version ([0-9]+)\.([0-9]+)$/.exec(buf.toString('latin1', 0, newline).replace(/\r$/, ''));
  if (!match) return null;
  const major = Number(match[1]);
  const offset = newline + 1;
  if (major >= 2) lastMeshError = 'could not parse the mesh data';

  let vertexSize = 40;
  let faceSize = 12;
  let vertexCount = 0;
  let faceCount = 0;
  let verticesOffset = null;
  let facesOffset = null;
  let lods = [];
  let dracoStart = null;
  let dracoLength = 0;
  let draco = null;

  if (major === 2) {
    if (length < offset + 12) return null;
    const headerSize = buf.readUInt16LE(offset);
    vertexSize = buf[offset + 2];
    faceSize = buf[offset + 3];
    if (vertexSize === 36) {
      lastMeshError = '';
      return null;
    }
    vertexCount = buf.readUInt32LE(offset + 4);
    faceCount = buf.readUInt32LE(offset + 8);
    verticesOffset = offset + headerSize;
    facesOffset = verticesOffset + vertexCount * vertexSize;
  } else if (major === 3) {
    if (length < offset + 16) return null;
    const headerSize = buf.readUInt16LE(offset);
    vertexSize = buf[offset + 2];
    faceSize = buf[offset + 3];
    const lodSize = buf.readUInt16LE(offset + 4);
    const lodCount = buf.readUInt16LE(offset + 6);
    vertexCount = buf.readUInt32LE(offset + 8);
    faceCount = buf.readUInt32LE(offset + 12);
    verticesOffset = offset + headerSize;
    facesOffset = verticesOffset + vertexCount * vertexSize;
    if (lodSize === 4) lods = readU32List(buf, facesOffset + faceCount * faceSize, lodCount);
  } else if (major === 4 || major === 5) {
    if (length < offset + 24) return null;
    const headerSize = buf.readUInt16LE(offset);
    vertexCount = buf.readUInt32LE(offset + 4);
    faceCount = buf.readUInt32LE(offset + 8);
    const lodCount = buf.readUInt16LE(offset + 12);
    const boneCount = buf.readUInt16LE(offset + 14);
    verticesOffset = offset + headerSize;
    facesOffset = verticesOffset + vertexCount * vertexSize;
    if (boneCount > 0) facesOffset += vertexCount * 8; // skinning envelopes
    lods = readU32List(buf, facesOffset + faceCount * faceSize, lodCount);
  } else if (major === 6 || major === 7) {
    let cursor = offset;
    while (cursor + 16 <= length) {
      const type = buf.toString('latin1', cursor, cursor + 8).replace(/\0+$/, '');
      const version = buf.readUInt32LE(cursor + 8);
      const size = buf.readUInt32LE(cursor + 12);
      const body = cursor + 16;
      if (body + size > length) return null;
      if (type === 'COREMESH' && version === 1 && size >= 8) {
        vertexCount = buf.readUInt32LE(body);
        verticesOffset = body + 4;
        const faceCountOffset = verticesOffset + vertexCount * vertexSize;
        if (faceCountOffset + 4 > length) return null;
        faceCount = buf.readUInt32LE(faceCountOffset);
        facesOffset = faceCountOffset + 4;
      } else if (type === 'COREMESH' && version === 2 && size >= 4) {
        const dracoSize = buf.readUInt32LE(body);
        if (dracoSize + 4 > size) return null;
        dracoStart = body + 4;
        dracoLength = dracoSize;
      } else if (type === 'LODS' && version === 1 && size >= 7) {
        lods = readU32List(buf, body + 7, buf.readUInt32LE(body + 3));
      }
      cursor = body + size;
    }
    if (verticesOffset === null && dracoStart !== null) {
      try {
        draco = dracoToV2Parts(buf, dracoStart, dracoLength);
      } catch (error) {
        if (!(error instanceof DracoError)) throw error;
        lastMeshError = `Draco: ${error.message}`;
        return null;
      }
      vertexCount = draco.vertexCount;
      faceCount = draco.faceCount;
    } else if (verticesOffset === null) {
      lastMeshError = 'no COREMESH chunk this converter understands';
      return null;
    }
  } else {
    lastMeshError = `mesh version ${match[0]} is not supported`;
    return null;
  }

  if (draco === null && (vertexSize < 36 || faceSize !== 12
    || verticesOffset + vertexCount * vertexSize > length
    || facesOffset + faceCount * faceSize > length)) {
    return null;
  }
  if (vertexCount <= 0 || faceCount <= 0 || vertexCount > 4000000 || faceCount > 8000000) return null;

  let firstFace = 0;
  let lastFace = faceCount;
  if (Array.isArray(lods) && lods.length >= 2 && lods[0] >= 0 && lods[0] < lods[1] && lods[1] <= faceCount) {
    firstFace = lods[0];
    lastFace = lods[1];
  }
  const allFaces = draco !== null ? draco.faces : buf.subarray(facesOffset, facesOffset + faceCount * 12);
  const faces = allFaces.subarray(firstFace * 12, lastFace * 12);
  for (let i = 0; i < faces.length; i += 4) {
    if (faces.readUInt32LE(i) >= vertexCount) return null;
  }

  let vertices;
  if (draco !== null) {
    vertices = draco.vertices;
  } else {
    // Position, normal and UV (32 bytes); zero the 4 tangent/"w" bytes.
    vertices = Buffer.alloc(vertexCount * 36);
    for (let i = 0; i < vertexCount; i++) {
      buf.copy(vertices, i * 36, verticesOffset + i * vertexSize, verticesOffset + i * vertexSize + 32);
    }
  }

  const header = Buffer.alloc(12);
  header.writeUInt16LE(12, 0);
  header[2] = 36;
  header[3] = 12;
  header.writeUInt32LE(vertexCount, 4);
  header.writeUInt32LE(lastFace - firstFace, 8);
  lastMeshError = '';
  return Buffer.concat([Buffer.from('version 2.00\n', 'latin1'), header, vertices, faces]);
}

// Undoes gzip and downgrades too-new meshes. changes lists what was done,
// plus "mesh-unconverted" when a mesh could not be converted.
function normalizeAsset(bytes) {
  const changes = [];
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const decoded = zlib.gunzipSync(bytes);
      if (decoded.length > 0) {
        bytes = decoded;
        changes.push('gunzip');
      }
    } catch (error) {
      // Not really gzip; serve as-is.
    }
  }
  if (bytes.length >= 8 && bytes.toString('latin1', 0, 8) === 'version ') {
    const mesh = meshToV2(bytes);
    if (mesh !== null) {
      bytes = mesh;
      changes.push('mesh-v2');
    } else if (lastMeshError !== '') {
      changes.push('mesh-unconverted');
      assetLog(`mesh not converted (${bytes.toString('latin1', 0, 12).trim()}): ${lastMeshError}`);
    }
  }
  return { bytes, changes };
}

function needsNormalizing(head) {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return true;
  const text = head.toString('latin1');
  if (!text.startsWith('version ')) return false;
  const match = /^version ([0-9]+)\./.exec(text);
  if (match && Number(match[1]) >= 3) return true;
  return text.startsWith('version 2.00\n') && head.length >= 16 && head[15] !== 36;
}

module.exports = { DracoError, dracoDecode, meshToV2, meshError, normalizeAsset, needsNormalizing };
