'use strict';

// Who made the imported Roblox games: looked up once per place from its
// universe ID (games.roblox.com/v1/games, public, no sign-in) and kept in
// data/places.json as the place's "creator" (see places.creatorOf). Runs in
// the background; a failed lookup is tried again after a while. A name typed
// on /manage, or a Studio owner, always wins.

const places = require('./places');

const RETRY_MS = 30 * 60 * 1000;
const SCAN_MS = 60 * 1000;
const pending = new Set();
const failedAt = new Map(); // placeId -> time of the last failed lookup
let lastScan = 0;

async function fetchCreator(universeId) {
  const response = await fetch(`https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`games.roblox.com answered HTTP ${response.status}`);
  const data = await response.json();
  const game = data && Array.isArray(data.data) ? data.data[0] : null;
  const creator = game && game.creator;
  if (!creator || !creator.name) throw new Error(`no creator for universe ${universeId}`);
  return { id: Number(creator.id) || 0, name: String(creator.name), type: creator.type === 'Group' ? 'Group' : 'User' };
}

// Starts lookups for places that have a universe ID but no creator yet. Cheap
// to call often (at most one scan a minute).
function fillMissing() {
  if (Date.now() - lastScan < SCAN_MS || !places.exists()) return;
  lastScan = Date.now();
  const library = places.load().places;
  for (const [placeId, place] of Object.entries(library)) {
    if (place.creator !== undefined || (place.owner && place.owner.userId) || !place.universeId) continue;
    if (pending.has(placeId) || Date.now() - (failedAt.get(placeId) || 0) < RETRY_MS) continue;
    pending.add(placeId);
    fetchCreator(place.universeId)
      .then((creator) => { places.setLookedUpCreator(placeId, creator); failedAt.delete(placeId); })
      .catch(() => failedAt.set(placeId, Date.now()))
      .finally(() => pending.delete(placeId));
  }
}

module.exports = { fillMissing, fetchCreator };
