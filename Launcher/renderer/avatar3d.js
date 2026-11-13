'use strict';

// 3D avatar for the launcher: a 2017 R6 character with body colors, classic
// clothing, a face, hats and packages, drawn with three.js
// (renderer/vendor/three.min.js). What each item is made of comes from the
// web server, which reads it out of the item's model file
// (/api/launcher/item/<id>, Webserver/node/lib/wearables.js); meshes and
// pictures come through launcher-net:// (account.js in the main process).
//
//   const view = Avatar3D.create(canvas)
//   await view.show({ bodyColors, assets: [{ id, typeId }] })
//   view.rotateBy(radians)          view.snapshot('full' | 'head', size) -> Promise<Blob>
//
// Roblox's coordinates are used as they are (Y up, the character faces -Z);
// the camera looks at the character's front from -Z.

/* global THREE */
(function () {
  const NET = 'launcher-net://server';
  const CLIENT = 'launcher-net://client';

  // Roblox's avatar body color palette (avatar.roblox.com/v1/avatar-rules).
  const BRICK_COLORS = [
    [361, '#564236', 'Dirt brown'], [192, '#694028', 'Reddish brown'], [217, '#7C5C46', 'Brown'], [153, '#957977', 'Sand red'],
    [359, '#AF9483', 'Linen'], [352, '#C7AC78', 'Burlap'], [5, '#D7C59A', 'Brick yellow'], [101, '#DA867A', 'Medium red'],
    [1007, '#A34B4B', 'Dusty Rose'], [1014, '#AA5500', 'CGA brown'], [38, '#A05F35', 'Dark orange'], [18, '#CC8E69', 'Nougat'],
    [125, '#EAB892', 'Light orange'], [1030, '#FFCC99', 'Pastel brown'], [133, '#D5733D', 'Neon orange'], [106, '#DA8541', 'Bright orange'],
    [105, '#E29B40', 'Br. yellowish orange'], [1017, '#FFAF00', 'Deep orange'], [24, '#F5CD30', 'Bright yellow'], [334, '#F8D96D', 'Daisy orange'],
    [226, '#FDEA8D', 'Cool yellow'], [141, '#27462D', 'Earth green'], [1021, '#3A7D15', 'Camo'], [28, '#287F47', 'Dark green'],
    [37, '#4B974B', 'Bright green'], [310, '#5B9A4C', 'Shamrock'], [317, '#7C9C6B', 'Moss'], [119, '#A4BD47', 'Br. yellowish green'],
    [1011, '#002060', 'Navy blue'], [1012, '#2154B9', 'Deep blue'], [1010, '#0000FF', 'Really blue'], [23, '#0D69AC', 'Bright blue'],
    [305, '#527CAE', 'Steel blue'], [102, '#6E99CA', 'Medium blue'], [45, '#B4D2E4', 'Light blue'], [107, '#008F9C', 'Bright bluish green'],
    [1018, '#12EED4', 'Teal'], [1027, '#9FF3E9', 'Pastel blue-green'], [1019, '#00FFFF', 'Toothpaste'], [1013, '#04AFEC', 'Cyan'],
    [11, '#80BBDC', 'Pastel Blue'], [1024, '#AFDDFF', 'Pastel light blue'], [104, '#6B327C', 'Bright violet'], [1023, '#8C5B9F', 'Lavender'],
    [321, '#A75E9B', 'Lilac'], [1015, '#AA00AA', 'Magenta'], [1031, '#6225D1', 'Royal purple'], [1006, '#B480FF', 'Alder'],
    [1026, '#B1A7FF', 'Pastel violet'], [21, '#C4281C', 'Bright red'], [1004, '#FF0000', 'Really red'], [1032, '#FF00BF', 'Hot pink'],
    [1016, '#FF66CC', 'Pink'], [330, '#FF98DC', 'Carnation pink'], [9, '#E8BAC8', 'Light reddish violet'], [1025, '#FFC9C9', 'Pastel orange'],
    [364, '#5A4C42', 'Dark taupe'], [351, '#BC9B5D', 'Cork'], [1008, '#C1BE42', 'Olive'], [29, '#A1C48C', 'Medium green'],
    [1022, '#7F8E64', 'Grime'], [151, '#789082', 'Sand green'], [135, '#74869D', 'Sand blue'], [1020, '#00FF00', 'Lime green'],
    [1028, '#CCFFCC', 'Pastel green'], [1009, '#FFFF00', 'New Yeller'], [1029, '#FFFFCC', 'Pastel yellow'], [1003, '#111111', 'Really black'],
    [26, '#1B2A35', 'Black'], [199, '#635F62', 'Dark stone grey'], [194, '#A3A2A5', 'Medium stone grey'], [1002, '#CDCDCD', 'Mid gray'],
    [208, '#E5E4DF', 'Light stone grey'], [1, '#F2F3F3', 'White'], [1001, '#F8F8F8', 'Institutional white'],
  ];
  const COLOR_HEX = new Map(BRICK_COLORS.map(([id, hex]) => [id, hex]));
  // A few older colors outside the palette.
  [[2, '#A1A5A2'], [3, '#F9E999'], [12, '#CB8442'], [25, '#624732'], [27, '#6D6E6C'], [36, '#F3CF9B'], [40, '#ECECEC'],
    [47, '#D9856C'], [50, '#ECE8DE'], [100, '#EEC4B6'], [128, '#AE7A59'], [138, '#958A73'], [180, '#D7A94B'], [193, '#CF6024'],
    [212, '#9FC3E9'], [221, '#CD6298'], [222, '#E4ADC8'], [1005, '#FFB000']].forEach(([id, hex]) => { if (!COLOR_HEX.has(id)) COLOR_HEX.set(id, hex); });

  function colorHex(id) {
    return COLOR_HEX.get(Number(id)) || '#A3A2A5';
  }

  // --- loading ---------------------------------------------------------------------------

  const itemCache = new Map();
  const meshCache = new Map();
  const imageCache = new Map();

  function assetUrl(id) {
    if (id && typeof id === 'object' && id.builtin) return `${CLIENT}/${id.builtin}`;
    return `${NET}/asset/?id=${encodeURIComponent(String(id))}`;
  }

  function cached(map, key, load) {
    if (!map.has(key)) map.set(key, load().catch(() => null));
    return map.get(key);
  }

  function item(id) {
    return cached(itemCache, String(id), async () => {
      const response = await fetch(`${NET}/api/launcher/item/${encodeURIComponent(String(id))}`);
      if (!response.ok) return null;
      const data = await response.json();
      return data.item || null;
    });
  }

  function image(id) {
    if (!id) return Promise.resolve(null);
    const url = assetUrl(id);
    return cached(imageCache, url, async () => {
      const response = await fetch(url);
      if (!response.ok) return null;
      return createImageBitmap(await response.blob());
    });
  }

  // Roblox mesh files: version 1.00/1.01 (text) and 2.00 (binary); the web
  // server converts newer versions to 2.00 for the 2017 client.
  function parseMesh(buffer) {
    const bytes = new Uint8Array(buffer);
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 13));
    if (head.startsWith('version 1.0')) {
      const text = new TextDecoder('latin1').decode(bytes);
      const groups = text.match(/\[[^\]]*\]/g) || [];
      const scale = head.startsWith('version 1.00') ? 0.5 : 1;
      const count = Math.floor(groups.length / 3);
      const positions = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      const uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const [p, n, t] = [0, 1, 2].map((k) => groups[i * 3 + k].slice(1, -1).split(',').map(Number));
        positions.set([p[0] * scale, p[1] * scale, p[2] * scale], i * 3);
        normals.set([n[0], n[1], n[2]], i * 3);
        uvs.set([t[0], t[1]], i * 2); // version 1 counts v from the bottom already
      }
      return { positions, normals, uvs, indices: null };
    }
    if (!head.startsWith('version 2.00')) return null;
    const view = new DataView(buffer);
    let p = bytes.indexOf(10) + 1;
    const headerSize = view.getUint16(p, true);
    const vertexSize = bytes[p + 2];
    const vertexCount = view.getUint32(p + 4, true);
    const faceCount = view.getUint32(p + 8, true);
    p += headerSize;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++, p += vertexSize) {
      positions[i * 3] = view.getFloat32(p, true);
      positions[i * 3 + 1] = view.getFloat32(p + 4, true);
      positions[i * 3 + 2] = view.getFloat32(p + 8, true);
      normals[i * 3] = view.getFloat32(p + 12, true);
      normals[i * 3 + 1] = view.getFloat32(p + 16, true);
      normals[i * 3 + 2] = view.getFloat32(p + 20, true);
      uvs[i * 2] = view.getFloat32(p + 24, true);
      uvs[i * 2 + 1] = 1 - view.getFloat32(p + 28, true);
    }
    const indices = new Uint32Array(faceCount * 3);
    for (let i = 0; i < faceCount * 3; i++, p += 4) indices[i] = view.getUint32(p, true);
    return { positions, normals, uvs, indices };
  }

  function mesh(id) {
    if (!id) return Promise.resolve(null);
    const url = assetUrl(id);
    return cached(meshCache, url, async () => {
      const response = await fetch(url);
      if (!response.ok) return null;
      return parseMesh(await response.arrayBuffer());
    });
  }

  function geometryFrom(data, transform) {
    const geometry = new THREE.BufferGeometry();
    const positions = Float32Array.from(data.positions);
    if (transform) {
      for (let i = 0; i < positions.length; i += 3) {
        const [x, y, z] = transform(positions[i], positions[i + 1], positions[i + 2]);
        positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
      }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(data.normals), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    return geometry;
  }

  function bounds(data) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], data.positions[i + k]);
        max[k] = Math.max(max[k], data.positions[i + k]);
      }
    }
    return { min, max, size: max.map((v, k) => v - min[k]), center: max.map((v, k) => (v + min[k]) / 2) };
  }

  function canvasTexture(source) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = 4;
    return texture;
  }

  // --- the R6 body -------------------------------------------------------------------------

  // Where each face of a body part sits on the classic 585x559 clothing
  // template ([x, y, width, height]). F front, B back, R/L the character's
  // right/left side, U top, D bottom.
  const TEMPLATE = [585, 559];
  const RECTS = {
    torso: { F: [231, 74, 128, 128], B: [427, 74, 128, 128], R: [165, 74, 64, 128], L: [361, 74, 64, 128], U: [231, 8, 128, 64], D: [231, 204, 128, 64] },
    right: { L: [19, 355, 64, 128], B: [85, 355, 64, 128], R: [151, 355, 64, 128], F: [217, 355, 64, 128], U: [217, 289, 64, 64], D: [217, 485, 64, 64] },
    left: { F: [308, 355, 64, 128], L: [374, 355, 64, 128], B: [440, 355, 64, 128], R: [506, 355, 64, 128], U: [308, 289, 64, 64], D: [308, 485, 64, 64] },
  };

  const PARTS = {
    Torso: { size: [2, 2, 1], at: [0, 0, 0], rects: RECTS.torso, color: 'TorsoColor', shirt: true, pants: true },
    LeftArm: { size: [1, 2, 1], at: [-1.5, 0, 0], rects: RECTS.left, color: 'LeftArmColor', shirt: true },
    RightArm: { size: [1, 2, 1], at: [1.5, 0, 0], rects: RECTS.right, color: 'RightArmColor', shirt: true },
    LeftLeg: { size: [1, 2, 1], at: [-0.5, -2, 0], rects: RECTS.left, color: 'LeftLegColor', pants: true },
    RightLeg: { size: [1, 2, 1], at: [0.5, -2, 0], rects: RECTS.right, color: 'RightLegColor', pants: true },
  };
  const HEAD_AT = [0, 1.5, 0];

  // R6 attachment points (position in the part).
  const ATTACHMENTS = {
    HatAttachment: ['Head', [0, 0.6, 0]], HairAttachment: ['Head', [0, 0.6, 0]],
    FaceFrontAttachment: ['Head', [0, 0, -0.6]], FaceCenterAttachment: ['Head', [0, 0, 0]],
    NeckAttachment: ['Torso', [0, 1, 0]], BodyFrontAttachment: ['Torso', [0, 0, -0.5]], BodyBackAttachment: ['Torso', [0, 0, 0.5]],
    LeftCollarAttachment: ['Torso', [-1, 1, 0]], RightCollarAttachment: ['Torso', [1, 1, 0]],
    WaistFrontAttachment: ['Torso', [0, -1, -0.5]], WaistCenterAttachment: ['Torso', [0, -1, 0]], WaistBackAttachment: ['Torso', [0, -1, 0.5]],
    LeftShoulderAttachment: ['LeftArm', [0, 1, 0]], RightShoulderAttachment: ['RightArm', [0, 1, 0]],
    LeftGripAttachment: ['LeftArm', [0, -1, 0]], RightGripAttachment: ['RightArm', [0, -1, 0]],
    LeftFootAttachment: ['LeftLeg', [0, -1, 0]], RightFootAttachment: ['RightLeg', [0, -1, 0]],
  };

  function partOrigin(name) {
    return name === 'Head' ? HEAD_AT : PARTS[name].at;
  }

  // A box whose faces show their regions of the clothing template.
  function boxGeometry(size, rects) {
    const [x, y, z] = size.map((value) => value / 2);
    const faces = {
      F: [[[x, y, -z], [-x, y, -z], [-x, -y, -z], [x, -y, -z]], [0, 0, -1]],
      B: [[[-x, y, z], [x, y, z], [x, -y, z], [-x, -y, z]], [0, 0, 1]],
      R: [[[x, y, z], [x, y, -z], [x, -y, -z], [x, -y, z]], [1, 0, 0]],
      L: [[[-x, y, -z], [-x, y, z], [-x, -y, z], [-x, -y, -z]], [-1, 0, 0]],
      U: [[[x, y, z], [-x, y, z], [-x, y, -z], [x, y, -z]], [0, 1, 0]],
      D: [[[x, -y, -z], [-x, -y, -z], [-x, -y, z], [x, -y, z]], [0, -1, 0]],
    };
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (const [face, [corners, normal]] of Object.entries(faces)) {
      const [rx, ry, rw, rh] = rects[face];
      const [w, h] = TEMPLATE;
      const u0 = (rx + 0.5) / w;
      const u1 = (rx + rw - 0.5) / w;
      const v0 = 1 - (ry + 0.5) / h;
      const v1 = 1 - (ry + rh - 0.5) / h;
      const base = positions.length / 3;
      corners.forEach((corner) => { positions.push(...corner); normals.push(...normal); });
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  // The texture of one body part: its color, then pants, shirt and t-shirt
  // (and a package's own textures), on the template layout.
  function partTexture(part, look, extra) {
    const canvas = document.createElement('canvas');
    canvas.width = TEMPLATE[0];
    canvas.height = TEMPLATE[1];
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = colorHex(look.bodyColors[part.color]);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (extra && extra.base) ctx.drawImage(extra.base, 0, 0, canvas.width, canvas.height);
    if (part.pants && look.pants) ctx.drawImage(look.pants, 0, 0, canvas.width, canvas.height);
    if (part.shirt && look.shirt) ctx.drawImage(look.shirt, 0, 0, canvas.width, canvas.height);
    if (part === PARTS.Torso && look.tshirt) {
      const [x, y, w, h] = RECTS.torso.F;
      ctx.drawImage(look.tshirt, x, y, w, h);
    }
    if (extra && extra.overlay) ctx.drawImage(extra.overlay, 0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = 4;
    return texture;
  }

  function lambert(options) {
    return new THREE.MeshLambertMaterial(Object.assign({ side: THREE.DoubleSide }, options));
  }

  // --- CFrames ------------------------------------------------------------------------------

  function matrixFrom(cframe) {
    const m = new THREE.Matrix4();
    if (!cframe) return m;
    const r = cframe.r;
    const p = cframe.p;
    m.set(r[0], r[1], r[2], p[0], r[3], r[4], r[5], p[1], r[6], r[7], r[8], p[2], 0, 0, 0, 1);
    return m;
  }

  function translation(x, y, z) {
    return new THREE.Matrix4().makeTranslation(x, y, z);
  }

  // --- building a character ----------------------------------------------------------------------

  const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47]);

  async function accessoryMesh(description) {
    const handle = description.handle || {};
    let geometry = null;
    let textureId = null;
    let tint = null;
    if (handle.mesh && handle.mesh.meshId && handle.mesh.meshType === 5) {
      const data = await mesh(handle.mesh.meshId);
      if (!data) return null;
      const s = handle.mesh.scale || { x: 1, y: 1, z: 1 };
      const o = handle.mesh.offset || { x: 0, y: 0, z: 0 };
      geometry = geometryFrom(data, (x, y, z) => [x * s.x + o.x, y * s.y + o.y, z * s.z + o.z]);
      textureId = handle.mesh.textureId;
      const c = handle.mesh.vertexColor;
      if (c && (c.x !== 1 || c.y !== 1 || c.z !== 1)) tint = new THREE.Color(c.x, c.y, c.z);
    } else if (handle.meshPart && handle.meshPart.meshId) {
      const data = await mesh(handle.meshPart.meshId);
      if (!data) return null;
      // A MeshPart stretches its mesh to the part's size.
      const box = bounds(data);
      const size = handle.meshPart.size || handle.size;
      const k = box.size.map((value, i) => (value > 1e-6 ? [size.x, size.y, size.z][i] / value : 1));
      geometry = geometryFrom(data, (x, y, z) => [(x - box.center[0]) * k[0], (y - box.center[1]) * k[1], (z - box.center[2]) * k[2]]);
      textureId = handle.meshPart.textureId;
    } else {
      return null;
    }
    const bitmap = textureId ? await image(textureId) : null;
    const material = bitmap
      ? lambert({ map: canvasTexture(bitmap), transparent: true, alphaTest: 0.05 })
      : lambert({ color: 0xa3a2a5 });
    if (tint) material.color = tint;
    return new THREE.Mesh(geometry, material);
  }

  function placeAccessory(object, description) {
    let world;
    const known = description.attachment && ATTACHMENTS[description.attachment];
    if (known && description.attachmentCFrame) {
      const [partName, offset] = known;
      const origin = partOrigin(partName);
      world = translation(origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2])
        .multiply(matrixFrom(description.attachmentCFrame).invert());
    } else {
      // Older hats: the hat's AttachmentPoint meets the top of the head.
      world = translation(HEAD_AT[0], HEAD_AT[1] + 0.5, HEAD_AT[2])
        .multiply(matrixFrom(description.legacyPoint || { p: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).invert());
    }
    object.matrixAutoUpdate = false;
    object.matrix.copy(world);
  }

  async function headObject(look) {
    let geometry = null;
    const head = look.head;
    if (head && head.meshType === 5 && head.meshId) {
      const data = await mesh(head.meshId);
      if (data) {
        const s = head.scale || { x: 1, y: 1, z: 1 };
        geometry = geometryFrom(data, (x, y, z) => [x * s.x, y * s.y, z * s.z]);
      }
    }
    if (!geometry) {
      const data = await mesh({ builtin: 'avatar/heads/head.mesh' });
      if (data) {
        const s = head && head.meshType === 0 && head.scale ? head.scale : { x: 1.25, y: 1.25, z: 1.25 };
        geometry = geometryFrom(data, (x, y, z) => [x * s.x / 1.25, y * s.y / 1.25, z * s.z / 1.25]);
      } else {
        geometry = new THREE.CylinderGeometry(0.6, 0.6, 1.2, 24);
      }
    }
    const group = new THREE.Group();
    group.position.set(...HEAD_AT);
    group.add(new THREE.Mesh(geometry, lambert({ color: new THREE.Color(colorHex(look.bodyColors.HeadColor)).convertSRGBToLinear() })));
    // The face: a decal on the front of the head, bent around it.
    const face = look.face === undefined ? await image({ builtin: 'textures/face.png' }) : look.face;
    if (face) {
      // PlaneGeometry faces +Z with its picture's right side at +X; seen from
      // the front (-Z) the picture's right is at -X, so x is mirrored.
      const plane = new THREE.PlaneGeometry(1.16, 1.16, 16, 1);
      const position = plane.attributes.position;
      for (let i = 0; i < position.count; i++) {
        const x = -position.getX(i);
        position.setX(i, x);
        position.setZ(i, -Math.sqrt(Math.max(0, 0.6 * 0.6 - x * x)) - 0.006);
      }
      plane.computeVertexNormals();
      const material = new THREE.MeshLambertMaterial({ map: canvasTexture(face), transparent: true, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide });
      const decal = new THREE.Mesh(plane, material);
      decal.renderOrder = 2;
      group.add(decal);
    }
    return group;
  }

  // --- compositing (what the 2017 client does) ---------------------------------------------
  // The client paints each character's body colors and clothes into one
  // 1024x512 picture with its Composit*.mesh files (positions are pixels in
  // that picture, texture coordinates point into the 585x559 clothing
  // template), in layers: body colors, a package's base texture, pants,
  // shirt, t-shirt, a package's overlay. The R6 body meshes and package
  // meshes are textured with that picture.

  const ATLAS = [1024, 512];
  const COMPOSIT = 'fonts';
  const BODY_MESHES = { Torso: 'torso', LeftArm: 'leftarm', RightArm: 'rightarm', LeftLeg: 'leftleg', RightLeg: 'rightleg' };
  let compositor = null;

  function compositorRenderer() {
    if (!compositor) {
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS[0];
      canvas.height = ATLAS[1];
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, preserveDrawingBuffer: true });
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.setSize(ATLAS[0], ATLAS[1], false);
      // The atlas's y runs upward (y = 0 is its bottom row).
      const camera = new THREE.OrthographicCamera(0, ATLAS[0], ATLAS[1], 0, -1000, 1000);
      camera.position.set(0, 0, 500);
      compositor = { renderer, camera };
    }
    return compositor;
  }

  function flat(options) {
    return new THREE.MeshBasicMaterial(Object.assign({ side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true }, options));
  }

  // UVs from a mesh's own positions (pixels in the atlas): for a package's
  // base and overlay textures, which are drawn in the atlas layout.
  function atlasUvGeometry(data) {
    const geometry = geometryFrom(data);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, data.positions[i * 3] / ATLAS[0], data.positions[i * 3 + 1] / ATLAS[1]);
    }
    return geometry;
  }

  async function composite(state, packaged) {
    const load = (name) => mesh({ builtin: `${COMPOSIT}/${name}.mesh` });
    const [shirtMesh, pantsMesh, tshirtMesh] = await Promise.all([load('CompositShirtTemplate'), load('CompositPantsTemplate'), load('CompositTShirt')]);
    const bases = {};
    await Promise.all(Object.keys(BODY_MESHES).map(async (part) => {
      bases[part] = await load(`Composit${part}Base`);
    }));
    if (Object.values(bases).some((data) => !data)) return null;

    const scene = new THREE.Scene();
    const add = (geometry, material, order) => {
      const object = new THREE.Mesh(geometry, material);
      object.renderOrder = order;
      scene.add(object);
    };
    for (const [part, data] of Object.entries(bases)) {
      const color = new THREE.Color(colorHex(state.bodyColors[PARTS[part].color])).convertSRGBToLinear();
      add(geometryFrom(data), flat({ color, transparent: false }), 1);
      const extra = packaged.get(part);
      if (extra && extra.base) add(atlasUvGeometry(data), flat({ map: canvasTexture(extra.base) }), 2);
      if (extra && extra.overlay) add(atlasUvGeometry(data), flat({ map: canvasTexture(extra.overlay) }), 6);
    }
    if (state.pants && pantsMesh) add(geometryFrom(pantsMesh), flat({ map: canvasTexture(state.pants) }), 3);
    if (state.shirt && shirtMesh) add(geometryFrom(shirtMesh), flat({ map: canvasTexture(state.shirt) }), 4);
    if (state.tshirt && tshirtMesh) add(geometryFrom(tshirtMesh), flat({ map: canvasTexture(state.tshirt) }), 5);

    const { renderer, camera } = compositorRenderer();
    renderer.setClearColor(0x808080, 1);
    renderer.render(scene, camera);
    const atlas = document.createElement('canvas');
    atlas.width = ATLAS[0];
    atlas.height = ATLAS[1];
    atlas.getContext('2d').drawImage(renderer.domElement, 0, 0);
    dispose(scene);
    const texture = new THREE.CanvasTexture(atlas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = 4;
    return texture;
  }

  async function build(look) {
    const descriptions = await Promise.all(look.assets.map(async (asset) => ({ asset, item: await item(asset.id) })));
    const byKind = (kind) => descriptions.filter((entry) => entry.item && entry.item.kind === kind).map((entry) => entry.item);
    const shirt = byKind('shirt')[0];
    const pants = byKind('pants')[0];
    const tshirt = byKind('tshirt')[0];
    const faceItem = byKind('face')[0];
    const [shirtImage, pantsImage, tshirtImage, faceImage] = await Promise.all([
      shirt ? image(shirt.templateId) : null,
      pants ? image(pants.templateId) : null,
      tshirt ? image(tshirt.graphicId) : null,
      faceItem ? image(faceItem.textureId) : undefined,
    ]);
    const state = {
      bodyColors: look.bodyColors,
      shirt: shirtImage,
      pants: pantsImage,
      tshirt: tshirtImage,
      face: faceItem ? faceImage : undefined,
      head: byKind('head')[0] || null,
    };

    const root = new THREE.Group();
    root.add(await headObject(state));

    // Packages replace a body part's mesh with their own.
    const packageParts = new Map();
    for (const part of byKind('bodypart').flatMap((entry) => entry.parts)) packageParts.set(part.bodyPart, part);
    const packaged = new Map();
    await Promise.all([...packageParts].map(async ([name, part]) => {
      if (!PARTS[name]) return;
      const data = await mesh(part.meshId);
      if (!data) return;
      const [base, overlay] = await Promise.all([image(part.baseTextureId), image(part.overlayTextureId)]);
      packaged.set(name, { data, base, overlay });
    }));
    const atlas = await composite(state, packaged);

    for (const [name, part] of Object.entries(PARTS)) {
      const own = packaged.get(name);
      const data = own ? own.data : await mesh({ builtin: `${COMPOSIT}/${BODY_MESHES[name]}.mesh` });
      // Without the client's files: plain boxes with the template laid on.
      const object = atlas && data
        ? new THREE.Mesh(geometryFrom(data), lambert({ map: atlas }))
        : new THREE.Mesh(boxGeometry(part.size, part.rects), lambert({ map: partTexture(part, state, own) }));
      object.position.set(...part.at);
      root.add(object);
    }

    const accessories = await Promise.all(descriptions
      .filter((entry) => entry.item && entry.item.kind === 'accessory' && ACCESSORY_TYPES.has(entry.asset.typeId || 8))
      .map(async (entry) => {
        const object = await accessoryMesh(entry.item);
        if (object) placeAccessory(object, entry.item);
        return object;
      }));
    accessories.filter(Boolean).forEach((object) => root.add(object));
    return root;
  }

  function dispose(object) {
    object.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        if (node.material.map) node.material.map.dispose();
        node.material.dispose();
      }
    });
  }

  // --- the view ---------------------------------------------------------------------------------

  function addLights(scene) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(4, 7, -6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 0.25);
    rim.position.set(-5, 3, 6);
    scene.add(rim);
  }

  const FRAMES = {
    full: { target: [0, 0.3, 0], distance: 15, fov: 26 },
    head: { target: [0, 1.6, 0], distance: 6.2, fov: 26 },
  };

  function placeCamera(camera, frame) {
    camera.fov = frame.fov;
    camera.position.set(frame.target[0], frame.target[1] + 0.25, -frame.distance);
    camera.lookAt(new THREE.Vector3(...frame.target));
    camera.updateProjectionMatrix();
  }

  function create(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    addLights(scene);
    const pivot = new THREE.Group();
    pivot.rotation.y = -0.45;
    scene.add(pivot);
    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
    placeCamera(camera, FRAMES.full);
    let character = null;
    let version = 0;
    let shown = null;

    function resize() {
      const width = canvas.clientWidth || 300;
      const height = canvas.clientHeight || 300;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    }

    function render() {
      renderer.render(scene, camera);
    }

    async function show(look) {
      const mine = ++version;
      const clean = { bodyColors: Object.assign({}, look.bodyColors), assets: (look.assets || []).map((asset) => ({ id: String(asset.id), typeId: Number(asset.typeId) || 0 })) };
      const object = await build(clean);
      if (mine !== version) { dispose(object); return false; }
      if (character) { pivot.remove(character); dispose(character); }
      character = object;
      shown = clean;
      pivot.add(character);
      render();
      return true;
    }

    function rotateBy(radians) {
      pivot.rotation.y += radians;
      render();
    }

    function setRotation(radians) {
      pivot.rotation.y = radians;
      render();
    }

    // A PNG of the character (transparent background), full body or head.
    async function snapshot(kind, size) {
      const shot = document.createElement('canvas');
      shot.width = size;
      shot.height = size;
      const offscreen = new THREE.WebGLRenderer({ canvas: shot, antialias: true, alpha: true, preserveDrawingBuffer: true });
      offscreen.outputEncoding = THREE.sRGBEncoding;
      offscreen.setSize(size, size, false);
      const shotCamera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
      placeCamera(shotCamera, FRAMES[kind] || FRAMES.full);
      const saved = pivot.rotation.y;
      pivot.rotation.y = kind === 'head' ? -0.3 : -0.45;
      offscreen.render(scene, shotCamera);
      pivot.rotation.y = saved;
      const blob = await new Promise((resolve) => shot.toBlob(resolve, 'image/png'));
      offscreen.dispose();
      offscreen.forceContextLoss();
      return blob;
    }

    window.addEventListener('resize', resize);
    resize();
    return { show, rotateBy, setRotation, resize, render, snapshot, current: () => shown };
  }

  window.Avatar3D = { create, BRICK_COLORS, colorHex };
}());
