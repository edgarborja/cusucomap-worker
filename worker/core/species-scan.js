// Command-building and validation for a species scan (see worker-app.js's
// runSpeciesScan) - "find this one species nearby", a single /pokesearch
// by dex number and nothing else, submitted through miniscord (see
// worker/connectors/miniscord-connector.js) for the operator's own (self)
// request and a subscriber's alike - there's no meaningful difference
// between them in command text any more, only in authorization and where
// the results end up (self publishes organically, a subscriber's go into
// a private pool - see runSpeciesScan). An earlier version followed up
// with extra narrower queries when the base one hit the search command's
// own per-query result cap (see the "project_scan_feature_v1_hexlattice"
// memory) - that's gone now: hitting the cap just means the rest aren't
// found this time, and the worker moves on.
//
// miniscord's own channel carries no ambient geofilter (unlike the
// operator's tab, back when this ran there) - so this always needs an
// explicit center/radius, or the search covers the entire world (confirmed
// live) instead of just this map.
import { buildMiniscordPokesearchCommand } from "./miniscord-pokesearch.js";

// National pokedex numbers only go into the low thousands today, but this
// deliberately leaves headroom rather than hardcoding today's exact max -
// re-validated here regardless of whatever validation already happened
// client-side, since this number gets embedded directly into a live command.
const MAX_DEX_NUMBER = 4096;

/** @returns {boolean} true if `value` is safe to embed in a /pokesearch command as a dex number. */
export function isValidDexNumber(value) {
  return Number.isInteger(value) && value > 0 && value < MAX_DEX_NUMBER;
}

/**
 * @param {number} dexNumber - already validated via isValidDexNumber.
 * @param {{ lat: number, lon: number, radiusKmText: string }} center - see
 *   config.js's defaultSearchCenterLat/Lon/RadiusKmText.
 */
export function buildSpeciesScanCommand(dexNumber, { lat, lon, radiusKmText }) {
  return buildMiniscordPokesearchCommand(dexNumber, `${lat.toFixed(6)},${lon.toFixed(6)}`, `${radiusKmText}km`);
}
