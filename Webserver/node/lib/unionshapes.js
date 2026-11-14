'use strict';

// Collision shapes for unions on the 2017 engine.
//
// The 2017 engine collides with a union only through its PhysicsData. Newer
// files keep union collision in a form it cannot read, and many older copies
// have none, so such unions were drawn but walked and fallen through. The
// union's look comes from its asset (a PartOperationAsset whose MeshData is
// the finished mesh, "CSGMDL"); this turns that mesh into a set of boxes that
// fill its inside, written as PhysicsData the 2017 engine reads ("CSGPHS"
// version 3: convex pieces in the union's unscaled space, which the engine
// scales with the part). Hollow unions (arches, frames, pipes) keep their
// openings this way.
//
// The boxes follow the mesh's own coordinates when it has few (exact for
// unions built from blocks), else a grid, as fine as allows MAX_PIECES boxes. A cell is solid when, seen along
// each of the three axes, enough of it lies inside the mesh (by the winding of
// its faces, so the many small seams of CSG meshes do not matter). The result
// is checked against the volume the mesh encloses; a union that does not
// check out keeps the converter's old rule (lib/placefile.js).

const { lz4Block } = require('./rbxm');

const MAX_PIECES = 48;
const MAX_EXACT_PLANES = 48;
const GRID_CELLS = [32, 24, 16, 12, 8]; // cells along the longest side, tried in turn
const CELL_FILL = 0.15; // share of a cell that must be inside the mesh
const BUILD_PARALLEL = 6;

// --- The union's mesh ------------------------------------------------------------

// String properties of the instances in a binary model: className -> [{ name: Buffer }].
function stringProperties(buffer) {
  if (buffer.length < 32 || buffer.toString('latin1', 0, 8) !== '<roblox!') return null;
  const classes = new Map();
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
      const length = chunk.readUInt32LE(4);
      const list = Array.from({ length: chunk.readUInt32LE(9 + length) }, () => ({}));
      classes.set(chunk.readUInt32LE(0), { className: chunk.toString('latin1', 8, 8 + length), list });
    } else if (name === 'PROP') {
      const length = chunk.readUInt32LE(4);
      const known = classes.get(chunk.readUInt32LE(0));
      if (known && chunk[8 + length] === 0x01) {
        const property = chunk.toString('latin1', 8, 8 + length);
        let p = 9 + length;
        for (const instance of known.list) {
          const n = chunk.readUInt32LE(p);
          instance[property] = chunk.subarray(p + 4, p + 4 + n);
          p += 4 + n;
        }
      }
    } else if (name === 'END\0') {
      break;
    }
  }
  const result = new Map();
  for (const { className, list } of classes.values()) result.set(className, list);
  return result;
}

// CSGMDL versions 2 and 4 are XOR-obfuscated with this repeating key.
const CSGMDL_KEY = [86, 46, 110, 88, 49, 32, 48, 4, 52, 105, 12, 119, 12, 1, 94, 0, 26, 96, 55, 105, 29, 82, 43, 7, 79, 36, 89, 101, 83, 4, 122];
const VERTEX_BYTES = 84;

// A union asset -> { positions: Float32Array (x, y, z...), indices: Uint32Array }, or null.
function unionMesh(assetBytes) {
  const properties = stringProperties(assetBytes);
  const asset = properties && (properties.get('PartOperationAsset') || [])[0];
  const raw = asset && asset.MeshData;
  if (!raw || raw.length < 50) return null;
  const data = Buffer.from(raw);
  for (let i = 0; i < data.length; i++) data[i] ^= CSGMDL_KEY[i % CSGMDL_KEY.length];
  if (data.toString('latin1', 0, 6) !== 'CSGMDL') return null;
  const version = data.readUInt32LE(6);
  if (version !== 2 && version !== 4) return null;
  let p = 10 + 32; // magic, hash
  const vertexCount = data.readUInt32LE(p);
  if (data.readUInt32LE(p + 4) !== VERTEX_BYTES) return null;
  p += 8;
  if (p + vertexCount * VERTEX_BYTES + 4 > data.length) return null;
  const positions = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < 3; k++) positions[v * 3 + k] = data.readFloatLE(p + v * VERTEX_BYTES + k * 4);
  }
  p += vertexCount * VERTEX_BYTES;
  const indexCount = data.readUInt32LE(p);
  p += 4;
  if (indexCount % 3 !== 0 || p + indexCount * 4 > data.length) return null;
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) {
    indices[i] = data.readUInt32LE(p + i * 4);
    if (indices[i] >= vertexCount) return null;
  }
  return indices.length > 0 ? { positions, indices } : null;
}

