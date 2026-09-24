// Converts one raw record from miniscord's POST /pokesearch response into
// a complete wire-protocol Spawn (see PROTOCOL.md's Spawn content
// section).
import { resolveSpecies, FALLBACK_SPRITE_URL } from "../../shared/species-resolver.js";
import { stableIntId, stableSpawnKey, ivTier } from "../../shared/stable-id.js";

/**
 * @param {object} record - one element of miniscord's POST /pokesearch
 *   `results` array (see its own docs/pokesearch-api.md for the full
 *   field list).
 * @param {{get, set}} speciesCache - see shared/species-resolver.js's own
 *   resolveSpecies for the shape.
 * @returns {Promise<object|null>} a complete wire-protocol Spawn, or null
 *   if `record.location` or `record.despawnAt` is missing - nothing to
 *   place on the map without a location, and despawnAt is required by the
 *   wire type.
 */
export async function buildSpawnFromMiniscordRecord(record, speciesCache) {
  if (!record.location || typeof record.despawnAt !== "number") return null;

  // miniscord keeps species/form separate (e.g. "Pikachu"/"Horizons") -
  // resolved against PokeAPI using the clean base name *before* folding
  // form into the wire's own single `species` string (which has no
  // separate form field), so an event-form Pokémon's sprite/types resolve
  // correctly without species-resolver.js's own base-slug fallback ever
  // needing to trigger for this path.
  const sprite = await resolveSpecies(record.species, speciesCache);
  const species = record.form ? `${record.species} (${record.form})` : record.species;
  const ivSpread = record.ivSpread ?? null;
  const location = { lat: record.location.lat, lon: record.location.lon };
  const cp = record.cp ?? null;
  const ivPercent = record.ivPercent ?? null;

  return {
    id: stableIntId(stableSpawnKey({ species, exactCoords: location, cp })),
    channelId: 0,
    source: "source-feed", // wire-protocol value (see PROTOCOL.md) - unrelated to which backend produced this record
    messageId: record.messageId,
    species,
    disguisedAs: record.disguisedAs ?? null,
    gender: record.gender ?? null,
    shiny: Boolean(record.shiny),
    ivPercent,
    ivSpread: ivSpread ? { atk: ivSpread.atk, def: ivSpread.def, sta: ivSpread.sta } : null,
    level: record.level ?? null,
    cp,
    sizeTag: record.sizeTag ?? null,
    moves: record.moves ?? [],
    // miniscord's response carries no city/country text - always null here,
    // same as these already-optional fields being absent from any source.
    cityRaw: null,
    countryFlag: null,
    approxLocation: null,
    exactLocation: location,
    bestLocation: location,
    despawnAt: new Date(record.despawnAt * 1000).toISOString(),
    scrapedAt: new Date().toISOString(),
    revealPending: false,
    revealedAt: null,
    status: "active",
    ivTier: ivTier(ivPercent),
    spriteUrl: sprite ? sprite.spriteUrl : FALLBACK_SPRITE_URL,
    types: sprite ? sprite.types : [],
    unevolved: false,
  };
}
