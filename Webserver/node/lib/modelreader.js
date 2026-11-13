'use strict';

// Reads Roblox model files (binary .rbxm "<roblox!" and XML .rbxmx) into a
// plain list of instances, enough for the launcher's avatar preview to find
// what an item is made of: meshes, textures, sizes and attachment points.
//
//   read(buffer) -> [{ className, name, props: { Name: value, ... }, parent, children: [] }] or null
//
// Values: strings and content URLs as strings, numbers, booleans, int64 as
// strings, Vector3 as {x, y, z}, CFrame as {p: [x, y, z], r: [9 numbers,
// row-major]}, Color3 as {r, g, b} (0-1), enums as numbers. Other property
// types are skipped.

const zlib = require('zlib');
const { lz4Block } = require('./rbxm');

// --- binary ---------------------------------------------------------------------------

function rotatedFloat(u) {
  const bits = ((u >>> 1) | (u << 31)) >>> 0;
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(bits, 0);
  return buffer.readFloatLE(0);
}

// Interleaved big-endian 32-bit values (each byte column stored apart).
function interleaved32(data, offset, count) {
  const values = new Array(count);
  for (let n = 0; n < count; n++) {
    values[n] = ((data[offset + n] << 24) | (data[offset + count + n] << 16) | (data[offset + 2 * count + n] << 8) | data[offset + 3 * count + n]) >>> 0;
  }
  return values;
}

function zigzag32(u) {
  return (u >>> 1) ^ -(u & 1);
}

function referents(data, offset, count) {
  const raw = interleaved32(data, offset, count);
  let last = 0;
  return raw.map((u) => { last += zigzag32(u); return last; });
}

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Rotation IDs: the right and up vectors are each one of the six axes.
function specialRotation(id) {
  const right = AXES[Math.floor((id - 1) / 6)];
  const up = AXES[(id - 1) % 6];
  if (!right || !up) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const back = cross(right, up);
  // Row-major matrix whose columns are right, up, back.
  return [right[0], up[0], back[0], right[1], up[1], back[1], right[2], up[2], back[2]];
}

function decodeProperty(type, data, count, sharedStrings) {
  switch (type) {
    case 0x01: { // String / Content
      const values = [];
      let p = 0;
      for (let n = 0; n < count && p + 4 <= data.length; n++) {
        const length = data.readUInt32LE(p);
        values.push(data.toString('utf8', p + 4, p + 4 + length));
        p += 4 + length;
      }
      return values;
    }
    case 0x02: return Array.from(data.subarray(0, count), (b) => b !== 0);
    case 0x03: return interleaved32(data, 0, count).map(zigzag32);
    case 0x04: return interleaved32(data, 0, count).map(rotatedFloat);
    case 0x05: return Array.from({ length: count }, (_, n) => data.readDoubleLE(n * 8));
    case 0x0c: { // Color3
      const r = interleaved32(data, 0, count).map(rotatedFloat);
      const g = interleaved32(data, 4 * count, count).map(rotatedFloat);
      const b = interleaved32(data, 8 * count, count).map(rotatedFloat);
      return r.map((value, n) => ({ r: value, g: g[n], b: b[n] }));
    }
    case 0x0e: { // Vector3
      const x = interleaved32(data, 0, count).map(rotatedFloat);
      const y = interleaved32(data, 4 * count, count).map(rotatedFloat);
      const z = interleaved32(data, 8 * count, count).map(rotatedFloat);
      return x.map((value, n) => ({ x: value, y: y[n], z: z[n] }));
    }
    case 0x10: { // CFrame
      const rotations = [];
      let p = 0;
      for (let n = 0; n < count; n++) {
        const id = data[p++];
        if (id === 0) {
          const r = [];
          for (let k = 0; k < 9; k++) { r.push(data.readFloatLE(p)); p += 4; }
          rotations.push(r);
        } else {
          rotations.push(specialRotation(id));
        }
      }
      const x = interleaved32(data, p, count).map(rotatedFloat);
      const y = interleaved32(data, p + 4 * count, count).map(rotatedFloat);
      const z = interleaved32(data, p + 8 * count, count).map(rotatedFloat);
      return rotations.map((r, n) => ({ p: [x[n], y[n], z[n]], r }));
    }
    case 0x12: return interleaved32(data, 0, count);
    case 0x1a: return Array.from({ length: count }, (_, n) => ({ r: data[n] / 255, g: data[count + n] / 255, b: data[2 * count + n] / 255 }));
    case 0x1b: { // Int64
      const values = [];
      for (let n = 0; n < count; n++) {
        let value = 0n;
        for (let b = 0; b < 8; b++) value = (value << 8n) | BigInt(data[b * count + n]);
        values.push(String((value >> 1n) ^ -(value & 1n)));
      }
      return values;
    }
    case 0x1c: return interleaved32(data, 0, count).map((index) => sharedStrings[index] || '');
    default: return null;
  }
}

