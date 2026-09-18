// Command-building and validation for a species scan (see worker-app.js's
// runSpeciesScan) - "find this one species anywhere on the map", a single
// /pokesearch by dex number and nothing else. An earlier version followed
// up with extra narrower queries when the base one hit the search
// command's own per-query result cap (see the
// "project_scan_feature_v1_hexlattice" memory) - that's gone now: hitting
// the cap just means the rest aren't found this time, and the worker
// returns to the normal schedule after the one search.
//
// The operator's own (self) species scans run this command as-is, in their
// own normal browser tab, which already carries the tracked channel's own
// ambient geofilter - genuinely "anywhere on the map". A subscriber's scan
// instead runs in the dedicated second tab (see area-scan.js's
// wrapForSubscriberScanTab), whose channel carries no ambient geofilter of
// its own, so it adds an explicit fixed center/radius to the same command -
// same reasoning as the area scan's own explicit coordinates.
import { wrapForSubscriberScanTab } from "./area-scan.js";

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

/**
 * @param {number} dexNumber - already validated via isValidDexNumber.
 * @param {{ lat: number, lon: number, radiusKmText: string }} center - fixed
 *   server-side map center/radius (see config.js's
 *   subscriberSpeciesScanCenterLat/Lon/RadiusKmText) - unlike the operator's
 *   own tab, the dedicated scan channel carries no ambient geofilter of its
 *   own, so this has to be explicit on every command or the search isn't
 *   restricted to anywhere near this map at all. Same reasoning as
 *   buildSubscriberAreaScanCommand's own coordinates.
 */
export function buildSubscriberSpeciesScanCommand(dexNumber, { lat, lon, radiusKmText }) {
  return wrapForSubscriberScanTab(`/pokesearch ${dexNumber} ${lat.toFixed(6)},${lon.toFixed(6)} ${radiusKmText}km`);
}
