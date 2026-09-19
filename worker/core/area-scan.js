// Area-scan command building - two different shapes for two different
// callers (see worker-app.js's runAreaScan), both submitted through
// miniscord (see worker/connectors/miniscord-connector.js):
//
// - The operator's own commands-page scans (self) keep the original
//   hex-lattice design unchanged: a triangular lattice of many small
//   circles, each its own self-contained /pokesearch command.
// - A subscriber-requested scan is a single search instead (see the
//   "project_scan_feature_v1_hexlattice" memory for the earlier designs
//   this replaced, and why).
import { buildMiniscordPokesearchCommand } from "./miniscord-pokesearch.js";

// --- Self (commands page): hex-lattice of small circles ---------------

// Ring 0 is just the center point. Ring k (1..rings) is a hexagon of 6k
// points at "lattice distance" k from center - the standard hex-ring walk
// (see e.g. redblobgames.com/grids/hexagons/#rings), done directly in
// Cartesian km offsets rather than axial hex coordinates, since these are
// literal point locations to search from, not hex grid cells.
//
// Spacing between adjacent circle centers is radiusKm * sqrt(3): the
// tightest lattice spacing that still guarantees zero coverage gaps
// between equal-radius circles. Three mutually-adjacent centers form an
// equilateral triangle of that side length; the worst-covered point (its
// centroid) sits exactly `radiusKm` from each of the three centers, and
// centroid-to-vertex distance = side length / sqrt(3) - so side length
// (the spacing) must be radiusKm * sqrt(3).
const DIRECTION_ANGLES_DEG = [0, 60, 120, 180, 240, 300];

function directionVectors(spacingKm) {
  return DIRECTION_ANGLES_DEG.map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: spacingKm * Math.cos(rad), y: spacingKm * Math.sin(rad) };
  });
}

/** All 6k lattice points at ring `k` (k >= 1), as {x, y} km offsets from center. */
function hexRingOffsets(k, dirs) {
  const points = [];
  // Standard hex-ring walk: start k steps out in direction index 4, then
  // walk all 6 sides of the ring, k steps each, collecting the point
  // before each step - this visits every one of the ring's 6k points
  // exactly once.
  let current = { x: dirs[4].x * k, y: dirs[4].y * k };
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < k; step++) {
      points.push(current);
      current = { x: current.x + dirs[side].x, y: current.y + dirs[side].y };
    }
  }
  return points;
}

/** Number of circles a given ring count produces (1 center + 6k per ring, k=1..rings). */
export function countAreaScanCircles(rings) {
  return 1 + 3 * rings * (rings + 1);
}

/**
 * @param {{ centerLat: number, centerLon: number, radiusKm: number, rings: number }} params
 * @returns {{ lat: number, lon: number }[]} center first, then ring 1, ring 2, ... outward.
 */
export function generateHexLattice({ centerLat, centerLon, radiusKm, rings }) {
  const spacingKm = radiusKm * Math.sqrt(3);
  const dirs = directionVectors(spacingKm);
  const offsets = [{ x: 0, y: 0 }];
  for (let k = 1; k <= rings; k++) offsets.push(...hexRingOffsets(k, dirs));

  // Equirectangular approximation - accurate enough at the sub-few-km
  // radii this feature is meant for (error grows with distance from
  // center and with |latitude|, negligible here).
  const latKmPerDeg = 111.32;
  const lonKmPerDeg = 111.32 * Math.cos((centerLat * Math.PI) / 180);
  return offsets.map(({ x, y }) => ({
    lat: centerLat + y / latKmPerDeg,
    lon: centerLon + x / lonKmPerDeg,
  }));
}

/**
 * @param {{ lat: number, lon: number, radiusKmText: string }} point -
 *   `radiusKmText` is the operator's raw typed radius (e.g. "0.1"),
 *   embedded as-is rather than reformatted from the numeric value used for
 *   lattice spacing.
 */
export function buildAreaScanCommand({ lat, lon, radiusKmText }) {
  return buildMiniscordPokesearchCommand(`${radiusKmText}km`, `${lat.toFixed(6)},${lon.toFixed(6)}`);
}

// --- Subscriber ("cusuco") scans: submitted through miniscord ---------

// A subscriber's scan is submitted through miniscord (see worker/
// connectors/miniscord-connector.js) - a direct REST call to a Discord bot
// integration - rather than typed into a browser tab. Earlier designs
// tried resetting the operator's own tab's geofilter via /pokeset commands,
// then a dedicated second browser tab switched to via AHK hotkeys; see the
// "project_scan_feature_v1_hexlattice" memory for why each of those was
// replaced. miniscord's own channel carries no ambient geofilter of its
// own, so - same as those earlier designs - every command still has to
// carry its own explicit location/radius.

/** @param {{ lat: number, lon: number, radiusKmText: string }} point */
export function buildSubscriberAreaScanCommand({ lat, lon, radiusKmText }) {
  return buildMiniscordPokesearchCommand(`${lat.toFixed(6)},${lon.toFixed(6)}`, `${radiusKmText}km`);
}
