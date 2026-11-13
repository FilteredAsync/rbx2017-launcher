'use strict';

// Builds a 2017-compatible character from a player's current Roblox avatar.
// Port of Webserver/lib/legacy-avatar.php; uses the same cache files.

const path = require('path');
const core = require('./core');
const assets = require('./assets');
const accounts = require('./accounts');
const avatarStore = require('./avatarstore');

function validUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(name);
}

function activeUsername() {
  const text = core.readText(path.join(core.WWW, 'game', 'current-user.txt'));
  if (text === null) return null;
  const name = text.trim();
  return validUsername(name) ? name : null;
}

function localUsersPath() {
  return path.join(core.cacheDir(''), 'local-users.json');
}

// PHP writes {"0": name} as a JSON list, so accept both shapes.
function localUsers() {
  const users = core.readJsonFile(localUsersPath());
  return users ? Object.assign({}, users) : {};
}

function rememberLocalUser(userId, username) {
  if (userId === null || !validUsername(username)) return;
  const table = localUsers();
  if (table[userId] === username) return;
  table[userId] = username;
  core.writeFileAtomic(localUsersPath(), JSON.stringify(table));
}

function resolveUsername(userId, usernameParam) {
  if (validUsername(usernameParam)) return usernameParam;
  if (userId !== null) {
    const users = localUsers();
    if (validUsername(users[userId])) return users[userId];
  }
  return activeUsername();
}

async function robloxUserId(username) {
  const cachePath = path.join(core.cacheDir(''), 'roblox-users.json');
  let cache = core.readJsonFile(cachePath);
  if (!cache || Array.isArray(cache)) cache = {};
  const key = username.toLowerCase();
  const entry = cache[key];
  const cached = entry ? core.decimal(entry.id) : null;
  if (cached !== null && entry.at !== undefined && Number(entry.at) > Date.now() / 1000 - 7 * 86400) return cached;

  const response = await assets.httpRequest(
    'https://users.roblox.com/v1/usernames/users',
    { Accept: 'application/json', 'Content-Type': 'application/json' },
    15000,
    JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  );
  let id = null;
  if (response.status === 200) {
    try {
      const data = JSON.parse(response.body.toString('utf8'));
      if (data && data.data && data.data[0]) id = core.decimal(data.data[0].id);
    } catch (error) {
      id = null;
    }
  }
  if (id === null) return cached; // Roblox unreachable or no such user.
  cache[key] = { id, at: Math.floor(Date.now() / 1000) };
  core.writeFileAtomic(cachePath, JSON.stringify(cache));
  return id;
}

// Returns [avatarData, "live" | "cache" | "stale-cache"] or [null, "unavailable"].
async function fetchAvatar(id) {
  const config = core.assetConfig();
  const cachePath = path.join(core.cacheDir('avatars'), `${id}.json`);
  const cached = core.readJsonFile(cachePath);
  const maxAge = Math.max(0, Number(config.avatarCacheSeconds) || 0) * 1000;
  if (cached && core.mtimeMs(cachePath) > Date.now() - maxAge) return [cached, 'cache'];
  const avatar = await assets.httpGetJson(`https://avatar.roblox.com/v1/users/${id}/avatar`, 15000);
  if (avatar && Array.isArray(avatar.assets)) {
    core.writeFileAtomic(cachePath, JSON.stringify(avatar));
    return [avatar, 'live'];
  }
  return cached ? [cached, 'stale-cache'] : [null, 'unavailable'];
}

// 17 = classic head (a SpecialMesh), kept at any age: new meshes are converted.
const KEPT = new Set([2, 8, 11, 12, 17, 18, 41, 42, 43, 44, 45, 46, 47]);
const BODY_PARTS = new Set([27, 28, 29, 30, 31]);

