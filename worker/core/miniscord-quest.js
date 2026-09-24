// Converts one raw quest record from miniscord's POST /questsearch
// response into a complete wire-protocol Quest (see PROTOCOL.md's Quest
// content section) - the miniscord equivalent of miniscord-spawn.js's own
// role for pokesearch spawns and miniscord-gym.js's for /gyms raids.
//
// Identity is derived directly from the reported pokestop's own
// coordinates (same reasoning as miniscord-gym.js's gymLocationKey), not
// from a lookup against a pre-scraped POI database: questsearch already
// hands over both a real name *and* real coordinates for every result
// (`location`, parsed from the reply's own Maps link, is documented as
// "always present"), so there's nothing a database match would add except
// a dependency on that database actually containing this exact pokestop
// already - which silently dropped every quest at a not-yet-catalogued
// pokestop under the old design. poiId is always null here, matching the
// wire type's existing "no known POI match" allowance (already the norm
// for /gyms-sourced raids).
import { resolveSpecies, resolveItemSprite } from "../../shared/species-resolver.js";
import { stableIntId } from "../../shared/stable-id.js";

const MEGA_ENERGY_RE = /^Mega Energy \(([^)]+)\)$/i;

/** Same join-key shape as miniscord-gym.js's gymLocationKey - keeps re-polling the same pokestop mapped to the same entity row instead of a new one each time. */
export function questLocationKey(lat, lon) {
  return `${lat.toFixed(6)}|${lon.toFixed(6)}`;
}

/**
 * @param {object} record - one element of miniscord's POST /questsearch
 *   `results` array (see its own docs/questsearch-api.md for the full
 *   field list).
 * @param {{get, set}} speciesCache - see shared/species-resolver.js's own
 *   resolveSpecies for the shape.
 * @returns {Promise<object>} a complete wire-protocol Quest - always
 *   succeeds; there's no lookup left here that can fail the way a POI
 *   match used to.
 */
export async function buildQuestFromMiniscordRecord(record, speciesCache) {
  const { lat, lon } = record.location;
  const id = stableIntId(`quest|${questLocationKey(lat, lon)}`);

  const megaMatch = record.rewardType === "item" ? record.rewardName.match(MEGA_ENERGY_RE) : null;
  const speciesToResolve = record.rewardType === "encounter" ? record.rewardName : megaMatch ? megaMatch[1] : null;
  const sprite = speciesToResolve ? await resolveSpecies(speciesToResolve, speciesCache) : null;
  const itemSpriteUrl = record.rewardType === "item" && !megaMatch ? await resolveItemSprite(record.rewardName, speciesCache) : null;

  return {
    id,
    channelId: 0,
    messageId: record.messageId,
    poiId: null,
    pokestopName: record.pokestopName,
    location: { lat, lon },
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
