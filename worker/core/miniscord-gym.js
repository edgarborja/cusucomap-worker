// Converts one raw gym record from miniscord's GET /gyms response into a
// complete wire-protocol Raid (see PROTOCOL.md's Raid content section) -
// the miniscord/Niantic equivalent of miniscord-spawn.js's own role for
// pokesearch spawns.
//
// Unlike the DOM-scraped raid path (source-feed-connector.js's #emitRaid,
// still used for the organic Discord-posted raid format), this source
// normally has no gym name at all - Niantic's own API exposes exact
// coordinates only, unless miniscord has been told (once, permanently -
// see worker-app.js's runMiniscordGymPoll) to also request it. Rather than
// reverse-geocoding against the bundled POI list (a real gym could easily
// be missing from that list, or ambiguous by nearest-distance in a way a
// name match never needed to worry about), this derives a stable id
// directly from the gym's own fixed coordinates and falls back to a
// plain, honest placeholder name only when no real name is known yet -
// poiId is left null, matching the wire type's own allowance for "no
// known POI match". Because the id is keyed on location, not on any
// particular raid, re-polling the same gym with a *different* boss than
// last time updates the same entity row rather than creating a new one -
// matching how a gym can only ever host one raid at a time, same as the
// DOM-scraped path's own POI-keyed id already works.
import { resolveSpecies, resolveSpeciesNameByDexNumber } from "../../shared/species-resolver.js";
import { stableIntId } from "../../shared/stable-id.js";

/** The join key worker-app.js's gymNameByLocation lookup uses - also the key this file's own stable id is derived from, so both always agree on which gym a given lat/lon means. */
export function gymLocationKey(lat, lon) {
  return `${lat.toFixed(6)}|${lon.toFixed(6)}`;
}

// Niantic labels every mega-tier raid's `bossSpecies` with this literal
// generic title, even once the boss is fully live (confirmed live for the
// 2026-09-19 Mega Staraptor launch - every one of ~40 active mega raids in
// the same city showed this same text). The real boss is only ever
// conveyed by bossImageUrl's own filename: it follows Niantic's usual
// asset convention "pm<dexNumber>.f<FORM>_<hash>.png", and dexNumber is
// confirmed to be the boss's real National Pokédex number (398 = Staraptor,
// verified against PokeAPI). Parsed here rather than hardcoded per-species
// so a future mega boss needs no code change.
const UNKNOWN_BOSS_PLACEHOLDER = "Pokémon Raid";
const MEGA_BOSS_IMAGE_RE = /\/pm(\d+)\.f([A-Za-z]+)_/;

/**
 * @param {object} gym - one element of miniscord's GET /gyms `results`
 *   array (see its own docs/gyms-api.md for the full field list).
 * @param {{get, set}} speciesCache - see shared/species-resolver.js's own
 *   resolveSpecies for the shape.
 * @param {Map<string, string>} [gymNameByLocation] - names seen from an
 *   earlier `?include_name=true` poll, keyed by gymLocationKey - used
 *   when this particular gym's own `name` field is still null (e.g. the
 *   background poller hasn't caught up yet after the switch was flipped).
 * @returns {Promise<object|null>} a complete wire-protocol Raid, or null
 *   if this gym has no active raid right now (gym.raid === null), or its
 *   boss still can't be identified - an unhatched egg (bossSpecies ""),
 *   or a mega-tier raid whose bossImageUrl doesn't match the known
 *   "pm<dex>.fMEGA_..." shape (a future Niantic asset-naming change, or a
 *   form other than a plain Mega Evolution). Skipped for now rather than
 *   sent with bossSpecies: null, matching the DOM-scraped path's own
 *   long-standing "only known-boss raids" convention - the viewer has
 *   never had to handle a null bossSpecies and shouldn't receive one
 *   without that being confirmed safe first.
 */
export async function buildRaidFromGym(gym, speciesCache, gymNameByLocation = new Map()) {
  if (!gym.raid) return null;

  let bossSpecies = gym.raid.bossSpecies;
  let bossForm = null;
  if (!bossSpecies || bossSpecies === UNKNOWN_BOSS_PLACEHOLDER) {
    const match = gym.raid.bossImageUrl?.match(MEGA_BOSS_IMAGE_RE);
    if (!match || match[2].toUpperCase() !== "MEGA") return null;
    bossSpecies = await resolveSpeciesNameByDexNumber(Number(match[1]), speciesCache);
    if (!bossSpecies) return null;
    bossForm = "Mega";
  }

  const { lat, lon } = gym.location;
  const locationKey = gymLocationKey(lat, lon);
  const id = stableIntId(`gym|${locationKey}`);
  const sprite = await resolveSpecies(bossSpecies, speciesCache);
  const gymName = gym.name || gymNameByLocation.get(locationKey) || `Gym near ${lat.toFixed(4)},${lon.toFixed(4)}`;

  return {
    id,
    channelId: 0,
    messageId: `niantic-gym:${id}:${gym.raid.startTime}`,
    poiId: null,
    gymName,
    location: { lat, lon },
    team: gym.team ? gym.team[0].toUpperCase() + gym.team.slice(1) : null,
    bossSpecies,
    bossForm,
    bossCp: null,
    moves: [],
    shinyEligible: false,
    gender: null,
    endsAt: new Date(gym.raid.endTime * 1000).toISOString(),
    cityRaw: null,
    scrapedAt: new Date().toISOString(),
    status: "active",
    // Never fall back to gym.raid.bossImageUrl (Niantic's own asset) -
    // matches source-feed-connector.js's own #emitRaid, which has never
    // used anything but a resolved PokeAPI sprite (or null) for a Raid's
    // spriteUrl, keeping every raid's art visually consistent regardless
    // of which path it came in through.
    spriteUrl: sprite ? sprite.spriteUrl : null,
    types: sprite ? sprite.types : [],
  };
}