// Classic equivalents of well-known dynamic heads. "face": "0" = no face.
const CLASSIC_HEADLESS_HEAD = '134082579'; // "Headless Head" (2013, type 17)
const BUILTIN_DYNAMIC_HEADS = {
  15093053680: { head: CLASSIC_HEADLESS_HEAD, face: '0' }, // "Headless Head" (2023 dynamic head)
};
const ANIMATIONS = new Set([48, 49, 50, 51, 52, 53, 54, 55, 56]);
const LAYERED = new Set([64, 65, 66, 67, 68, 69, 70, 71, 72, 76, 77]);
const EXPRESSIONS = new Set([61, 78]);

function emptyCharacter() {
  return {
    username: null,
    robloxUserId: null,
    source: 'default',
    avatarType: 'R6',
    bodyColors: { HeadColor: 1001, LeftArmColor: 1001, LeftLegColor: 1001, RightArmColor: 1001, RightLegColor: 1001, TorsoColor: 1001 },
    scales: { Height: 1.0, Width: 1.0, Depth: 1.0, Head: 1.0 },
    assets: [],
    gear: [],
    dropped: [],
  };
}

// A saved look (an account's avatar from the launcher's editor, or the guest
// look) as a character.
function storedCharacter(username, stored, source) {
  const character = emptyCharacter();
  character.username = username;
  character.source = source;
  character.bodyColors = Object.assign({}, character.bodyColors, stored.bodyColors);
  for (const asset of stored.assets) {
    if (KEPT.has(asset.typeId) || BODY_PARTS.has(asset.typeId)) character.assets.push({ id: asset.id, typeId: asset.typeId, name: asset.name });
    else character.dropped.push(Object.assign({}, asset, { reason: `asset type ${asset.typeId} is not worn by this client` }));
  }
  return character;
}

// Guests wear the guest look; this server's accounts wear the avatar saved in
// the launcher, or, until they save one, a copy of the Roblox account with
// the same name (kept as their avatar from then on). Other names (playGame.bat
// and older launchers) get the Roblox account's current look.
async function characterFor(localUserId, usernameParam) {
  if (localUserId !== null && avatarStore.isGuestId(localUserId)) {
    return storedCharacter(validUsername(usernameParam) ? usernameParam : 'Guest', avatarStore.guest(), 'guest');
  }
  const account = localUserId !== null ? accounts.byUserId(localUserId) : null;
  if (account) {
    const saved = avatarStore.get(account.userId);
    if (saved) return storedCharacter(account.name, saved, 'account');
    const copied = await robloxCharacter(account.name);
    if (['live', 'cache', 'stale-cache'].includes(copied.source)) {
      try {
        avatarStore.set(account.userId, { bodyColors: copied.bodyColors, assets: copied.assets }, 'roblox-copy');
      } catch (error) { /* read-only data folder: copied again next time */ }
    }
    return copied;
  }
  return robloxCharacter(resolveUsername(localUserId, usernameParam));
}

