'use strict';

// The Android app's avatar editor (content/internal/avatareditor/
// AvatarStarterScriptV2.lua in the app). It puts "avatar.", "inventory." and
// "www." in front of the engine's base host m.<domain> and always uses https:
//   avatar.m.<domain>     GET  v1/avatar-rules, v1/avatar
//                         POST v1/avatar/set-body-colors | set-scales |
//                              set-player-avatar-type | set-wearing-assets
//                         GET  v1/users/<id>/outfits?page=&itemsPerPage=
//                         GET  v1/outfits/<id>/details
//   inventory.m.<domain>  GET  v1/users/<id>/inventory/<TypeName>?pageNumber=&itemsPerPage=
//   www.m.<domain>        Thumbs/Asset.ashx (lib/routes.js), outfit-thumbnail/image,
//                         catalog/<id> (the phone's item page, lib/mobileshop.js)
// Items load through the engine's own marketplace/productinfo and Asset/?id=.
//
// The script decodes every answer as JSON without guarding against bad JSON,
// so every answer here is JSON (errors too). Saves answer { success }; a
// failed save is sent again every 5 seconds. Inventory pages stop when a page
// has fewer than itemsPerPage ids. The engine session cookie (the app's, set
// for the whole domain) says who is editing. Avatars here are R6 (games are
// R6 unless set R15 on /manage); scales and the avatar type are accepted and
// not kept.

const accounts = require('./accounts');
const outfits = require('./outfits');

const PAGE_SIZE_MAX = 100;
const COLOR_FIELDS = {
  headColorId: 'HeadColor', torsoColorId: 'TorsoColor', leftArmColorId: 'LeftArmColor',
  rightArmColorId: 'RightArmColor', leftLegColorId: 'LeftLegColor', rightLegColorId: 'RightLegColor',
};
// The editor's inventory pages (PagesInfo.lua) -> asset type IDs.
const TYPE_NAMES = {
  Hat: 8, HairAccessory: 41, FaceAccessory: 42, NeckAccessory: 43, ShoulderAccessory: 44, FrontAccessory: 45,
  BackAccessory: 46, WaistAccessory: 47, Shirt: 11, Pants: 12, TShirt: 2, Face: 18, Head: 17,
  Torso: 27, RightArm: 28, LeftArm: 29, RightLeg: 31, LeftLeg: 30, Gear: 19,
};
const TYPE_CATEGORY = {
  8: 'hats', 41: 'hair', 42: 'face', 43: 'neck', 44: 'shoulder', 45: 'front', 46: 'back', 47: 'waist',
  11: 'shirts', 12: 'pants', 2: 'tshirts', 18: 'faces', 17: 'heads', 27: 'torsos', 28: 'rightarms',
  29: 'leftarms', 30: 'leftlegs', 31: 'rightlegs', 19: 'gear',
};
const ASSET_TYPE_NAMES = Object.fromEntries(Object.entries(TYPE_NAMES).map(([name, id]) => [id, name]));
const RULES = {
  playerAvatarTypes: ['R6', 'R15'],
  scales: {
    height: { min: 0.95, max: 1.05, increment: 0.01 },
    width: { min: 0.7, max: 1, increment: 0.01 },
    depth: { min: 0.7, max: 1, increment: 0.01 },
    head: { min: 0.95, max: 1, increment: 0.01 },
  },
  wearableAssetTypes: Object.entries(TYPE_NAMES).map(([name, id]) => ({ maxNumber: id === 8 ? 3 : 1, id, name })),
  bodyColorsPalette: [],
  basicBodyColorsPalette: [],
  minimumDeltaEBodyColorDifference: 0,
  proportionsAndBodyTypeEnabledForUser: false,
  defaultClothingAssetLists: { defaultShirtAssetIds: [], defaultPantAssetIds: [] },
};