// --- Boxes filling the mesh --------------------------------------------------------

// Cell boundaries along one axis: the mesh's own coordinates when there are
// few (exact), else `cells` equal cells.
function axisPlanes(values, min, max, cells) {
  if (cells === null) {
    const distinct = [...new Set(values.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
    return distinct.length <= MAX_EXACT_PLANES && distinct.length >= 2 ? distinct : null;
  }
  return Array.from({ length: cells + 1 }, (_, i) => min + ((max - min) * i) / cells);
}

// mesh -> { boxes: [[min xyz], [max xyz]], volume } with the given planes per axis.
function fillWithBoxes(P, I, planes, orientation) {
  const counts = planes.map((p) => p.length - 1);
  const [nx, ny, nz] = counts;
  const at = (i, j, l) => (l * ny + j) * nx + i;
  const cellOf = (k, v) => {
    const p = planes[k];
    let lo = 0;
    let hi = p.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid] <= v) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  // Inside share of each cell, summed over lines along the three axes.
  const share = new Float32Array(nx * ny * nz);
  const LINES = [[0.27, 0.31], [0.73, 0.29], [0.26, 0.74], [0.71, 0.69]];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const nb = counts[b];
    const nc = counts[c];
    const columns = Array.from({ length: nb * nc }, () => []);
    for (let t = 0; t < I.length; t += 3) {
      const A = I[t] * 3;
      const B = I[t + 1] * 3;
      const C = I[t + 2] * 3;
      const b0 = cellOf(b, Math.min(P[A + b], P[B + b], P[C + b]));
      const b1 = cellOf(b, Math.max(P[A + b], P[B + b], P[C + b]));
      const c0 = cellOf(c, Math.min(P[A + c], P[B + c], P[C + c]));
      const c1 = cellOf(c, Math.max(P[A + c], P[B + c], P[C + c]));
      for (let j = b0; j <= b1; j++) for (let l = c0; l <= c1; l++) columns[j * nc + l].push(t);
    }
    for (let j = 0; j < nb; j++) {
      for (let l = 0; l < nc; l++) {
        for (const [fb, fc] of LINES) {
          const y = planes[b][j] + (planes[b][j + 1] - planes[b][j]) * fb;
          const z = planes[c][l] + (planes[c][l + 1] - planes[c][l]) * fc;
          const hits = [];
          for (const t of columns[j * nc + l]) {
            const A = I[t] * 3;
            const B = I[t + 1] * 3;
            const C = I[t + 2] * 3;
            const d = (P[B + b] - P[A + b]) * (P[C + c] - P[A + c]) - (P[C + b] - P[A + b]) * (P[B + c] - P[A + c]);
            if (Math.abs(d) < 1e-12) continue;
            const u = ((y - P[A + b]) * (P[C + c] - P[A + c]) - (P[C + b] - P[A + b]) * (z - P[A + c])) / d;
            const v = ((P[B + b] - P[A + b]) * (z - P[A + c]) - (y - P[A + b]) * (P[B + c] - P[A + c])) / d;
            if (u < 0 || v < 0 || u + v > 1) continue;
            // d has the sign of the face's normal along this axis: a face
            // facing along the line is where the line leaves the inside.
            hits.push([P[A + a] + u * (P[B + a] - P[A + a]) + v * (P[C + a] - P[A + a]), d * orientation > 0 ? -1 : 1]);
          }
          hits.sort((p, q) => p[0] - q[0]);
          let winding = 0;
          for (let h = 0; h < hits.length; h++) {
            if (winding > 0 && h > 0) {
              const x0 = hits[h - 1][0];
              const x1 = hits[h][0];
              for (let i = cellOf(a, x0); i <= cellOf(a, x1); i++) {
                const covered = Math.min(x1, planes[a][i + 1]) - Math.max(x0, planes[a][i]);
                if (covered <= 0) continue;
                const cell = a === 0 ? at(i, j, l) : a === 1 ? at(l, i, j) : at(j, l, i);
                share[cell] += covered / (planes[a][i + 1] - planes[a][i]) / LINES.length;
              }
            }
            winding += hits[h][1];
          }
        }
      }
    }
  }
  const solid = new Uint8Array(share.length);
  for (let n = 0; n < share.length; n++) solid[n] = share[n] / 3 >= CELL_FILL ? 1 : 0;

  // Solid cells merged into boxes: each grows along x, then y, then z.
  const used = new Uint8Array(solid.length);
  const free = (i, j, l) => solid[at(i, j, l)] === 1 && used[at(i, j, l)] === 0;
  const boxes = [];
  let volume = 0;
  for (let l = 0; l < nz; l++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!free(i, j, l)) continue;
        let i1 = i;
        while (i1 + 1 < nx && free(i1 + 1, j, l)) i1++;
        const rowFree = (jj, ll) => { for (let ii = i; ii <= i1; ii++) if (!free(ii, jj, ll)) return false; return true; };
        let j1 = j;
        while (j1 + 1 < ny && rowFree(j1 + 1, l)) j1++;
        const layerFree = (ll) => { for (let jj = j; jj <= j1; jj++) if (!rowFree(jj, ll)) return false; return true; };
        let l1 = l;
        while (l1 + 1 < nz && layerFree(l1 + 1)) l1++;
        for (let ll = l; ll <= l1; ll++) for (let jj = j; jj <= j1; jj++) for (let ii = i; ii <= i1; ii++) used[at(ii, jj, ll)] = 1;
        const min = [planes[0][i], planes[1][j], planes[2][l]];
        const max = [planes[0][i1 + 1], planes[1][j1 + 1], planes[2][l1 + 1]];
        boxes.push([min, max]);
        volume += (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
      }
    }
  }
  return { boxes, volume };
}

