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

  const slug = SPECIES_SLUG_OVERRIDES[key] || key;
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const result = { spriteUrl: `${SPRITE_BASE}${data.id}.png`, types: (data.types ?? []).map((t) => t.type.name) };
    await cache.set(`species:${key}`, result);
    return result;
  } catch (err) {
    console.warn(`[species-resolver] could not resolve "${speciesRaw}" (slug "${slug}"):`, err.message);
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
