// Command-building and validation for a species scan (see worker-app.js's
// runSpeciesScan) - the sibling to worker/core/area-scan.js's location-based
// lattice, but for "find this one species anywhere on the map" instead.
// Unlike an area scan, there's no location/radius/rings to compute here -
// just a plain species-number search, plus a fixed follow-up set used only
// when that alone hits the search command's own per-query result cap.

// National pokedex numbers only go into the low thousands today, but this
// deliberately leaves headroom rather than hardcoding today's exact max -
// re-validated here regardless of whatever validation already happened
// client-side, since this number gets typed directly into a live session.
const MAX_DEX_NUMBER = 4096;

/** @returns {boolean} true if `value` is safe to embed in a /pokesearch command as a dex number. */
export function isValidDexNumber(value) {
  return Number.isInteger(value) && value > 0 && value < MAX_DEX_NUMBER;
}

/** @param {number} dexNumber - already validated via isValidDexNumber. */
export function buildSpeciesScanCommand(dexNumber) {
  return `/pokesearch ${dexNumber}`;
}

// Minimum-IV/level/remaining-time bands, no maximums - each one alone can
// still hit the same per-query cap the base search does, but together they
// surface a broader mix of a common species than the one capped base query
// would on its own. Fixed set, not configurable - see the plan discussion
// this came out of for why these particular seven.
/** @param {number} dexNumber - already validated via isValidDexNumber. */
export function buildExtendedSpeciesScanCommands(dexNumber) {
  return [
    `/pokesearch ${dexNumber} iv66`,
    `/pokesearch ${dexNumber} iv33`,
    `/pokesearch ${dexNumber} iv0`,
    `/pokesearch ${dexNumber} lvl20`,
    `/pokesearch ${dexNumber} lvl10`,
    `/pokesearch ${dexNumber} lvl1`,
    `/pokesearch ${dexNumber} 20m`,
  ];
}

// Only the base query's own result count decides whether the extended
// queries run at all - see worker-app.js's runSpeciesScan.
export const EXTENDED_SCAN_TRIGGER_COUNT = 12;
