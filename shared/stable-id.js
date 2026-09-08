// Deterministic id generation for entities that have no natural row id to
// key off of (a wild spawn isn't tied to any fixed POI, unlike a
// quest/raid). See stableSpawnKey below for why species+exact-coords+cp
// (not despawnAt/ivPercent/moves) is the right identity key: those can
// vary slightly between two sightings of the very same spawn and would
// defeat dedup if included.

/** 32-bit string hash - fits Spawn.id's `number` type and doubles as the Nostr `d` tag. */
export function stableIntId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function stableSpawnKey(spawn) {
  return `${spawn.species}|${spawn.exactCoords.lat}|${spawn.exactCoords.lon}|${spawn.cp}`;
}

// Source Feed message ids are snowflakes with the post timestamp in the high
// bits - decoding it directly is more precise/robust than parsing a
// rendered timestamp element.
const SOURCE_FEED_EPOCH_MS = 1420070400000n;
export function snowflakeToMs(snowflakeStr) {
  return Number((BigInt(snowflakeStr) >> 22n) + SOURCE_FEED_EPOCH_MS);
}

/** Matches the tier thresholds cusucomap-viewer's map/IV filter UI expects. */
export function ivTier(ivPercent) {
  if (ivPercent === null) return "none";
  if (ivPercent >= 100) return "perfect";
  if (ivPercent > 90) return "gt90";
  if (ivPercent > 80) return "gt80";
  return "none";
}
