'use strict';

// Place file converter: makes a place or model saved by a newer Roblox Studio
// load in the 2017 client and RCC. XML files only (.rbxlx / .rbxmx); a binary
// .rbxl has to be saved as .rbxlx from Studio first (File > Save As).
//
// What it changes:
//   - asset addresses: roblox.com and assetdelivery links become
//     rbxassetid://, rbxthumb:// becomes the web server's thumbnail routes,
//     and rbxgameasset:// becomes a lookup in the game's universe (when the
//     universe is known)
//   - value types the 2017 engine cannot read: ContentId becomes Content,
//     FontFace becomes the old Font list, MeshContent/TextureContent/
//     ImageContent fill MeshId/TextureID/Image when those are missing, and
//     SharedString, UniqueId, SecurityCapabilities, OptionalCoordinateFrame,
//     int64, NetAssetRef and attributes are removed
//   - scripts: task.wait/spawn/delay/defer become wait/spawn/delay, and
//     simple compound assignments (x += 1) are written out; Lua 5.1 has
//     neither
// What it reports but cannot fix: classes the 2017 engine does not have,
// unions saved in the newer CSG format, and Luau-only script syntax
// (continue, type annotations, `interpolated strings`, if-expressions).

const fs = require('fs');
const path = require('path');
const luacompat = require('./luacompat');
const unionshapes = require('./unionshapes');

const LOCAL = 'http://localhost./';
const API_DUMP = path.join(__dirname, '..', '..', '..', 'Client', 'apidump.txt');

// --- XML text ----------------------------------------------------------------

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function xmlUnescape(text) {
  return text.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (match, entity) => {
    if (NAMED_ENTITIES[entity.toLowerCase()] !== undefined) return NAMED_ENTITIES[entity.toLowerCase()];
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code < 256 ? String.fromCharCode(code) : match;
  });
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Asset addresses ---------------------------------------------------------------

