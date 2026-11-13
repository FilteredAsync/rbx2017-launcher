'use strict';

// What the launcher's 3D avatar preview needs to draw one catalog item,
// read from the item's model file (lib/modelreader.js):
//
//   accessory  { handle: { size, mesh: {meshId, textureId, scale, offset} | meshPart: {meshId, textureId, size} },
//                attachment: name | null, attachmentCFrame, legacyPoint }
//   shirt      { templateId }            pants { templateId }      tshirt { graphicId }
//   face       { textureId }             head  { meshType, meshId, scale }
//   bodypart   { parts: [{ bodyPart, meshId, baseTextureId, overlayTextureId }] }
//
// IDs are strings, or { builtin: "textures/face.png" } for the client's own
// files (rbxasset://).

const modelreader = require('./modelreader');

const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47]);
const BODY_PARTS = ['Head', 'Torso', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg'];

function find(instances, test) {
  return instances.find(test) || null;
}

function vector(value, fallback) {
  return value && typeof value === 'object' && Number.isFinite(value.x) ? { x: value.x, y: value.y, z: value.z } : fallback;
}

function cframe(value) {
  return value && Array.isArray(value.p) && Array.isArray(value.r) ? { p: value.p, r: value.r } : null;
}

function accessory(instances) {
  const root = find(instances, (item) => (item.className === 'Accessory' || item.className === 'Hat') && !item.parent)
    || find(instances, (item) => item.className === 'Accessory' || item.className === 'Hat');
  if (!root) return null;
  const handle = find(root.children, (item) => item.name === 'Handle');
  if (!handle) return null;
  const result = {
    kind: 'accessory',
    legacyPoint: cframe(root.props.AttachmentPoint),
    attachment: null,
    attachmentCFrame: null,
    handle: { size: vector(handle.props.size || handle.props.Size, { x: 1, y: 1, z: 1 }) },
  };
  const attachment = find(handle.children, (item) => item.className === 'Attachment');
  if (attachment) {
    result.attachment = attachment.name;
    result.attachmentCFrame = cframe(attachment.props.CFrame) || { p: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  }
  if (handle.className === 'MeshPart') {
    result.handle.meshPart = {
      meshId: modelreader.contentId(handle.props.MeshId || handle.props.MeshID),
      textureId: modelreader.contentId(handle.props.TextureID || handle.props.TextureId),
      size: result.handle.size,
      initialSize: vector(handle.props.InitialSize, null),
    };
  } else {
    const mesh = find(handle.children, (item) => item.className === 'SpecialMesh' || item.className === 'FileMesh');
    if (mesh) {
      result.handle.mesh = {
        meshType: Number.isFinite(mesh.props.MeshType) ? mesh.props.MeshType : 5,
        meshId: modelreader.contentId(mesh.props.MeshId),
        textureId: modelreader.contentId(mesh.props.TextureId),
        scale: vector(mesh.props.Scale, { x: 1, y: 1, z: 1 }),
        offset: vector(mesh.props.Offset, { x: 0, y: 0, z: 0 }),
        vertexColor: vector(mesh.props.VertexColor, { x: 1, y: 1, z: 1 }),
      };
    }
  }
  return result;
}

// -> the item's description, or null if the file has nothing usable.
function describe(typeId, bytes) {
  const instances = modelreader.read(bytes);
  if (!instances || instances.length === 0) return null;
  if (ACCESSORY_TYPES.has(typeId)) return accessory(instances);
  if (typeId === 11) {
    const shirt = find(instances, (item) => item.className === 'Shirt');
    return shirt ? { kind: 'shirt', templateId: modelreader.contentId(shirt.props.ShirtTemplate) } : null;
  }
  if (typeId === 12) {
    const pants = find(instances, (item) => item.className === 'Pants');
    return pants ? { kind: 'pants', templateId: modelreader.contentId(pants.props.PantsTemplate) } : null;
  }
  if (typeId === 2) {
    const graphic = find(instances, (item) => item.className === 'ShirtGraphic');
    return graphic ? { kind: 'tshirt', graphicId: modelreader.contentId(graphic.props.Graphic) } : null;
  }
  if (typeId === 18) {
    const decal = find(instances, (item) => item.className === 'Decal');
    return decal ? { kind: 'face', textureId: modelreader.contentId(decal.props.Texture) } : null;
  }
  if (typeId === 17) {
    const mesh = find(instances, (item) => item.className === 'SpecialMesh');
    if (!mesh) return null;
    return {
      kind: 'head',
      meshType: Number.isFinite(mesh.props.MeshType) ? mesh.props.MeshType : 0,
      meshId: modelreader.contentId(mesh.props.MeshId),
      scale: vector(mesh.props.Scale, { x: 1.25, y: 1.25, z: 1.25 }),
    };
  }
  if (typeId >= 27 && typeId <= 31) {
    const parts = instances.filter((item) => item.className === 'CharacterMesh').map((mesh) => ({
      bodyPart: BODY_PARTS[mesh.props.BodyPart] || null,
      meshId: modelreader.contentId(mesh.props.MeshId),
      baseTextureId: modelreader.contentId(mesh.props.BaseTextureId),
      overlayTextureId: modelreader.contentId(mesh.props.OverlayTextureId),
    })).filter((part) => part.bodyPart && part.meshId);
    return parts.length ? { kind: 'bodypart', parts } : null;
  }
  return null;
}

module.exports = { describe };
