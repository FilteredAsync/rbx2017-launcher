'use strict';

// Who has the launcher open (launchers 1.8.0+ say so every 30 s, and when it
// changes), and whether they are in Roblox Studio or a game it started. Kept
// in memory only: after a restart everyone shows as offline until their
// launcher reports again. Games on the always-on server are known from its
// player lists instead (lib/launcherapi.js onlinePlayers), which win.

const TTL_MS = 75 * 1000;
const STATES = new Set(['online', 'studio', 'game']);
const seen = new Map(); // userId -> { state, placeId, at }

function report(userId, state, placeId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (!STATES.has(state)) {
    seen.delete(id);
    return;
  }
  seen.set(id, { state, placeId: /^\d{1,15}$/.test(String(placeId || '')) ? String(placeId) : null, at: Date.now() });
  if (seen.size > 5000) {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, entry] of seen) if (entry.at < cutoff) seen.delete(key);
  }
}

// -> { state, placeId } while the launcher keeps reporting, else null.
function of(userId) {
  const entry = seen.get(Number(userId));
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  return { state: entry.state, placeId: entry.placeId };
}

module.exports = { TTL_MS, report, of };