function thumbParams(url) {
  const params = {};
  for (const part of url.replace(/^rbxthumb:\/\//i, '').split('&')) {
    const split = part.indexOf('=');
    if (split > 0) params[part.slice(0, split).toLowerCase()] = part.slice(split + 1);
  }
  return params;
}

// The address the 2017 engine can load for `url`, or null to leave it.
function convertUrl(url, options, counts) {
  const trimmed = url.trim();
  let match = /^https?:\/\/(?:www\.|web\.)?roblox\.com\/+asset\/?\?(?:[^#]*?&)?id=(\d+)/i.exec(trimmed)
    || /^https?:\/\/assetdelivery\.roblox\.com\/v1\/asset\/?\?(?:[^#]*?&)?id=(\d+)/i.exec(trimmed);
  if (match) {
    counts.robloxLinks++;
    return `rbxassetid://${match[1]}`;
  }
  if (/^rbxthumb:\/\//i.test(trimmed)) {
    const p = thumbParams(trimmed);
    const id = /^\d+$/.test(p.id || '') ? p.id : null;
    const w = /^\d+$/.test(p.w || '') ? p.w : '420';
    const h = /^\d+$/.test(p.h || '') ? p.h : w;
    const type = (p.type || '').toLowerCase();
    if (id !== null && type === 'asset') {
      counts.thumbnails++;
      return `${LOCAL}Game/Tools/ThumbnailAsset.ashx?fmt=png&wd=${w}&ht=${h}&aid=${id}`;
    }
    if (id !== null && (type === 'avatar' || type === 'avatarbust')) {
      counts.thumbnails++;
      return `${LOCAL}Thumbs/Avatar.ashx?x=${w}&y=${h}&userId=${id}`;
    }
    if (id !== null && type === 'avatarheadshot') {
      counts.thumbnails++;
      return `${LOCAL}Thumbs/HeadShot.ashx?x=${w}&y=${h}&userId=${id}`;
    }
    counts.unsupportedThumbnails.add(p.type || '?');
    return null;
  }
  match = /^rbxgameasset:\/\/(.+)$/i.exec(trimmed);
  if (match) {
    counts.gameAssetNames.add(match[1]);
    if (!options.universeId) return null;
    counts.gameAssets++;
    return `${LOCAL}asset/?universeId=${options.universeId}&assetName=${encodeURIComponent(match[1])}`;
  }
  return null;
}

// --- Fonts -------------------------------------------------------------------

// Font family file -> 2017 Font enum (Legacy 0, Arial 1, ArialBold 2,
// SourceSans 3, SourceSansBold 4, SourceSansLight 5, SourceSansItalic 6,
// Bodoni 7, Garamond 8, Cartoon 9, Code 10, Highway 11, SciFi 12, Arcade 13,
// Fantasy 14, Antique 15). Families the 2017 engine never had become Source Sans.
const FONT_FAMILIES = {
  legacyarial: 0, accanthisadfstd: 7, guru: 8, comicneueangular: 9, inconsolata: 10,
  highwaygothic: 11, zekton: 12, pressstart2p: 13, balthazar: 14, romanantique: 15,
};

function fontEnum(fontXml) {
  const family = /<Family>\s*<url>([^<]*)<\/url>/i.exec(fontXml);
  const name = family ? path.basename(family[1].trim(), '.json').toLowerCase() : '';
  const weight = parseInt((/<Weight>(\d+)<\/Weight>/i.exec(fontXml) || [])[1] || '400', 10);
  const italic = /<Style>\s*Italic\s*<\/Style>/i.test(fontXml);
  if (FONT_FAMILIES[name] !== undefined) return FONT_FAMILIES[name];
  if (name === 'arial') return weight >= 600 ? 2 : 1;
  if (weight >= 600) return 4;
  if (italic) return 6;
  if (weight <= 300) return 5;
  return 3;
}

// --- Scripts -----------------------------------------------------------------

// Target: a name with fields and one-level indexes (t[k].x, s[a.b][c.d].n).
const COMPOUND = /^(\s*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^[\]\n]+\])*)\s*(\/\/|\.\.|[-+*/%^])=\s*(.+?)\s*$/;

// "x += expr -- note" -> "x = x + (expr) -- note"; null when it is not that
// simple (string quotes, a second statement, a long comment).
function expandCompound(line) {
  const match = COMPOUND.exec(line);
  if (!match) return null;
  const [, indent, target, op] = match;
  let expr = match[4];
  let comment = '';
  const dash = expr.indexOf('--');
  if (dash >= 0) {
    const before = expr.slice(0, dash);
    if ((before.split('"').length - 1) % 2 !== 0 || (before.split("'").length - 1) % 2 !== 0) return null;
    comment = ` ${expr.slice(dash)}`;
    expr = before.trim();
  }
  if (expr === '' || expr.includes(';') || expr.includes('[[') || /(^|[^=~<>])=($|[^=])/.test(expr)) return null;
  if (op === '//') return `${indent}${target} = math.floor(${target} / (${expr}))${comment}`;
  return `${indent}${target} = ${target} ${op} (${expr})${comment}`;
}

const LUAU_CHECKS = [
  ['continue', /(?:^|\bthen|\bdo|\belse|;)[ \t]*continue[ \t]*(?:end\b|;|--|$)/m],
  ['type annotations', /^\s*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=|\blocal\s+\w+\s*:\s*[A-Za-z{(]|\bfunction\b[^(\n]*\([^)\n]*\w\s*:\s*[A-Za-z{(]/m],
  ['`interpolated strings`', /`[^`\n]*\{[^`\n]*\}[^`\n]*`/],
  ['if-then-else expressions', /(?:=|return|\()\s*if\s+[^\n]+\bthen\b[^\n]+\belse\b/],
  ['task.cancel/task.synchronize', /\btask\.(?:cancel|synchronize|desynchronize)\b/],
];

function convertScript(source, counts, scriptName) {
  let text = source;
  let changed = false;
  if (!/\blocal\s+task\b|\bfunction\s+task\b|^\s*task\s*=/m.test(text)) {
    text = text.replace(/\btask\.(wait|spawn|delay|defer)(\s*\()/g, (match, name, paren) => {
      counts.taskCalls++;
      changed = true;
      return (name === 'defer' ? 'spawn' : name) + paren;
    });
  }
  // Line by line, outside long strings and long comments.
  const lines = text.split('\n');
  let inLong = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const startsLong = /\[=*\[/.test(line);
    if (!inLong) {
      const expanded = expandCompound(line);
      if (expanded !== null && !startsLong) {
        lines[i] = expanded + (lines[i].endsWith('\r') ? '\r' : '');
        counts.compoundAssignments++;
        changed = true;
      }
    }
    if (inLong) {
      if (/\]=*\]/.test(line)) inLong = false;
    } else if (startsLong && !/\[=*\[[\s\S]*\]=*\]/.test(line)) {
      inLong = true;
    }
  }
  if (changed) text = lines.join('\n');
  // Functions and features newer than 2017 (lib/luacompat.js).
  const compat = luacompat.convertSource(text);
  if (compat.changes.length > 0) {
    text = compat.text;
    changed = true;
    counts.compatScripts++;
    for (const change of compat.changes) counts.compatChanges.set(change, (counts.compatChanges.get(change) || 0) + 1);
  }
  const found = LUAU_CHECKS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (found.length > 0) counts.luauScripts.push(`${scriptName}: ${found.join(', ')}`);
  return changed ? text : null;
}

// --- Properties ----------------------------------------------------------------

const DROPPED_TYPES = ['OptionalCoordinateFrame', 'UniqueId', 'SecurityCapabilities', 'NetAssetRef', 'SharedString', 'int64'];
// Each removal takes the line break and indent before it, so the file keeps its layout.
const LEAD = '(?:\\r?\\n[ \\t]*)?';
const DROPPED_PROPERTY = new RegExp(`${LEAD}<(${DROPPED_TYPES.join('|')})\\s+name="[^"]*"\\s*(?:/>|>[\\s\\S]*?</\\1>)`, 'g');
// Content properties by the names the 2017 engine reads (tested in it: under
// any other name the value is ignored, so decals, sounds, animations and
// mesh textures were blank). Newer files use ...Content names; places
// converted before this used TextureID for every class, fixed here too.
const IMAGE_NAMES = { TextureContent: 'Texture', TextureID: 'Texture', TextureId: 'Texture' };
const MESH_NAMES = { MeshContent: 'MeshId', MeshID: 'MeshId', TextureContent: 'TextureId', TextureID: 'TextureId' };
const TOOL_NAMES = { TextureContent: 'TextureId', TextureID: 'TextureId' };
const CONTENT_NAMES = {
  Decal: IMAGE_NAMES, Texture: IMAGE_NAMES, ParticleEmitter: IMAGE_NAMES, Trail: IMAGE_NAMES, Beam: IMAGE_NAMES,
  SpecialMesh: MESH_NAMES, FileMesh: MESH_NAMES,
  MeshPart: { MeshContent: 'MeshId', TextureContent: 'TextureID' },
  Tool: TOOL_NAMES, HopperBin: TOOL_NAMES,
  Sound: { AudioContent: 'SoundId', SoundContent: 'SoundId' },
  Animation: { AnimationContent: 'AnimationId' },
  Shirt: { ShirtTemplateContent: 'ShirtTemplate' },
  Pants: { PantsTemplateContent: 'PantsTemplate' },
  ShirtGraphic: { GraphicContent: 'Graphic', TextureID: 'Graphic', TextureContent: 'Graphic' },
  Sky: {
    SkyboxBackContent: 'SkyboxBk', SkyboxDownContent: 'SkyboxDn', SkyboxFrontContent: 'SkyboxFt',
    SkyboxLeftContent: 'SkyboxLf', SkyboxRightContent: 'SkyboxRt', SkyboxUpContent: 'SkyboxUp',
  },
  ScrollingFrame: { TopImageContent: 'TopImage', MidImageContent: 'MidImage', BottomImageContent: 'BottomImage', ImageContent: 'Image' },
  ImageLabel: { ImageContent: 'Image' },
  ImageButton: { ImageContent: 'Image', HoverImageContent: 'HoverImage', PressedImageContent: 'PressedImage' },
  // Newer unions name their geometry asset "Content"; 2017 reads AssetId.
  UnionOperation: { Content: 'AssetId' }, NegateOperation: { Content: 'AssetId' },
};
const OTHER_NAMES = { MeshContent: 'MeshId', TextureContent: 'TextureID', ImageContent: 'Image' };

// CharacterMesh IDs are plain numbers in 2017 (<int>); newer files use int64
// (dropped below) or Content for the textures.
const CHARACTER_MESH_IDS = { MeshId: 'MeshId', BaseTextureId: 'BaseTextureId', OverlayTextureId: 'OverlayTextureId', BaseTextureContent: 'BaseTextureId', OverlayTextureContent: 'OverlayTextureId', MeshContent: 'MeshId' };

// Unions about this full of their box get box collision when no shape could
// be made from their mesh (see convertProperties).
const BOX_COLLISION_FILL = 0.75;

// Part materials the 2017 engine lacks (newer, or terrain-only) -> nearest it has.
const MATERIALS_2017 = new Set([256, 272, 288, 512, 528, 784, 800, 816, 832, 848, 864, 880, 1040, 1056, 1072, 1088, 1280, 1296, 1312, 1536]);
const MATERIAL_MAP = {
  788: 800, 804: 800, 820: 816, 836: 816, 896: 800, 912: 1296, 1284: 1280, 1328: 1296, 1344: 1296, 1360: 1296,
  1376: 816, 1392: 1296, 1552: 1536, 1568: 272, 1584: 272,
};
function material2017(value) {
  const n = Number(value);
  if (MATERIALS_2017.has(n)) return n;
  return MATERIAL_MAP[n] !== undefined ? MATERIAL_MAP[n] : 256;
}
const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);

function convertProperties(className, props, options, counts) {
  let out = props;

  // 2017 unions carry their geometry in ChildData/MeshData or load it from
  // AssetId; newer ones keep it only in shared strings (ChildData2/MeshData2).
  if ((className === 'UnionOperation' || className === 'NegateOperation')
    && /<SharedString\s+name="(?:ChildData2|MeshData2)">/.test(out)
    && !/<BinaryString\s+name="ChildData">\s*[^<\s]/.test(out)
    && !/<Content\s+name="(?:AssetId|Content)">\s*<url>[^<]*\d/.test(out)) {
    counts.newCsg++;
  }

  // Union collision. The 2017 engine loads a union's asset only to draw it;
  // collision comes from its PhysicsData, which newer files keep elsewhere
  // (PhysicalConfigData, a format 2017 cannot read) and 2017-era copies
  // often lack: such unions are drawn but walked and fallen through. They get
  // a shape made from their mesh (options.unionShapes, lib/unionshapes.js),
  // as does a union an earlier conversion gave a box although it is not one.
  // Without a shape, a union about as full as its box (UnscaledVolume /
  // InitialSize) gets box collision ("CSGPHS" version 0 BLOCK): exact for the
  // many unions newer Studio already gives box collision (volume = box).
  if (className === 'UnionOperation') {
    const info = unionshapes.unionInfo(out);
    const shape = options.unionShapes && unionshapes.wantsShape(info) ? options.unionShapes.get(info.assetId) : undefined;
    const physics = shape || (info.physics === '' && info.fill !== null && info.fill >= BOX_COLLISION_FILL ? unionshapes.BLOCK_PHYSICS : null);
    if (physics) {
      out = out.replace(/(?:\r?\n[ \t]*)?<BinaryString\s+name="PhysicsData">[^<]*<\/BinaryString>/, '');
      out = out.replace(/(\r?\n[ \t]*)?(<\/?[A-Za-z]+[\s>])/, (match, lead, tag) => `${lead || ''}<BinaryString name="PhysicsData">${physics}</BinaryString>${lead || ''}${tag}`);
      if (shape) counts.unionShapes++;
      else counts.unionCollision++;
    }
  }

  // FilteringEnabled. Newer files leave it out (it is always on now) and the
  // 2017 engine then runs the game with it off: every player's local changes
  // (a menu script moving the lobby, a gun's effects) reach the server and
  // all the other players. Games made since 2018 expect it on. Files from a
  // 2017-era Studio always have it and keep their setting.
  if (className === 'Workspace' && !/<bool\s+name="FilteringEnabled">/.test(out)) {
    const before = out;
    out = out.replace(/(\r?\n[ \t]*)?(<\/?[A-Za-z]+[\s>])/, (match, lead, tag) => `${lead || ''}<bool name="FilteringEnabled">true</bool>${lead || ''}${tag}`);
    if (out !== before) counts.filteringEnabled++;
  }

  // ContentId (2024) is the old Content type renamed.
  out = out.replace(/<ContentId(\s[^>]*)>([\s\S]*?)<\/ContentId>/g, (match, attrs, body) => {
    counts.contentIds++;
    return `<Content${attrs}>${body}</Content>`;
  });
  // Content that points at an object rather than an address: nothing to load.
  out = out.replace(/(?:\r?\n[ \t]*)?<Content\s+name="[^"]*">\s*<(?:Ref|Object)>[\s\S]*?<\/(?:Ref|Object)>\s*<\/Content>/g, () => {
    counts.droppedProperties++;
    return '';
  });
  // <uri> is the newer spelling of <url>; then fix the address itself.
  out = out.replace(/<(url|uri)>([^<]*)<\/\1>/g, (match, tag, value) => {
    const converted = convertUrl(xmlUnescape(value), options, counts);
    if (converted === null) {
      if (tag === 'url') return match;
      counts.contentIds++;
      return `<url>${value}</url>`;
    }
    return `<url>${xmlEscape(converted)}</url>`;
  });
  // Property names the 2017 engine reads. When both names are there, the
  // one 2017 reads is kept and the other dropped.
  const names = CONTENT_NAMES[className] || OTHER_NAMES;
  for (const [from, to] of Object.entries(names)) {
    const fromTag = new RegExp(`(?:\\r?\\n[ \\t]*)?<Content\\s+name="${from}">[\\s\\S]*?<\\/Content>`);
    if (!fromTag.test(out)) continue;
    counts.contentIds++;
    if (new RegExp(`<Content\\s+name="${to}">`).test(out)) out = out.replace(fromTag, '');
    else out = out.replace(new RegExp(`<Content\\s+name="${from}">`), `<Content name="${to}">`);
  }
  if (className === 'CharacterMesh') {
    out = out.replace(/<(int64|int|Content)\s+name="(\w+)">([\s\S]*?)<\/\1>/g, (match, type, name, body) => {
      const to = CHARACTER_MESH_IDS[name];
      if (!to) return match;
      const id = type === 'Content' ? (/rbxassetid:\/\/(\d+)|[?&]id=(\d+)/i.exec(body) || []).slice(1).find(Boolean) : body.trim();
      if (type === 'int' && to === name) return match;
      counts.contentIds++;
      return /^\d{1,10}$/.test(String(id || '')) && Number(id) <= 2147483647 ? `<int name="${to}">${id}</int>` : '';
    });
  }
  out = out.replace(/<token\s+name="Material">(\d+)<\/token>/, (match, value) => {
    const mapped = material2017(value);
    if (mapped === Number(value)) return match;
    counts.materials++;
    return `<token name="Material">${mapped}</token>`;
  });

  // FontFace -> Font; a Font past the 2017 list (0-15) takes the FontFace's.
  const face = /<Font\s+name="FontFace">([\s\S]*?)<\/Font>/.exec(out);
  out = out.replace(/<token\s+name="Font">(\d+)<\/token>/, (match, value) => {
    if (Number(value) <= 15) return match;
    counts.fonts++;
    return `<token name="Font">${face ? fontEnum(face[1]) : 3}</token>`;
  });
  out = out.replace(/(\r?\n[ \t]*)?<Font\s+name="FontFace">([\s\S]*?)<\/Font>/g, (match, lead, body) => {
    counts.fonts++;
    if (/<token\s+name="Font">/.test(out)) return '';
    return `${lead || ''}<token name="Font">${fontEnum(body)}</token>`;
  });

  out = out.replace(DROPPED_PROPERTY, () => {
    counts.droppedProperties++;
    return '';
  });
  out = out.replace(/(?:\r?\n[ \t]*)?<BinaryString\s+name="AttributesSerialize">[\s\S]*?<\/BinaryString>/g, (match) => {
    if (!/<BinaryString\s+name="AttributesSerialize">\s*<\/BinaryString>/.test(match)) counts.attributes++;
    return '';
  });

  if (SCRIPT_CLASSES.has(className)) {
    const name = xmlUnescape((/<string\s+name="Name">([^<]*)<\/string>/.exec(out) || [])[1] || className);
    out = out.replace(/(<ProtectedString\s+name="Source">)([\s\S]*?)(<\/ProtectedString>)/, (match, open, body, close) => {
      const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(body);
      if (cdata && !cdata[1].includes(']]>')) {
        const converted = convertScript(cdata[1], counts, name);
        return converted === null ? match : `${open}<![CDATA[${converted}]]>${close}`;
      }
      if (body.includes('<![CDATA[')) return match;
      const converted = convertScript(xmlUnescape(body), counts, name);
      return converted === null ? match : `${open}${xmlEscape(converted).replace(/\r/g, '&#13;')}${close}`;
    });
  }
  return out;
}

// --- Whole file ------------------------------------------------------------------

let knownClasses = null;
function classesOf2017() {
  if (knownClasses === null) {
    knownClasses = new Set();
    try {
      for (const match of fs.readFileSync(API_DUMP, 'latin1').matchAll(/^Class (\w+)/gm)) knownClasses.add(match[1]);
    } catch (error) {
      knownClasses = null;
      return null;
    }
  }
  return knownClasses;
}

// Part classes of the 2017 engine: BasePart and every class under it (API
// dump), or the usual ones when the dump is missing.
let partClasses = null;
function partClassesOf2017() {
  if (partClasses === null) {
    const parents = new Map();
    try {
      for (const match of fs.readFileSync(API_DUMP, 'latin1').matchAll(/^Class (\w+)(?: : (\w+))?/gm)) parents.set(match[1], match[2] || null);
    } catch (error) { /* the usual ones below */ }
    partClasses = new Set();
    for (const name of parents.keys()) {
      for (let c = name; c; c = parents.get(c)) {
        if (c === 'BasePart') { partClasses.add(name); break; }
      }
    }
    if (partClasses.size === 0) {
      for (const name of ['Part', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'MeshPart', 'UnionOperation', 'NegateOperation',
        'SpawnLocation', 'Seat', 'VehicleSeat', 'SkateboardPlatform', 'Terrain']) partClasses.add(name);
    }
  }
  return partClasses;
}

// Objects the 2017 engine allows only under certain parents. It refuses the
// whole place when one is elsewhere ("Attachments must be parented by a
// PartInstance", "team must be a child of the Teams service"), and newer
// Studio allows more (an attachment inside another, e.g. in R15 rigs). Such
// an object becomes a Folder of the same name, so the place loads and
// scripts still find it; its children stay in it.
function misplaced(className, parentClass) {
  if (className === 'Attachment') return !partClassesOf2017().has(parentClass);
  if (className === 'Team') return parentClass !== 'Teams';
  return false;
}

// Newer chat. A place may carry its own copy of Roblox's chat system in the
// Chat service; newer copies (since about 2019, recognisable by their
// ChatLocalization) need what 2017 lacks (if-then-else expressions, utf8,
// LocalizationService, VoiceChatService), so the game had no working chat.
// The Chat service's own children are then set aside (renamed, scripts
// disabled), and the 2017 server installs its own chat, as for any game
// without a copy. Older or partial copies (e.g. only ChatSettings) stay.
function hasNewerChat(input) {
  const open = [];
  for (const piece of pieces(input)) {
    const text = piece.toString('latin1');
    for (const match of text.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<Item\s+class="([^"]+)"[^>]*>|<\/Item>|<string\s+name="Name">([^<]*)<\/string>/g)) {
      if (match[0].startsWith('<![')) continue;
      if (match[1] !== undefined) { open.push({ className: match[1], named: false }); continue; }
      if (match[0] === '</Item>') { open.pop(); continue; }
      const top = open[open.length - 1];
      if (!top || top.named) continue;
      top.named = true;
      if (match[2] === 'ChatLocalization' && open.some((item) => item.className === 'Chat')) return true;
    }
  }
  return false;
}

// A copy of Roblox's own UI scripts (TopBar, Modules.PlayerlistModule,
// BackpackScript...) that place-saving tools took from CoreGui and put in
// StarterGui as a ScreenGui named RobloxGui. On Roblox these never ran from
// there; on 2017 they would run as the game's own scripts, next to the 2017
// topbar, backpack and player list (twice of each, and the newer copies
// fail). -> the referents of that ScreenGui and everything in it.
function dumpedCoreGui(input) {
  const open = [];
  const found = new Set();
  for (const piece of pieces(input)) {
    const text = piece.toString('latin1');
    for (const match of text.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<Item\s+class="([^"]+)"([^>]*)>|<\/Item>|<string\s+name="Name">([^<]*)<\/string>/g)) {
      if (match[0].startsWith('<![')) continue;
      if (match[1] !== undefined) {
        const referent = (/referent="([^"]+)"/.exec(match[2]) || [])[1];
        const owner = open.find((item) => item.candidate);
        if (owner && referent) owner.inside.push(referent);
        open.push({ className: match[1], referent, named: false, candidate: false, inside: [], core: false });
        continue;
      }
      if (match[0] === '</Item>') {
        const item = open.pop();
        if (item && item.candidate && item.core) {
          found.add(item.referent);
          for (const referent of item.inside) found.add(referent);
        }
        continue;
      }
      const top = open[open.length - 1];
      if (!top || top.named) continue;
      top.named = true;
      const parent = open[open.length - 2];
      if (top.className === 'ScreenGui' && match[3] === 'RobloxGui' && parent && parent.className === 'StarterGui' && top.referent) top.candidate = true;
      if (parent && parent.candidate && ['Modules', 'TopBar', 'CoreScripts'].includes(match[3])) parent.core = true;
    }
  }
  return found;
}