function chunkData(buffer, pos) {
  const compressed = buffer.readUInt32LE(pos + 4);
  const size = buffer.readUInt32LE(pos + 8);
  const body = pos + 16;
  if (compressed === 0) return { data: buffer.subarray(body, body + size), next: body + size };
  const raw = buffer.subarray(body, body + compressed);
  const data = raw.length >= 4 && raw.readUInt32BE(0) === 0x28b52ffd ? zlib.zstdDecompressSync(raw) : lz4Block(raw, size);
  return { data, next: body + compressed };
}

function readBinary(buffer) {
  const classes = new Map();
  const byRef = new Map();
  const order = [];
  const parents = [];
  let sharedStrings = [];
  let pos = 32;
  while (pos + 16 <= buffer.length) {
    const name = buffer.toString('latin1', pos, pos + 4);
    const { data, next } = chunkData(buffer, pos);
    pos = next;
    if (name === 'INST') {
      const classId = data.readUInt32LE(0);
      const length = data.readUInt32LE(4);
      const className = data.toString('utf8', 8, 8 + length);
      const count = data.readUInt32LE(9 + length);
      const refs = referents(data, 13 + length, count);
      const list = refs.map((ref) => {
        const instance = { className, name: className, props: {}, parent: null, children: [], ref };
        byRef.set(ref, instance);
        order.push(instance);
        return instance;
      });
      classes.set(classId, list);
    } else if (name === 'PROP') {
      const classId = data.readUInt32LE(0);
      const list = classes.get(classId);
      if (!list) continue;
      const length = data.readUInt32LE(4);
      const property = data.toString('utf8', 8, 8 + length);
      const type = data[8 + length];
      let values = null;
      try {
        values = decodeProperty(type, data.subarray(9 + length), list.length, sharedStrings);
      } catch (error) {
        values = null;
      }
      if (!values) continue;
      list.forEach((instance, n) => {
        instance.props[property] = values[n];
        if (property === 'Name' && typeof values[n] === 'string') instance.name = values[n];
      });
    } else if (name === 'SSTR') {
      const count = data.readUInt32LE(4);
      sharedStrings = [];
      let p = 8;
      for (let n = 0; n < count && p + 20 <= data.length; n++) {
        p += 16; // hash
        const length = data.readUInt32LE(p);
        sharedStrings.push(data.toString('utf8', p + 4, p + 4 + length));
        p += 4 + length;
      }
    } else if (name === 'PRNT') {
      const count = data.readUInt32LE(1);
      const children = referents(data, 5, count);
      const parentRefs = referents(data, 5 + 4 * count, count);
      children.forEach((child, n) => parents.push([child, parentRefs[n]]));
    } else if (name === 'END\0') {
      break;
    }
  }
  for (const [childRef, parentRef] of parents) {
    const child = byRef.get(childRef);
    const parent = byRef.get(parentRef);
    if (child && parent) {
      child.parent = parent;
      parent.children.push(child);
    }
  }
  return order;
}

// --- XML ------------------------------------------------------------------------------

