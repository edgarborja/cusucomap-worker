// Minimal structural validation for normalized entities flowing through the
// worker's ingestion pipeline (Normalization -> Validation -> Dedup ->
// ApplicationState). Deliberately not a full schema library - connectors are
// untrusted input (Source Feed/AHK markup can and does change shape), so this
// exists to reject the malformed 10% loudly rather than let `undefined`s
// and NaNs silently drift into published Nostr events. Field shapes mirror
// the existing Spawn/Quest/Raid JSON already defined in cusucomap-viewer's src/entities.ts.

/** @returns {string[]} human-readable problems; empty means valid. */
export function validateSpawn(spawn) {
  const errors = [];
  if (typeof spawn.id !== "number" || !Number.isFinite(spawn.id)) errors.push("id must be a finite number");
  if (typeof spawn.species !== "string" || spawn.species.trim() === "") errors.push("species is required");
  if (!spawn.bestLocation || typeof spawn.bestLocation.lat !== "number" || typeof spawn.bestLocation.lon !== "number") {
    errors.push("bestLocation.{lat,lon} required");
  }
  if (typeof spawn.despawnAt !== "string" || Number.isNaN(Date.parse(spawn.despawnAt))) {
    errors.push("despawnAt must be a parseable ISO date string");
  }
  if (spawn.ivPercent !== null && (typeof spawn.ivPercent !== "number" || spawn.ivPercent < 0 || spawn.ivPercent > 100)) {
    errors.push("ivPercent must be null or 0-100");
  }
  return errors;
}

export function validateQuest(quest) {
  const errors = [];
  if (typeof quest.id !== "number" || !Number.isFinite(quest.id)) errors.push("id must be a finite number");
  if (typeof quest.pokestopName !== "string" || quest.pokestopName.trim() === "") errors.push("pokestopName is required");
  if (typeof quest.rewardName !== "string" || quest.rewardName.trim() === "") errors.push("rewardName is required");
  if (typeof quest.expiresAt !== "string" || Number.isNaN(Date.parse(quest.expiresAt))) {
    errors.push("expiresAt must be a parseable ISO date string");
  }
  return errors;
}

export function validateRaid(raid) {
  const errors = [];
  if (typeof raid.id !== "number" || !Number.isFinite(raid.id)) errors.push("id must be a finite number");
  if (typeof raid.gymName !== "string" || raid.gymName.trim() === "") errors.push("gymName is required");
  if (typeof raid.endsAt !== "string" || Number.isNaN(Date.parse(raid.endsAt))) {
    errors.push("endsAt must be a parseable ISO date string");
  }
  return errors;
}

/**
 * Escapes text before it's ever placed into innerHTML on the dashboard -
 * external connector content (species names, city text, Source Feed message
 * text) is untrusted and must never be interpreted as markup. Everywhere
 * else (Nostr event `content`, IndexedDB) plain strings are fine as-is;
 * this is specifically for the one place the worker renders untrusted text
 * as HTML (the dashboard's activity log / entity lists).
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
