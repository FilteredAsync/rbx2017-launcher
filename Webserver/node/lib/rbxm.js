'use strict';

// Minimal reader for binary Roblox model files (.rbxm, "<roblox!"), enough to
// pull the R6 CharacterMesh out of a body part asset.
//
// Today's body part files carry the CharacterMesh IDs as 64-bit numbers
// (property format 27) next to R15 folders full of newer classes; the 2017
// engine rejects the whole file ("Unexpected format 27 (expected 3)"). The
// web server rewrites them into a small XML model with only the
// CharacterMesh, which the 2017 engine reads.

function lz4Block(src, size) {
  const out = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let literal = token >> 4;
    if (literal === 15) {
      let b;
      do { b = src[i++]; literal += b; } while (b === 255);
    }
    src.copy(out, o, i, i + literal);
    i += literal;
    o += literal;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let match = token & 15;
    if (match === 15) {
      let b;
      do { b = src[i++]; match += b; } while (b === 255);
    }
    match += 4;
    for (let k = 0; k < match; k++) {
      out[o] = out[o - offset];
      o++;
    }
  }
  return out.subarray(0, o);
}

// Interleaved, big-endian, zigzag-encoded integers (formats 3 and 27).
function readInterleaved(data, count, width) {
  const values = [];
  for (let n = 0; n < count; n++) {
    let value = 0n;
    for (let b = 0; b < width; b++) value = (value << 8n) | BigInt(data[b * count + n]);
    values.push((value >> 1n) ^ -(value & 1n));
  }
  return values;
}

function readUnsignedInterleaved(data, count) {
  const values = [];
  for (let n = 0; n < count; n++) {
    values.push(((data[n] << 24) | (data[count + n] << 16) | (data[2 * count + n] << 8) | data[3 * count + n]) >>> 0);
  }
  return values;
}

function readStrings(data, count) {
  const values = [];
  let p = 0;
  for (let n = 0; n < count && p + 4 <= data.length; n++) {
    const length = data.readUInt32LE(p);
    values.push(data.toString('utf8', p + 4, p + 4 + length));
    p += 4 + length;
  }
  return values;
}

// Returns [{ name, bodyPart, meshId, baseTextureId, overlayTextureId }] for
// each CharacterMesh in a binary model, or null if it is not one.
function characterMeshes(buffer) {
  if (buffer.length < 32 || buffer.toString('latin1', 0, 8) !== '<roblox!') return null;
  const classes = new Map();
  const meshes = new Map();
  let pos = 32;
  while (pos + 16 <= buffer.length) {
    const name = buffer.toString('latin1', pos, pos + 4);
    const compressed = buffer.readUInt32LE(pos + 4);
    const size = buffer.readUInt32LE(pos + 8);
    const body = pos + 16;
    let chunk;
    if (compressed === 0) {
      chunk = buffer.subarray(body, body + size);
      pos = body + size;
    } else {
      const data = buffer.subarray(body, body + compressed);
      if (data.length >= 4 && data.readUInt32BE(0) === 0x28b52ffd) return null; // zstd: not handled
      chunk = lz4Block(data, size);
      pos = body + compressed;
    }
    if (name === 'INST') {
      const classId = chunk.readUInt32LE(0);
      const length = chunk.readUInt32LE(4);
      const className = chunk.toString('latin1', 8, 8 + length);
      const count = chunk.readUInt32LE(9 + length);
      classes.set(classId, { className, count });
      if (className === 'CharacterMesh') {
        const list = [];
        for (let n = 0; n < count; n++) list.push({ name: 'CharacterMesh', bodyPart: 0, meshId: 0n, baseTextureId: 0n, overlayTextureId: 0n });
        meshes.set(classId, list);
      }
    } else if (name === 'PROP') {
      const classId = chunk.readUInt32LE(0);
      const list = meshes.get(classId);
      if (list) {
        const length = chunk.readUInt32LE(4);
        const property = chunk.toString('latin1', 8, 8 + length);
        const type = chunk[8 + length];
        const data = chunk.subarray(9 + length);
        const count = list.length;
        const target = { MeshId: 'meshId', BaseTextureId: 'baseTextureId', OverlayTextureId: 'overlayTextureId' }[property];
        if (target && (type === 0x1b || type === 0x03)) {
          readInterleaved(data, count, type === 0x1b ? 8 : 4).forEach((value, n) => { list[n][target] = value; });
        } else if (property === 'BodyPart' && type === 0x12) {
          readUnsignedInterleaved(data, count).forEach((value, n) => { list[n].bodyPart = value; });
        } else if (property === 'Name' && type === 0x01) {
          readStrings(data, count).forEach((value, n) => { list[n].name = value; });
        }
      }
    } else if (name === 'END\0') {
      break;
    }
  }
  return [...meshes.values()].flat();
}

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const INT32_MAX = 2147483647n;

// XML model with just the CharacterMeshes whose IDs fit the 2017 engine's
// 32-bit properties. Returns { xml, kept, skipped }.
function characterMeshXml(meshes) {
  let xml = '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n'
    + '\t<External>null</External>\n\t<External>nil</External>\n';
  let kept = 0;
  let skipped = 0;
  meshes.forEach((mesh) => {
    const ids = [mesh.meshId, mesh.baseTextureId, mesh.overlayTextureId];
    if (ids.some((id) => id < 0n || id > INT32_MAX)) {
      skipped++;
      return;
    }
    xml += `\t<Item class="CharacterMesh" referent="RBX${kept}">\n\t\t<Properties>\n`
      + `\t\t\t<int name="BaseTextureId">${mesh.baseTextureId}</int>\n`
      + `\t\t\t<token name="BodyPart">${mesh.bodyPart}</token>\n`
      + `\t\t\t<int name="MeshId">${mesh.meshId}</int>\n`
      + `\t\t\t<string name="Name">${xmlEscape(mesh.name)}</string>\n`
      + `\t\t\t<int name="OverlayTextureId">${mesh.overlayTextureId}</int>\n`
      + '\t\t</Properties>\n\t</Item>\n';
    kept++;
  });
  return { xml: `${xml}</roblox>\n`, kept, skipped };
}

module.exports = { characterMeshes, characterMeshXml, lz4Block };