// What the Roblox account with this name wears, made 2017-compatible.
async function robloxCharacter(username) {
  const config = core.assetConfig();
  const character = emptyCharacter();
  character.username = username;
  if (username === null) {
    character.source = 'no username (run detect-roblox-user.ps1 or pass a name to launchClient.bat)';
    return character;
  }
  const id = await robloxUserId(username);
  character.robloxUserId = id;
  if (id === null) {
    character.source = `could not look up '${username}' on Roblox`;
    return character;
  }
  const [avatar, source] = await fetchAvatar(id);
  character.source = source;
  if (avatar === null) return character;

  if (avatar.bodyColors && typeof avatar.bodyColors === 'object') {
    const keys = {
      headColorId: 'HeadColor', torsoColorId: 'TorsoColor', leftArmColorId: 'LeftArmColor',
      rightArmColorId: 'RightArmColor', leftLegColorId: 'LeftLegColor', rightLegColorId: 'RightLegColor',
    };
    for (const [from, to] of Object.entries(keys)) {
      const value = avatar.bodyColors[from];
      if (value !== undefined && value !== null && value !== '' && !Number.isNaN(Number(value))) {
        character.bodyColors[to] = Math.trunc(Number(value));
      }
    }
  }
  if (avatar.scales && typeof avatar.scales === 'object') {
    for (const [from, to] of Object.entries({ height: 'Height', width: 'Width', depth: 'Depth', head: 'Head' })) {
      const value = avatar.scales[from];
      if (value !== undefined && value !== null && value !== '' && !Number.isNaN(Number(value))) {
        character.scales[to] = Math.max(0.5, Math.min(1.5, Number(value)));
      }
    }
  }

  const requestedType = String(config.avatarType).toUpperCase();
  if (requestedType === 'R6' || requestedType === 'R15') character.avatarType = requestedType;
  else if (avatar.playerAvatarType === 'R15') character.avatarType = 'R15';

  // Optional: drop body parts above this asset ID ("" or "0" = keep all).
  const eraCutoff = core.decimal(String(config.legacyBodyPartMaxAssetId || ''));
  const faceMap = config.dynamicHeadFaces && typeof config.dynamicHeadFaces === 'object' ? config.dynamicHeadFaces : {};
  const headMap = config.dynamicHeads && typeof config.dynamicHeads === 'object' ? config.dynamicHeads : {};
  const typeOf = (asset) => (asset && asset.assetType && asset.assetType.id !== undefined ? Math.trunc(Number(asset.assetType.id)) || 0 : 0);
  const hasClassicFace = avatar.assets.some((asset) => typeOf(asset) === 18);

  for (const asset of avatar.assets) {
    const assetId = asset && asset.id !== undefined ? core.decimal(asset.id) : null;
    const type = typeOf(asset);
    const name = asset && asset.name !== undefined ? String(asset.name) : '';
    if (assetId === null) continue;
    const entry = { id: assetId, typeId: type, name };

    if (KEPT.has(type)) {
      character.assets.push(entry);
    } else if (type === 19) {
      if (config.loadGear) character.gear.push(entry);
      else character.dropped.push(Object.assign({}, entry, { reason: 'gear is off (loadGear in config/assets.json)' }));
    } else if (BODY_PARTS.has(type)) {
      // Body part assets (old ones too, Roblox reprocessed them) carry one
      // R6 CharacterMesh plus R15 folders; the server script applies only the
      // CharacterMesh, so they work at any age on R6 avatars.
      if (eraCutoff !== null && eraCutoff !== '0' && core.decimalCompare(assetId, eraCutoff) > 0) {
        character.dropped.push(Object.assign({}, entry, { reason: 'newer than legacyBodyPartMaxAssetId; the default part is used' }));
      } else {
        character.assets.push(entry);
      }
    } else if (type === 79) {
      // A dynamic head becomes a classic head (SpecialMesh) and/or a classic
      // 2D face: config "dynamicHeads", then the built-in list, then the name.
      const mapping = headMap[assetId] || BUILTIN_DYNAMIC_HEADS[assetId]
        || (/headless/i.test(name) ? { head: CLASSIC_HEADLESS_HEAD, face: '0' } : null);
      const how = headMap[assetId] ? 'dynamicHeads entry' : mapping ? 'built-in classic equivalent'
        : faceMap[assetId] !== undefined ? 'dynamicHeadFaces entry' : 'defaultFaceId';
      const headId = mapping && mapping.head !== undefined ? core.decimal(String(mapping.head)) : null;
      let faceId = mapping && mapping.face !== undefined ? core.decimal(String(mapping.face))
        : faceMap[assetId] !== undefined ? core.decimal(String(faceMap[assetId])) : core.decimal(String(config.defaultFaceId));
      if (hasClassicFace) faceId = null; // the equipped classic face wins
      const used = [];
      if (headId !== null && headId !== '0') {
        character.assets.push({ id: headId, typeId: 17, name: `Classic head for ${name}`, translatedFrom: assetId });
        used.push(`classic head ${headId}`);
      }
      if (faceId !== null && faceId !== '0') {
        character.assets.push({ id: faceId, typeId: 18, name: `Classic face for ${name}`, translatedFrom: assetId });
        used.push(`classic face ${faceId}`);
      }
      const reason = used.length > 0 ? `dynamic head; replaced by ${used.join(' and ')} (${how})`
        : hasClassicFace ? 'dynamic head; the equipped classic face is used' : 'dynamic head; nothing configured to replace it';
      character.dropped.push(Object.assign({}, entry, { reason }));
    } else if (ANIMATIONS.has(type)) {
      character.dropped.push(Object.assign({}, entry, { reason: "animation pack; the client's default animations are used" }));
    } else if (LAYERED.has(type)) {
      character.dropped.push(Object.assign({}, entry, { reason: 'layered clothing or makeup needs a newer client' }));
    } else if (EXPRESSIONS.has(type)) {
      character.dropped.push(Object.assign({}, entry, { reason: 'emote or mood; not part of this client' }));
    } else {
      character.dropped.push(Object.assign({}, entry, { reason: `asset type ${type} is not supported by this client` }));
    }
  }
  return character;
}