function unescapeXml(text) {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (all, hex, dec, named) => {
    if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
    return String.fromCodePoint(hex ? parseInt(hex, 16) : parseInt(dec, 10));
  });
}

function childText(xml, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

function xmlValue(type, inner) {
  switch (type.toLowerCase()) {
    case 'string': case 'protectedstring': case 'binarystring':
      return unescapeXml(inner.replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    case 'content': {
      const url = childText(inner, 'url');
      return url === null ? '' : unescapeXml(url);
    }
    case 'bool': return inner.trim() === 'true';
    case 'int': case 'token': case 'float': case 'double':
      return Number(inner.trim());
    case 'int64': return inner.trim();
    case 'vector3':
      return { x: Number(childText(inner, 'X')), y: Number(childText(inner, 'Y')), z: Number(childText(inner, 'Z')) };
    case 'coordinateframe': case 'cframe': {
      const n = (tag) => Number(childText(inner, tag));
      return { p: [n('X'), n('Y'), n('Z')], r: ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map(n) };
    }
    case 'color3': {
      const parts = ['R', 'G', 'B'].map((tag) => childText(inner, tag));
      if (parts.every((part) => part !== null)) return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]) };
      const packed = Number(inner.trim());
      return { r: ((packed >> 16) & 255) / 255, g: ((packed >> 8) & 255) / 255, b: (packed & 255) / 255 };
    }
    case 'color3uint8': {
      const packed = Number(inner.trim());
      return { r: ((packed >> 16) & 255) / 255, g: ((packed >> 8) & 255) / 255, b: (packed & 255) / 255 };
    }
    default: return undefined;
  }
}

function readXml(text) {
  const order = [];
  const stack = [];
  const tagRe = /<(\/?)(Item|Properties)\b([^>]*)>/g;
  let match;
  while ((match = tagRe.exec(text)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2];
    if (tag === 'Item' && !closing) {
      const className = (/class="([^"]*)"/.exec(match[3]) || [])[1] || 'Instance';
      const instance = { className, name: className, props: {}, parent: stack[stack.length - 1] || null, children: [] };
      if (instance.parent) instance.parent.children.push(instance);
      order.push(instance);
      stack.push(instance);
    } else if (tag === 'Item' && closing) {
      stack.pop();
    } else if (tag === 'Properties' && !closing) {
      const end = text.indexOf('</Properties>', tagRe.lastIndex);
      if (end < 0) break;
      const block = text.slice(tagRe.lastIndex, end);
      const instance = stack[stack.length - 1];
      const propRe = /<([A-Za-z0-9]+) name="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
      let prop;
      while (instance && (prop = propRe.exec(block)) !== null) {
        const value = xmlValue(prop[1], prop[3] || '');
        if (value === undefined) continue;
        instance.props[prop[2]] = value;
        if (prop[2] === 'Name' && typeof value === 'string') instance.name = value;
      }
      tagRe.lastIndex = end + '</Properties>'.length;
    }
  }
  return order;
}

function read(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 200));
  try {
    if (head.startsWith('<roblox!')) return readBinary(buffer);
    if (/<roblox[\s>]/i.test(head)) return readXml(buffer.toString('utf8'));
  } catch (error) {
    return null;
  }
  return null;
}

// "rbxassetid://123", "http://www.roblox.com/asset/?id=123", "...?ID=123&..." -> "123";
// rbxasset:// built-in paths are kept as { builtin: "textures/face.png" }.
function contentId(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (/^\d{1,19}$/.test(text)) return text === '0' ? null : text;
  let match = /^rbxassetid:\/\/(\d{1,19})/i.exec(text);
  if (match) return match[1];
  match = /[?&]id=(\d{1,19})/i.exec(text);
  if (match) return match[1];
  match = /^rbxasset:\/\/(.+)$/i.exec(text);
  if (match) return { builtin: match[1].replace(/\\/g, '/') };
  return null;
}

module.exports = { read, contentId };