// mesh -> boxes, or null when the mesh does not give a believable shape.
function shapeBoxes(mesh) {
  const P = mesh.positions;
  const I = mesh.indices;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const values = [[], [], []];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = P[i + k];
      if (!Number.isFinite(v)) return null;
      values[k].push(v);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if ([0, 1, 2].some((k) => !(max[k] - min[k] > 1e-4))) return null;
  // Volume the mesh encloses, and which way its faces turn.
  let signed = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    signed += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
      + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  const meshVolume = Math.abs(signed) / 6;
  if (!(meshVolume > 1e-6)) return null;
  const orientation = signed < 0 ? -1 : 1;
  // The mesh's own coordinates first, then finer to coarser grids (cells
  // along its longest side); the first that fits in MAX_PIECES and holds
  // about the mesh's volume wins. Coarse cells thicken thin parts, so the
  // boxes may hold more than the mesh; far less or far more means the grid
  // (or the mesh) did not work out.
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  for (const cells of [null, ...GRID_CELLS]) {
    let planes;
    if (cells === null) {
      planes = [0, 1, 2].map((k) => axisPlanes(values[k], min[k], max[k], null));
      if (planes.some((p) => p === null)) continue;
    } else {
      planes = [0, 1, 2].map((k) => axisPlanes(null, min[k], max[k], Math.max(1, Math.min(cells, Math.round(((max[k] - min[k]) / longest) * cells)))));
    }
    const filled = fillWithBoxes(P, I, planes, orientation);
    if (filled.boxes.length === 0 || filled.boxes.length > MAX_PIECES) continue;
    const ratio = filled.volume / meshVolume;
    if (ratio >= 0.6 && ratio <= 3) return filled.boxes;
  }
  return null;
}

// --- PhysicsData ---------------------------------------------------------------------