function bodyColorsUrl(localUserId, username) {
  const config = core.assetConfig();
  let url = `${String(config.baseUrl).replace(/\/+$/, '')}/Asset/BodyColors.ashx?userId=${localUserId === null ? '0' : localUserId}`;
  if (validUsername(username)) url += `&username=${encodeURIComponent(username)}`;
  return url;
}

// sprintf("%.4F") of PHP.
function fixed4(value) {
  return Number(value).toFixed(4);
}

// The JSON the 2017 server's handleAvatarFetchResponse reads (same bytes as
// the PHP version).
function avatarFetchJson(character, localUserId, usernameParam) {
  const versionIds = character.assets.map((asset) => core.versionIdForAsset(asset.id)).filter((id) => id !== null);
  const gearIds = character.gear.map((gear) => core.versionIdForAsset(gear.id)).filter((id) => id !== null);
  const colors = Object.entries(character.bodyColors).map(([name, value]) => `${JSON.stringify(name)}:${Math.trunc(value)}`);
  const scales = Object.entries(character.scales).map(([name, value]) => `${JSON.stringify(name)}:${fixed4(value)}`);
  const colorsUrl = bodyColorsUrl(localUserId, usernameParam !== null ? usernameParam : character.username);
  return '{'
    + `"resolvedAvatarType":${core.phpJson(character.avatarType)}`
    + `,"accessoryVersionIds":[${versionIds.join(',')}]`
    + `,"equippedGearVersionIds":[${gearIds.join(',')}]`
    + ',"backpackGearVersionIds":[]'
    + `,"bodyColorsUrl":${core.phpJson(colorsUrl).replace(/\\\//g, '/')}`
    + `,"bodyColors":{${colors.join(',')}}`
    + ',"animations":{}'
    + `,"scales":{${scales.join(',')}}`
    + '}';
}

function bodyColorsXml(character) {
  const colors = character.bodyColors;
  let xml = '<?xml version="1.0" encoding="utf-8" ?>\n'
    + '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n'
    + '\t<External>null</External>\n\t<External>nil</External>\n'
    + '\t<Item class="BodyColors">\n\t\t<Properties>\n';
  for (const name of ['HeadColor', 'LeftArmColor', 'LeftLegColor']) {
    xml += `\t\t\t<int name="${name}">${Math.trunc(colors[name])}</int>\n`;
  }
  xml += '\t\t\t<string name="Name">Body Colors</string>\n';
  for (const name of ['RightArmColor', 'RightLegColor', 'TorsoColor']) {
    xml += `\t\t\t<int name="${name}">${Math.trunc(colors[name])}</int>\n`;
  }
  return xml + '\t\t\t<bool name="archivable">true</bool>\n\t\t</Properties>\n\t</Item>\n</roblox>\n';
}

module.exports = {
  validUsername, activeUsername, rememberLocalUser, resolveUsername,
  characterFor, robloxCharacter, bodyColorsUrl, avatarFetchJson, bodyColorsXml, KEPT, BODY_PARTS,
};