// Localization tables. Newer games get their text through
// LocalizationTable:GetTranslator(locale):FormatByKey(key) (2018); the 2017
// engine has no GetTranslator, and its clients do not even get the tables
// (LocalizationService's contents), so games like Jailbreak stopped loading
// their shops and menus. Each table's English text goes into a ModuleScript
// in ReplicatedStorage (LOCALIZATION_FOLDER), which the GetTranslator
// stand-in of lib/luacompat.js reads.
const LOCALIZATION_FOLDER = 'LocalizationTables (2017)';

function localizationTables(input) {
  const tables = new Map(); // name -> { key: English text }
  let present = false;
  for (const piece of pieces(input)) {
    const text = piece.toString('latin1');
    if (text.includes(`<string name="Name">${LOCALIZATION_FOLDER}</string>`)) present = true;
    for (const match of text.matchAll(/<Item\s+class="LocalizationTable"[^>]*>\s*<Properties>([\s\S]*?)<\/Properties>/g)) {
      const name = xmlUnescape((/<string\s+name="Name">([^<]*)<\/string>/.exec(match[1]) || [])[1] || '');
      const contents = /<string\s+name="Contents">([\s\S]*?)<\/string>/.exec(match[1]);
      if (!name || !contents || tables.has(name)) continue;
      let entries;
      try {
        entries = JSON.parse(xmlUnescape(contents[1]));
      } catch (error) {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      const strings = {};
      for (const entry of entries) {
        if (entry && typeof entry.key === 'string' && entry.key !== '' && typeof entry.source === 'string') strings[entry.key] = entry.source;
      }
      if (Object.keys(strings).length > 0) tables.set(name, strings);
    }
  }
  return present ? new Map() : tables;
}

// A Lua string literal of text whose characters below 256 are bytes (the
// file is read as Latin-1, so UTF-8 text arrives as its bytes).
function luaString(text) {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0);
    const bytes = code > 255 ? [...Buffer.from(char, 'utf8')] : [code];
    for (const b of bytes) {
      if (b === 0x5c) out += '\\\\';
      else if (b === 0x22) out += '\\"';
      else if (b === 0x0a) out += '\\n';
      else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
      else out += `\\${String(b).padStart(3, '0')}`;
    }
  }
  return `${out}"`;
}

