// Species -> sprite/types resolution. worker.html runs on this project's
// own static-site origin, not inside a Source Feed tab, so it has no
// reason to hit PokeAPI through a GM_xmlhttpRequest bridge - a plain
// `fetch()` works directly (PokeAPI itself is CORS-open; a page's own CSP
// restrictions, which would block this, don't apply here).
import { SPECIES_SEED } from "./generated/species-seed.js";

const SPRITE_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/";
export const FALLBACK_SPRITE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%23999'/%3E%3C/svg%3E";

export function normalizeSpeciesKey(raw) {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// PokeAPI has no plain default-form slug for a handful of species - only
// named-form ones (e.g. no "giratina", only "giratina-altered"/
// "giratina-origin"), so a fetch using the species name as-is 404s. Add to
// this map as more otherwise-unresolved species turn up in the activity log.
const SPECIES_SLUG_OVERRIDES = { giratina: "giratina-altered" };

// Unown is a different case from the override map above: its letter forms
// aren't separate PokeAPI "pokemon" entries at all (confirmed live -
// /pokemon/unown-d 404s; only the single base /pokemon/unown, id 201,
// always Psychic, exists) - the letter is purely a sprite variant, named
// "<id>-<letter>.png" in the same sprites repo this file already pulls
// from (confirmed live: sprites/pokemon/201-d.png exists, 201.png is
// just the plain/undifferentiated icon). normalizeSpeciesKey already turns
// "Unown (D)" into "unown-d", conveniently identical to PokeAPI's own
// per-letter form name - matched here to resolve the base species
// normally, then swap in the form-specific sprite filename.
const UNOWN_FORM_RE = /^unown-([a-z])$/;

async function fetchSpeciesBySlug(slug, unownLetter) {
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const spriteId = unownLetter ? `${data.id}-${unownLetter}` : String(data.id);
  return { spriteUrl: `${SPRITE_BASE}${spriteId}.png`, types: (data.types ?? []).map((t) => t.type.name) };
}

const memoryCache = new Map();
/** No-op-persistent default cache; pass a `{get,set}` backed by ApplicationState.workerMetadata for real persistence (see worker/connectors/source-feed-connector.js). */
const defaultCache = {
  async get(key) {
    return memoryCache.get(key) ?? null;
  },
  async set(key, value) {
    memoryCache.set(key, value);
  },
};

/** @returns {Promise<{ spriteUrl: string, types: string[] } | null>} */
export async function resolveSpecies(speciesRaw, cache = defaultCache) {
  const key = normalizeSpeciesKey(speciesRaw);
  if (!key) return null;

  const seeded = SPECIES_SEED[key];
  if (seeded) return { spriteUrl: `${SPRITE_BASE}${seeded[0]}.png`, types: seeded[1] };

  const cached = await cache.get(`species:${key}`);
  if (cached !== null && cached !== undefined) return cached;

  const unownLetter = key.match(UNOWN_FORM_RE)?.[1];
  const slug = SPECIES_SLUG_OVERRIDES[key] || (unownLetter ? "unown" : key);
  try {
    const result = await fetchSpeciesBySlug(slug, unownLetter);
    await cache.set(`species:${key}`, result);
    return result;
  } catch (err) {
    console.warn(`[species-resolver] could not resolve "${speciesRaw}" (slug "${slug}"):`, err.message);
  }

  // A special/event form's display name (e.g. "Charmander (Goggles 2026)",
  // "Pikachu (Horizons)") usually isn't its own PokeAPI entry - only the
  // base species is. Retry with just the part before the first hyphen of
  // the normalized slug ("charmander", "pikachu") rather than showing no
  // sprite/types at all for what's still recognizably that species. Not
  // attempted for Unown (already handled above as its own special case) or
  // a slug with no hyphen to strip. Checks SPECIES_SEED first (cheap, no
  // network) before falling back to another PokeAPI fetch.
  if (unownLetter || !slug.includes("-")) return null;
  const baseKey = slug.split("-")[0];
  const baseSeeded = SPECIES_SEED[baseKey];
  const fallback = baseSeeded
    ? { spriteUrl: `${SPRITE_BASE}${baseSeeded[0]}.png`, types: baseSeeded[1] }
    : await fetchSpeciesBySlug(baseKey, null).catch((err) => {
        console.warn(`[species-resolver] base species fallback "${baseKey}" also failed for "${speciesRaw}":`, err.message);
        return null;
      });
  if (fallback) {
    console.warn(`[species-resolver] resolved "${speciesRaw}" via base species fallback "${baseKey}"`);
    await cache.set(`species:${key}`, fallback);
  }
  return fallback;
}

/**
 * Resolves a National Pokédex number to its species' display name (e.g.
 * 398 -> "Staraptor"). For the rare case a source only gives a dex number,
 * never a name - see worker/core/miniscord-gym.js for why a mega raid's
 * true boss is only ever conveyed this way. Every other resolveSpecies
 * caller already has real display text and only needs sprite/types, so
 * this is intentionally the only direction that goes number -> name.
 * @returns {Promise<string|null>}
 */
export async function resolveSpeciesNameByDexNumber(dexNumber, cache = defaultCache) {
  const cacheKey = `dexName:${dexNumber}`;
  const cached = await cache.get(cacheKey);
  if (cached !== null && cached !== undefined) return cached;
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${dexNumber}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const name = data.name.charAt(0).toUpperCase() + data.name.slice(1);
    await cache.set(cacheKey, name);
    return name;
  } catch (err) {
    console.warn(`[species-resolver] could not resolve dex number ${dexNumber}:`, err.message);
    return null;
  }
}

// PokeAPI's item slug for a Poke Ball is hyphenated; the in-game name isn't.
const ITEM_SLUG_OVERRIDES = { pokeball: "poke-ball" };
const CUSTOM_ITEM_SPRITES = {
  "golden-pinap-berry": "https://edgarborja.github.io/cusucomap/item-sprites/golden-pinap-berry.png",
  "golden-razz-berry": "https://edgarborja.github.io/cusucomap/item-sprites/golden-razz-berry.png",
  "razz-berry": "https://edgarborja.github.io/cusucomap/item-sprites/razz-berry.png",
  poffin: "https://edgarborja.github.io/cusucomap/item-sprites/poffin.png",
};

/** @returns {Promise<string|null>} sprite URL, or null if unresolvable. */
export async function resolveItemSprite(itemRaw, cache = defaultCache) {
  const key = normalizeSpeciesKey(itemRaw);
  if (!key) return null;
  if (CUSTOM_ITEM_SPRITES[key]) return CUSTOM_ITEM_SPRITES[key];

  const cached = await cache.get(`item:${key}`);
  if (cached !== null && cached !== undefined) return cached;

  const slug = ITEM_SLUG_OVERRIDES[key] || key;
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/item/${slug}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const spriteUrl = data.sprites?.default ?? null;
    await cache.set(`item:${key}`, spriteUrl);
    return spriteUrl;
  } catch (err) {
    console.warn(`[species-resolver] could not resolve item sprite for "${itemRaw}" (slug "${slug}"):`, err.message);
    return null;
  }
}