// CSGPHS version 3: each convex piece is a mesh record (a fixed header, then
// float count, vertex width 4, x/y/z floats, index count, triangle indices).
const PIECE_HEADER = Buffer.concat([Buffer.from([16, 0, 0, 0]), Buffer.alloc(16), Buffer.from([16, 0, 0, 0]), Buffer.alloc(14), Buffer.from([0x80, 0x3f])]);
const BOX_TRIANGLES = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]];

function physicsData(boxes) {
  const parts = [Buffer.from('CSGPHS\x03\x00\x00\x00', 'latin1')];
  for (const [min, max] of boxes) {
    const counts = Buffer.alloc(8);
    counts.writeUInt32LE(8 * 3, 0);
    counts.writeUInt32LE(4, 4);
    const corners = Buffer.alloc(8 * 12);
    for (let n = 0; n < 8; n++) {
      corners.writeFloatLE(n & 1 ? max[0] : min[0], n * 12);
      corners.writeFloatLE(n & 2 ? max[1] : min[1], n * 12 + 4);
      corners.writeFloatLE(n & 4 ? max[2] : min[2], n * 12 + 8);
    }
    const triangles = Buffer.alloc(4 + BOX_TRIANGLES.length * 12);
    triangles.writeUInt32LE(BOX_TRIANGLES.length * 3, 0);
    BOX_TRIANGLES.forEach((triangle, t) => triangle.forEach((corner, k) => triangles.writeUInt32LE(corner, 4 + t * 12 + k * 4)));
    parts.push(PIECE_HEADER, counts, corners, triangles);
  }
  return Buffer.concat(parts).toString('base64');
}

// --- Which unions, and building their shapes -----------------------------------------------

// The box the converter gives box-like unions without collision data.
const BLOCK_PHYSICS = Buffer.concat([Buffer.from('CSGPHS', 'latin1'), Buffer.alloc(4), Buffer.from('BLOCK', 'latin1')]).toString('base64');

// What lib/placefile.js needs to know about one union's properties (XML).
function unionInfo(props) {
  const asset = /<Content(?:Id)?\s+name="AssetId">\s*<ur[il]>[^<]*?(?:rbxassetid:\/\/|[?&]id=)(\d{1,15})/i.exec(props);
  const physics = /<BinaryString\s+name="PhysicsData">([^<]*)<\/BinaryString>/.exec(props);
  const volume = Number((/<float\s+name="UnscaledVolume">([^<]+)<\/float>/.exec(props) || [])[1]);
  const initial = /<Vector3\s+name="InitialSize">\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Z>([^<]+)<\/Z>/.exec(props);
  const box = initial ? Number(initial[1]) * Number(initial[2]) * Number(initial[3]) : 0;
  return {
    assetId: asset ? asset[1] : null,
    physics: physics ? physics[1].replace(/\s+/g, '') : '',
    fill: volume > 0 && box > 0 ? volume / box : null,
  };
}

// Whether a union gets a shape built from its mesh: it has no collision data,
// or only the converter's box while it is not a box.
function wantsShape(info) {
  return info.assetId !== null && (info.physics === '' || (info.physics === BLOCK_PHYSICS && info.fill !== null && info.fill < 0.999));
}

// assetIds (lib/placefile.js unionsNeedingShapes), fetchAsset(id) -> Buffer|null
// -> Map assetId -> PhysicsData (base64); unions not in it keep the old rule.
async function buildShapes(assetIds, fetchAsset) {
  const shapes = new Map();
  const ids = [...assetIds];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const bytes = await fetchAsset(id);
        const mesh = bytes ? unionMesh(bytes) : null;
        const boxes = mesh ? shapeBoxes(mesh) : null;
        if (boxes) shapes.set(id, physicsData(boxes));
      } catch (error) { /* this union keeps the old rule */ }
    }
  };
  await Promise.all(Array.from({ length: BUILD_PARALLEL }, worker));
  return shapes;
}

module.exports = { BLOCK_PHYSICS, unionInfo, wantsShape, buildShapes, unionMesh, shapeBoxes, physicsData };