// The folder of ModuleScripts (XML Items) for ReplicatedStorage.
function localizationFolder(tables) {
  let n = 0;
  const modules = [...tables].map(([name, strings]) => {
    const source = `return {\n${Object.entries(strings).map(([key, value]) => `[${luaString(key)}] = ${luaString(value)},`).join('\n')}\n}\n`;
    n++;
    return `<Item class="ModuleScript" referent="RBX2017LOCALIZATION${n}"><Properties><string name="Name">${xmlEscape(name)}</string>`
      + `<ProtectedString name="Source">${xmlEscape(source)}</ProtectedString></Properties></Item>`;
  });
  return `<Item class="Folder" referent="RBX2017LOCALIZATION0"><Properties><string name="Name">${LOCALIZATION_FOLDER}</string></Properties>${modules.join('')}</Item>`;
}

// PlayerModule. Newer Roblox gives every player a PlayerModule (camera and
// controls) in PlayerScripts, and games use it, e.g. Jailbreak's cars read
// PlayerModule.ControlModule:GetMoveVector(); the 2017 engine has its own
// camera and control scripts and no PlayerModule, so such modules stopped
// loading. A game whose scripts look for one gets a stand-in in
// StarterPlayerScripts: GetMoveVector from the keys (WASD, arrows) and the
// gamepad's left stick, the rest doing nothing (2017's controls stay).
const PLAYER_MODULE = String.raw`-- Stand-in for the PlayerModule of newer Roblox (added by the 2017 converter).
local PlayerModule = {}
function PlayerModule:GetControls() return require(script.ControlModule) end
function PlayerModule:GetCameras() return require(script.CameraModule) end
return PlayerModule
`;
const CONTROL_MODULE = String.raw`-- Stand-in ControlModule (added by the 2017 converter): the move input only.
local UserInputService = game:GetService("UserInputService")
local Controls = {}
local function down(a, b) return UserInputService:IsKeyDown(a) or UserInputService:IsKeyDown(b) end
function Controls:GetMoveVector()
	local focused = false
	pcall(function() focused = UserInputService:GetFocusedTextBox() ~= nil end)
	if focused then return Vector3.new() end
	local x, z = 0, 0
	if down(Enum.KeyCode.W, Enum.KeyCode.Up) then z = z - 1 end
	if down(Enum.KeyCode.S, Enum.KeyCode.Down) then z = z + 1 end
	if down(Enum.KeyCode.A, Enum.KeyCode.Left) then x = x - 1 end
	if down(Enum.KeyCode.D, Enum.KeyCode.Right) then x = x + 1 end
	pcall(function()
		for _, input in ipairs(UserInputService:GetGamepadState(Enum.UserInputType.Gamepad1)) do
			if input.KeyCode == Enum.KeyCode.Thumbstick1 and input.Position.Magnitude > 0.2 then x, z = input.Position.X, -input.Position.Y end
		end
	end)
	return Vector3.new(x, 0, z)
end
function Controls:GetIsJumping() return UserInputService:IsKeyDown(Enum.KeyCode.Space) end
function Controls:GetActiveController() return nil end
function Controls:Enable() end
function Controls:Disable() end
return Controls
`;

