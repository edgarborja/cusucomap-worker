// Converts one raw quest record from miniscord's POST /questsearch
// response into a complete wire-protocol Quest (see PROTOCOL.md's Quest
// content section) - the miniscord equivalent of miniscord-spawn.js's own
// role for pokesearch spawns and miniscord-gym.js's for /gyms raids.
//
// Mirrors source-feed-connector.js's own #emitQuest almost exactly - same
// resolvePoi/MEGA_ENERGY_RE/species-vs-item-sprite logic - since
// questsearch's response already hands over the same clean, pre-split
// fields (rewardType/rewardName/rewardForm/rewardQuantity) the DOM parser
// used to have to derive itself via parseReward. Unlike miniscord-gym.js,
// there's no placeholder-name fallback here: a quest's pokestopName is a
// real name straight from the reply text, so resolvePoi either finds a
// real match or this quest is skipped, same as the DOM-scraped path
// already does for an unrecognized pokestop.
import { resolvePoi } from "../../shared/poi-resolver.js";
import { resolveSpecies, resolveItemSprite } from "../../shared/species-resolver.js";

const MEGA_ENERGY_RE = /^Mega Energy \(([^)]+)\)$/i;

/**
 * @param {object} record - one element of miniscord's POST /questsearch
 *   `results` array (see its own docs/questsearch-api.md for the full
 *   field list).
 * @param {{get, set}} speciesCache - see shared/species-resolver.js's own
 *   resolveSpecies for the shape.
 * @param {{lat: number, lon: number}} geofilterAnchor - disambiguation
 *   center for a pokestop name resolvePoi finds more than one candidate
 *   for with no closer exact-location tiebreaker (record.location already
 *   covers the usual case; this is only the tiebreaker of last resort).
 * @returns {Promise<object|null>} a complete wire-protocol Quest, or null
 *   if `record.pokestopName` doesn't match any known POI.
 */
export async function buildQuestFromMiniscordRecord(record, speciesCache, geofilterAnchor) {
  const poi = resolvePoi(record.pokestopName, "S", record.location, geofilterAnchor);
  if (!poi) return null;

  const megaMatch = record.rewardType === "item" ? record.rewardName.match(MEGA_ENERGY_RE) : null;
  const speciesToResolve = record.rewardType === "encounter" ? record.rewardName : megaMatch ? megaMatch[1] : null;
  const sprite = speciesToResolve ? await resolveSpecies(speciesToResolve, speciesCache) : null;
  const itemSpriteUrl = record.rewardType === "item" && !megaMatch ? await resolveItemSprite(record.rewardName, speciesCache) : null;

  return {
    id: poi.id,
    channelId: 0,
    messageId: record.messageId,
    poiId: poi.id,
    pokestopName: record.pokestopName,
    location: { lat: poi.lat, lon: poi.lon },
    poiPhotoUrl: null,
    rewardType: record.rewardType,
    rewardName: record.rewardName,
    rewardQuantity: record.rewardQuantity,
    rewardForm: record.rewardForm,
    cityRaw: record.cityRaw,
    expiresAt: new Date(record.expiresAt * 1000).toISOString(),
    scrapedAt: new Date().toISOString(),
    status: "active",
    spriteUrl: sprite ? sprite.spriteUrl : itemSpriteUrl,
    types: sprite ? sprite.types : [],
    isMegaEnergy: megaMatch !== null,
  };
}
