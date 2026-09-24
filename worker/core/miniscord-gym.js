// Converts one raw gym record from miniscord's GET /gyms response into a
// complete wire-protocol Raid (see PROTOCOL.md's Raid content section) -
// the miniscord/Niantic equivalent of miniscord-spawn.js's own role for
// pokesearch spawns.
//
// Niantic's own API exposes exact coordinates only, no gym name, unless
// miniscord has been told (once, permanently - see worker-app.js's
// runMiniscordGymPoll) to also request it. Identity is derived directly
// from the gym's own fixed coordinates (see gymLocationKey below), with a
// plain, honest placeholder name used whenever no real name is known yet
// - poiId is always null, since there's no POI database to match against
// at all any more (see miniscord-quest.js's own comment for why quests
// work the same way now). Because the id is keyed on location, not on any
// particular raid, re-polling the same gym with a *different* boss than
// last time updates the same entity row rather than creating a new one -
// matching how a gym can only ever host one raid at a time.
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
// conveyed by bossImageUrl's own filename in that case, and dexNumber
// there is confirmed to be the boss's real National Pokédex number
// (398 = Staraptor, verified against PokeAPI).
//
// Every other raid's bossSpecies is already a normal, usable species name
// - but it never distinguishes an alternate form: Hisuian Decidueye and
// the regular one are both just "Decidueye" in bossSpecies; Thundurus's
// Incarnate and Therian formes are both just "Thundurus". Only
// bossImageUrl's own "f<FORM>" filename segment does that - confirmed
// live: "pm642.fINCARNATE_<hash>.png", "pm724.fHISUIAN_<hash>.png",
// "pm687.fMEGA_<hash>.png", vs. a plain "pm147_<hash>.png" for a species
// with no alternate forms at all. Parsed here rather than hardcoded per
// species/form, so a future boss/form needs no code change.
const UNKNOWN_BOSS_PLACEHOLDER = "Pokémon Raid";
const BOSS_IMAGE_RE = /\/pm(\d+)(?:\.f([A-Za-z]+))?_/;

/** "HISUIAN" -> "Hisuian", "MEGA" -> "Mega" - matches this file's own long-standing "Mega" convention, generalized to every form code. */
function titleCaseForm(formCode) {
  return formCode.charAt(0).toUpperCase() + formCode.slice(1).toLowerCase();
}

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

  const imageMatch = gym.raid.bossImageUrl?.match(BOSS_IMAGE_RE);
  const formCode = imageMatch?.[2] ?? null;
  // eggImageUrl never carries a boss - it's the generic pre-hatch/rating
  // icon (confirmed live: "raid_egg_<rating>_icon.png") - but Niantic
  // marks a Shadow Raid by adding "_shadow" to that same filename
  // ("raid_egg_<rating>_shadow_icon.png"), the only place this API says
  // so at all (bossSpecies/bossImageUrl look identical either way).
  const isShadow = Boolean(gym.raid.eggImageUrl?.includes("_shadow_"));

  let bossSpecies = gym.raid.bossSpecies;
  if (!bossSpecies || bossSpecies === UNKNOWN_BOSS_PLACEHOLDER) {
    if (!imageMatch || formCode?.toUpperCase() !== "MEGA") return null;
    bossSpecies = await resolveSpeciesNameByDexNumber(Number(imageMatch[1]), speciesCache);
    if (!bossSpecies) return null;
  }
  const bossForm = formCode ? titleCaseForm(formCode) : null;

  const { lat, lon } = gym.location;
  const locationKey = gymLocationKey(lat, lon);
  const id = stableIntId(`gym|${locationKey}`);
  const sprite = await resolveSpecies(bossSpecies, speciesCache, bossForm);
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
    isShadow,
    endsAt: new Date(gym.raid.endTime * 1000).toISOString(),
    cityRaw: null,
    scrapedAt: new Date().toISOString(),
    status: "active",
    // Never fall back to gym.raid.bossImageUrl (Niantic's own asset) -
    // always a resolved PokeAPI sprite, or null, keeping every raid's art
    // visually consistent.
    spriteUrl: sprite ? sprite.spriteUrl : null,
    types: sprite ? sprite.types : [],
  };
}