function needsPlayerModule(input) {
  let used = false;
  for (const piece of pieces(input)) {
    const text = piece.toString('latin1');
    if (text.includes('<string name="Name">PlayerModule</string>')) return false;
    if (!used && /PlayerModule/.test(text)) used = /(?:WaitForChild|FindFirstChild)\(\s*(?:&quot;|")PlayerModule(?:&quot;|")|\.PlayerModule\b/.test(text);
  }
  return used;
}

function playerModuleItems() {
  const module = (name, source, children = '') => `<Item class="ModuleScript" referent="RBX2017PLAYERMODULE${name}"><Properties><string name="Name">${name}</string>`
    + `<ProtectedString name="Source">${xmlEscape(source)}</ProtectedString></Properties>${children}</Item>`;
  return module('PlayerModule', PLAYER_MODULE, module('ControlModule', CONTROL_MODULE) + module('CameraModule', 'return {}\n'));
}

function setAside(props) {
  let out = props.replace(/(<string\s+name="Name">)([^<]*)(<\/string>)/, (match, open, name, close) => `${open}${name} (newer, unused)${close}`);
  out = out.replace(/<bool\s+name="Disabled">false<\/bool>/, '<bool name="Disabled">true</bool>');
  return out;
}

// input: Buffer of an .rbxlx/.rbxmx. options.universeId: the Roblox universe
// the place came from, for rbxgameasset:// names.
// -> { output: Buffer, counts, summary: [lines] }
function convertPlace(input, options) {
  options = options || {};
  const head = input.subarray(0, 16).toString('latin1');
  if (head.startsWith('<roblox!')) {
    throw new Error('This is a binary place file (.rbxl). Open it in Roblox Studio and use File > Save As to save it as .rbxlx, then convert that.');
  }
  if (!/<roblox[\s>]/.test(input.subarray(0, 512).toString('latin1'))) {
    throw new Error('This is not a Roblox XML place or model file (.rbxlx / .rbxmx).');
  }
  const counts = {
    robloxLinks: 0, thumbnails: 0, gameAssets: 0, contentIds: 0, fonts: 0, droppedProperties: 0,
    attributes: 0, sharedStrings: 0, newCsg: 0, taskCalls: 0, compoundAssignments: 0, materials: 0, unionCollision: 0, unionShapes: 0, filteringEnabled: 0,
    compatScripts: 0, compatChanges: new Map(), madeFolders: new Map(), chatSetAside: 0, coreGuiSetAside: 0, localizationTables: 0, playerModule: false,
    gameAssetNames: new Set(), unsupportedThumbnails: new Set(), luauScripts: [], unknownClasses: new Map(),
  };
  const known = classesOf2017();
  const output = [];
  // Classes of the open <Item>s (as written out), across pieces; a model's
  // top-level items have no parent and are left as they are.
  const openItems = [];
  const newerChat = hasNewerChat(input);
  const setAsideRefs = new Set();
  const coreGuiRefs = dumpedCoreGui(input);
  const translations = localizationTables(input);
  const playerModule = needsPlayerModule(input);
  for (const piece of pieces(dropSharedStrings(input, counts))) {
    // Latin-1 keeps every byte as it was; only ASCII markup is touched.
    let text = piece.toString('latin1');
    text = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<Item\s+class="([^"]+)"([^>]*)>|<\/Item>/g, (match, className, rest) => {
      if (className === undefined) {
        if (match === '</Item>') openItems.pop();
        return match;
      }
      if (openItems.length > 0 && misplaced(className, openItems[openItems.length - 1])) {
        counts.madeFolders.set(className, (counts.madeFolders.get(className) || 0) + 1);
        openItems.push('Folder');
        return `<Item class="Folder"${rest}>`;
      }
      if (newerChat && openItems[openItems.length - 1] === 'Chat') {
        const referent = /referent="([^"]+)"/.exec(rest);
        if (referent) setAsideRefs.add(referent[1]);
      }
      // The dumped core UI's ScreenGui becomes a folder (nothing of it shows).
      if (className === 'ScreenGui' && coreGuiRefs.size > 0 && openItems[openItems.length - 1] === 'StarterGui') {
        const referent = /referent="([^"]+)"/.exec(rest);
        if (referent && coreGuiRefs.has(referent[1])) {
          openItems.push('Folder');
          return `<Item class="Folder"${rest}>`;
        }
      }
      openItems.push(className);
      return match;
    });
    text = text.replace(/(<Item\s+class="([^"]+)"[^>]*>\s*<Properties>)([\s\S]*?)(<\/Properties>)/g, (match, open, className, props, close) => {
      if (known !== null && !known.has(className)) counts.unknownClasses.set(className, (counts.unknownClasses.get(className) || 0) + 1);
      let converted = convertProperties(className, props, options, counts);
      const referent = setAsideRefs.size > 0 || coreGuiRefs.size > 0 ? /referent="([^"]+)"/.exec(open) : null;
      if (referent && setAsideRefs.has(referent[1])) {
        converted = setAside(converted);
        counts.chatSetAside++;
      }
      if (referent && coreGuiRefs.has(referent[1])) {
        if (className === 'Folder') converted = setAside(converted);
        else converted = converted.replace(/<bool\s+name="Disabled">false<\/bool>/, '<bool name="Disabled">true</bool>');
        counts.coreGuiSetAside++;
      }
      // The localization tables' text, as ReplicatedStorage's first child.
      if (className === 'ReplicatedStorage' && translations.size > 0 && counts.localizationTables === 0) {
        counts.localizationTables = translations.size;
        return open + converted + close + localizationFolder(translations);
      }
      if (className === 'StarterPlayerScripts' && playerModule && !counts.playerModule) {
        counts.playerModule = true;
        return open + converted + close + playerModuleItems();
      }
      return converted === props ? match : open + converted + close;
    });
    output.push(Buffer.from(text, 'latin1'));
  }
  return { output: output.length === 1 ? output[0] : Buffer.concat(output), counts, summary: summarize(counts, options) };
}

