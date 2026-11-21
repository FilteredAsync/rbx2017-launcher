'use strict';

// Copies in the Roblox groups that made this server's imported games (a
// place's creator of type Group, lib/creators.js): name, description, ranks
// (groups.roblox.com, public) and emblem (thumbnails.roblox.com), owned by
// "Website" (lib/groups.js). Runs in the background, at most one scan a
// minute; each group is looked again at weekly, and a failed lookup is
// tried again after half an hour.

const groups = require('./groups');
const places = require('./places');

const SCAN_MS = 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const pending = new Set();
const failedAt = new Map();
let lastScan = 0;

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}

async function emblemBytes(groupId) {
  const data = await getJson(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupId}&size=150x150&format=Png&isCircular=false`);
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry || entry.state !== 'Completed' || !/^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(String(entry.imageUrl || ''))) return null;
  const response = await fetch(entry.imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length && bytes.length <= 1024 * 1024 ? bytes : null;
}

async function importGroup(groupId) {
  const info = await getJson(`https://groups.roblox.com/v1/groups/${groupId}`);
  if (!info || !info.name) throw new Error(`no group ${groupId}`);
  let roles = [];
  try {
    const data = await getJson(`https://groups.roblox.com/v1/groups/${groupId}/roles`);
    roles = data && Array.isArray(data.roles) ? data.roles : [];
  } catch (error) { /* default ranks */ }
  const group = groups.upsertImported({ id: Number(groupId), name: String(info.name), description: String(info.description || ''), roles });
  try {
    const bytes = await emblemBytes(groupId);
    if (bytes) groups.setEmblem(group.id, 0, bytes, true);
  } catch (error) { /* no picture this time */ }
  return group;
}

// The groups behind the games: { groupId: name }.
function creatorGroups() {
  const found = new Map();
  if (!places.exists()) return found;
  for (const place of Object.values(places.load().places)) {
    const creator = places.creatorOf(place);
    if (creator && creator.type === 'Group' && Number(creator.id) > 0) found.set(String(creator.id), creator.name);
  }
  return found;
}

// Starts lookups for groups not copied in yet (or not for a week). Cheap to call often.
function fillMissing() {
  if (Date.now() - lastScan < SCAN_MS) return;
  lastScan = Date.now();
  for (const groupId of creatorGroups().keys()) {
    const existing = groups.get(groupId);
    const fresh = existing && (!existing.imported || (existing.refreshed && Date.now() - Date.parse(existing.refreshed) < REFRESH_MS));
    if (fresh || pending.has(groupId) || Date.now() - (failedAt.get(groupId) || 0) < RETRY_MS) continue;
    pending.add(groupId);
    importGroup(groupId)
      .catch(() => failedAt.set(groupId, Date.now()))
      .finally(() => pending.delete(groupId));
  }
}

module.exports = { fillMissing, creatorGroups, importGroup };
