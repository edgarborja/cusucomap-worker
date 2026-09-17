// Area-scan command building - two different shapes for two different
// callers (see worker-app.js's runAreaScan):
//
// - The operator's own commands-page scans (self) keep the original
//   hex-lattice design unchanged: a triangular lattice of many small
//   circles, each its own self-contained /pokesearch command, run in the
//   operator's own normal browser tab.
// - A subscriber-requested scan runs a single search in a second,
//   dedicated browser tab instead (see the
//   "project_scan_feature_v1_hexlattice" memory for the two earlier
//   designs this replaced, and why).

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
  return `/pokesearch ${radiusKmText}km ${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// --- Subscriber ("cusuco") scans: dedicated second browser tab --------

// A subscriber's scan runs in a second, dedicated browser tab (switched to
// via Ctrl+2, back via Ctrl+1 once done) instead of sharing the operator's
// own normal tab - replacing an earlier design that reset the geofilter
// via /pokeset commands there instead (see the
// "project_scan_feature_v1_hexlattice" memory: those didn't always get
// processed reliably). The whole action - switch, search, switch back -
// is one single queued item on the AHK side (see worker-bridge/
// http_send.ahk's RunTabSwitchSearch), so nothing else can interleave
// mid-sequence or land in the wrong tab.
//
// Mirrors AhkConnector's own HOTKEY_PREFIX and http_send.ahk's
// TABSEARCH_PREFIX/PART_SEPARATOR - duplicated rather than imported, since
// core/ command-building modules stay free of any dependency on
// connectors/, and the AHK side is a different language entirely. Must
// stay in sync if either of those change.
const TABSEARCH_PREFIX = "#TABSEARCH# ";
const PART_SEPARATOR = "\x1f"; // ASCII Unit Separator - never appears in a coordinate/radius/dex-number command

/**
 * Wraps `commandText` to run in the dedicated second tab: switch to it,
 * type and submit `commandText`, switch back. Safe only because every
 * value ever interpolated into `commandText` by this file's own callers
 * (coordinates, the fixed radius) is already validated as plain digits/
 * `.`/`,`/`-`/`:`/space - never reuse this for less-controlled input
 * without re-checking that (the RunTabSwitchSearch side types it via
 * SendText, so it's typed literally regardless, but PART_SEPARATOR itself
 * must never appear inside it).
 */
export function wrapForSubscriberScanTab(commandText) {
  return `${TABSEARCH_PREFIX}^2${PART_SEPARATOR}${commandText}${PART_SEPARATOR}^1`;
}

/** @param {{ lat: number, lon: number, radiusKmText: string }} point */
export function buildSubscriberAreaScanCommand({ lat, lon, radiusKmText }) {
  return wrapForSubscriberScanTab(`/pokesearch ${lat.toFixed(6)},${lon.toFixed(6)} ${radiusKmText}km`);
}