// The unions of a place (Buffer of an .rbxlx) that get a shape made from
// their mesh (lib/unionshapes.js): a Set of their asset IDs. Build the shapes
// with unionshapes.buildShapes and pass them to convertPlace as
// options.unionShapes.
function unionsNeedingShapes(input) {
  const assetIds = new Set();
  for (const piece of pieces(input)) {
    const text = piece.toString('latin1');
    for (const match of text.matchAll(/<Item\s+class="UnionOperation"[^>]*>\s*<Properties>([\s\S]*?)<\/Properties>/g)) {
      const info = unionshapes.unionInfo(match[1]);
      if (unionshapes.wantsShape(info)) assetIds.add(info.assetId);
    }
  }
  return assetIds;
}

// Node cannot hold a string much over 512 MB, so a big place is converted in
// pieces of about PIECE_BYTES. Each piece ends just before an <Item> tag that
// is not inside a script's CDATA, so every <Properties> block (all that
// convertProperties changes) stays whole in one piece.
const PIECE_BYTES = 64 * 1024 * 1024;
const ITEM_TAG = Buffer.from('<Item ', 'latin1');
const CDATA_OPEN = Buffer.from('<![CDATA[', 'latin1');
const CDATA_CLOSE = Buffer.from(']]>', 'latin1');