module.exports = function mobileAvatar({ send, sendJson, launcher }) {
  const ok = (ctx) => sendJson(ctx, 200, { success: true });
  const nope = (ctx, message) => sendJson(ctx, 200, { success: false, message });
  const viewer = (ctx) => accounts.fromRequest(ctx.req);

  async function jsonBody(ctx) {
    try {
      const text = (await ctx.body(64 * 1024)).toString('utf8');
      const data = JSON.parse(text || '{}');
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      return {};
    }
  }

  async function avatar(ctx) {
    const who = viewer(ctx);
    if (!who) return sendJson(ctx, 200, { errors: [{ code: 0, message: 'Not signed in.' }] });
    const saved = await launcher.describeAvatar(who);
    const bodyColors = {};
    for (const [field, key] of Object.entries(COLOR_FIELDS)) bodyColors[field] = saved.bodyColors[key];
    sendJson(ctx, 200, {
      scales: { height: 1, width: 1, head: 1, depth: 1 },
      playerAvatarType: 'R6',
      bodyColors,
      assets: saved.assets.map((asset) => ({
        id: Number(asset.id), name: asset.name, assetType: { id: asset.typeId, name: ASSET_TYPE_NAMES[asset.typeId] || '' },
      })),
      defaultShirtApplied: false,
      defaultPantsApplied: false,
    });
  }

  async function setBodyColors(ctx) {
    const who = viewer(ctx);
    if (!who) return nope(ctx, 'Not signed in.');
    const body = await jsonBody(ctx);
    const colors = {};
    for (const [field, key] of Object.entries(COLOR_FIELDS)) {
      if (Number.isInteger(body[field])) colors[key] = body[field];
    }
    const result = await launcher.saveAvatarParts(who, { bodyColors: colors });
    return result.ok ? ok(ctx) : nope(ctx, result.error);
  }

  async function setWearing(ctx) {
    const who = viewer(ctx);
    if (!who) return nope(ctx, 'Not signed in.');
    const body = await jsonBody(ctx);
    const ids = Array.isArray(body.assetIds) ? body.assetIds : [];
    const result = await launcher.saveAvatarParts(who, { assetIds: ids });
    return result.ok ? ok(ctx) : nope(ctx, result.error);
  }

  // Scales and R6/R15: accepted, not kept (see above).
  async function accepted(ctx) {
    await jsonBody(ctx);
    return viewer(ctx) ? ok(ctx) : nope(ctx, 'Not signed in.');
  }

  function pageOf(ctx, list) {
    const size = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(ctx.queryLower.itemsperpage) || 24));
    const number = Math.max(1, Number(ctx.queryLower.pagenumber || ctx.queryLower.page) || 1);
    return list.slice((number - 1) * size, number * size);
  }

  async function inventory(ctx, match) {
    const owner = accounts.byUserId(match[1]);
    const typeId = TYPE_NAMES[match[2]];
    if (!owner || !typeId) return sendJson(ctx, 200, { data: [] });
    const items = await launcher.shop.inventory(owner.userId, TYPE_CATEGORY[typeId]);
    sendJson(ctx, 200, { data: pageOf(ctx, items.filter((item) => item.typeId === typeId).map((item) => Number(item.id))) });
  }

  // Outfits: only your own (the launcher saves them; outfit IDs are 12 hex digits).
  function outfitList(ctx, match) {
    const who = viewer(ctx);
    if (!who || String(who.userId) !== String(Number(match[1]))) return sendJson(ctx, 200, { data: [], total: 0 });
    const mine = outfits.list(who.userId);
    sendJson(ctx, 200, { data: pageOf(ctx, mine.map((outfit) => ({ id: outfit.id, name: outfit.name, isEditable: true }))), total: mine.length });
  }

  function outfitDetails(ctx, match) {
    const who = viewer(ctx);
    const outfit = who ? outfits.get(who.userId, match[1]) : null;
    if (!outfit) return sendJson(ctx, 200, { errors: [{ code: 1, message: 'No such outfit.' }] });
    const bodyColors = {};
    for (const [field, key] of Object.entries(COLOR_FIELDS)) bodyColors[field] = outfit.bodyColors[key];
    sendJson(ctx, 200, {
      id: outfit.id, name: outfit.name, bodyColors, playerAvatarType: 'R6', isEditable: true,
      scale: { height: 1, width: 1, head: 1, depth: 1 },
      assets: outfit.assets.map((asset) => ({ id: Number(asset.id), name: asset.name || '' })),
    });
  }

  function outfitImage(ctx) {
    const who = viewer(ctx);
    const id = String(ctx.queryLower.useroutfitid || '');
    const file = who ? outfits.imagePath(who.userId, id) : null;
    if (!file) return send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'No picture');
    let bytes;
    try {
      bytes = require('fs').readFileSync(file);
    } catch (error) {
      return send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'No picture');
    }
    send(ctx, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60' }, bytes);
  }

  const post = (handler) => (ctx, match) => (ctx.method === 'POST' ? handler(ctx, match) : sendJson(ctx, 405, { success: false }));

  return {
    routes: [
      [/^v1\/avatar-rules\/?$/i, (ctx) => sendJson(ctx, 200, RULES)],
      [/^v1\/avatar\/?$/i, avatar],
      [/^v1\/avatar\/set-body-colors\/?$/i, post(setBodyColors)],
      [/^v1\/avatar\/set-wearing-assets\/?$/i, post(setWearing)],
      [/^v1\/avatar\/(?:set-scales|set-player-avatar-type)\/?$/i, post(accepted)],
      [/^v1\/users\/(\d{1,15})\/inventory\/([A-Za-z]{1,40})\/?$/i, inventory],
      [/^v1\/users\/(\d{1,15})\/outfits\/?$/i, outfitList],
      [/^v1\/outfits\/([0-9a-f]{12})\/details\/?$/i, outfitDetails],
      [/^outfit-thumbnail\/image\/?$/i, outfitImage],
    ],
  };
};