function pieces(input) {
  const result = [];
  let start = 0;
  while (input.length - start > PIECE_BYTES) {
    let cut = input.indexOf(ITEM_TAG, start + PIECE_BYTES);
    // Inside a CDATA section: the next <Item after it ends.
    for (let inside = cdataAround(input, start, cut); cut >= 0 && inside !== -1; inside = cdataAround(input, start, cut)) {
      cut = inside === null ? -1 : input.indexOf(ITEM_TAG, inside);
    }
    if (cut < 0) break;
    result.push(input.subarray(start, cut));
    start = cut;
  }
  result.push(input.subarray(start));
  return result;
}

// Whether position "at" is inside a CDATA section (scanning from "from",
// which is not): -1 when it is not, else where that section ends (null: never).
function cdataAround(input, from, at) {
  let position = from;
  for (;;) {
    const open = input.indexOf(CDATA_OPEN, position);
    if (open < 0 || open >= at) return -1;
    const close = input.indexOf(CDATA_CLOSE, open + CDATA_OPEN.length);
    if (close < 0) return null;
    if (close + CDATA_CLOSE.length > at) return close + CDATA_CLOSE.length;
    position = close + CDATA_CLOSE.length;
  }
}

// <SharedStrings> sections (newer places; the 2017 engine has none), with
// the line break before them, removed from the bytes.
function dropSharedStrings(input, counts) {
  const open = Buffer.from('<SharedStrings>', 'latin1');
  const close = Buffer.from('</SharedStrings>', 'latin1');
  const entry = Buffer.from('<SharedString', 'latin1');
  const kept = [];
  let from = 0;
  for (;;) {
    const start = input.indexOf(open, from);
    const end = start < 0 ? -1 : input.indexOf(close, start + open.length);
    if (end < 0) break;
    for (let at = input.indexOf(entry, start + open.length); at >= 0 && at < end; at = input.indexOf(entry, at + entry.length)) {
      if ([0x20, 0x09, 0x0a, 0x0d].includes(input[at + entry.length])) counts.sharedStrings++;
    }
    let cut = start;
    let back = start;
    while (back > from && (input[back - 1] === 0x20 || input[back - 1] === 0x09)) back--;
    if (back > from && input[back - 1] === 0x0a) cut = back - 1 > from && input[back - 2] === 0x0d ? back - 2 : back - 1;
    kept.push(input.subarray(from, cut));
    from = end + close.length;
  }
  if (kept.length === 0) return input;
  kept.push(input.subarray(from));
  return Buffer.concat(kept);
}

function summarize(counts, options) {
  const lines = [];
  const changed = (n, what) => { if (n > 0) lines.push(`  ${n} ${what}`); };
  lines.push('Changed:');
  changed(counts.robloxLinks, 'roblox.com asset links -> rbxassetid://');
  changed(counts.thumbnails, 'rbxthumb:// thumbnails -> local thumbnail addresses');
  changed(counts.gameAssets, `rbxgameasset:// names -> universe ${options.universeId} lookups`);
  changed(counts.contentIds, 'newer Content values (ContentId, <uri>, MeshContent...) rewritten');
  changed(counts.fonts, 'FontFace values -> the old Font list');
  changed(counts.droppedProperties, 'values of types the 2017 engine cannot read removed');
  changed(counts.attributes, 'attribute sets removed (attributes came after 2017)');
  changed(counts.sharedStrings, 'shared strings removed');
  changed(counts.taskCalls, 'task.wait/spawn/delay/defer calls -> wait/spawn/delay');
  changed(counts.compoundAssignments, 'compound assignments (x += 1) written out');
  changed(counts.unionShapes, 'unions given collision shaped like them (made from their mesh; 2017 cannot read their newer collision data)');
  changed(counts.unionCollision, 'unions given box collision (2017 cannot read their newer collision data)');
  changed(counts.materials, 'part materials the 2017 engine lacks (Glass, ForceField...) -> the nearest it has');
  if (counts.chatSetAside > 0) lines.push('  a newer chat system the 2017 engine cannot run set aside; the game gets the 2017 chat');
  if (counts.coreGuiSetAside > 0) lines.push('  a copy of Roblox\'s own UI scripts saved into StarterGui (RobloxGui) set aside; players get the 2017 topbar, backpack and player list');
  if (counts.playerModule) lines.push('  a stand-in PlayerModule (move input) added to StarterPlayerScripts, which the game\'s scripts look for');
  if (counts.localizationTables > 0) lines.push(`  ${counts.localizationTables} localization table${counts.localizationTables === 1 ? '' : 's'} given to clients as ModuleScripts (ReplicatedStorage.${LOCALIZATION_FOLDER}) for the GetTranslator stand-in`);
  if (counts.madeFolders.size > 0) {
    lines.push(`  ${[...counts.madeFolders].map(([name, n]) => `${n} ${name}${n === 1 ? '' : 's'}`).join(', ')} where the 2017 engine does not allow them (it would refuse the whole place) -> folders of the same name`);
  }
  if (counts.filteringEnabled > 0) lines.push('  FilteringEnabled turned on (the file leaves it out, and the 2017 engine would run the game with it off)');
  if (counts.compatScripts > 0) {
    lines.push(`  ${counts.compatScripts} scripts made to run on 2017: ${[...counts.compatChanges].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} x${n}`).join(', ')}`);
  }
  if (lines.length === 1) lines.push('  nothing - the file already uses the 2017 format');

  const notes = [];
  if (counts.gameAssetNames.size > 0 && !options.universeId) {
    notes.push(`${counts.gameAssetNames.size} rbxgameasset:// names (e.g. ${[...counts.gameAssetNames].slice(0, 3).join(', ')}) need the game's universe:`
      + ' give the Roblox place ID it came from, or set gameUniverseId in config/assets.json.');
  }
  if (counts.unsupportedThumbnails.size > 0) notes.push(`rbxthumb:// types with no local route left as they were: ${[...counts.unsupportedThumbnails].join(', ')}.`);
  if (counts.newCsg > 0) notes.push(`${counts.newCsg} unions use the newer CSG format and will not show in the 2017 engine. Separate them in Studio, or re-union them in a 2017-era Studio.`);
  if (counts.unknownClasses.size > 0) {
    const list = [...counts.unknownClasses.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} x${n}`);
    notes.push(`Classes the 2017 engine does not have (skipped when the place loads): ${list.slice(0, 20).join(', ')}${list.length > 20 ? ', ...' : ''}.`);
  }
  if (counts.luauScripts.length > 0) {
    notes.push(`${counts.luauScripts.length} scripts use Luau syntax Lua 5.1 cannot run; edit these by hand:`);
    for (const entry of counts.luauScripts.slice(0, 25)) notes.push(`    ${entry}`);
    if (counts.luauScripts.length > 25) notes.push(`    ... and ${counts.luauScripts.length - 25} more`);
  }
  if (notes.length > 0) {
    lines.push('Needs attention:');
    for (const note of notes) lines.push(note.startsWith('    ') ? note : `  - ${note}`);
  }
  return lines;
}

// Roblox place ID -> universe ID (for rbxgameasset:// names), or null.
async function universeForPlace(placeId) {
  if (!/^\d{1,15}$/.test(String(placeId))) return null;
  try {
    const response = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.universeId ? String(data.universeId) : null;
  } catch (error) {
    return null;
  }
}

module.exports = { convertPlace, unionsNeedingShapes, universeForPlace, convertUrl, expandCompound, fontEnum };
