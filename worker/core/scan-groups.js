// Parses the operator-pasted CSV of scan-group centers (see worker/
// index.html's bulk-scan sections) and builds the AHK command sequence for
// a full quest or raid pass over them, one geofilter-set + search
// command(s) per group. Column lookup is by header name (case-insensitive,
// order-independent), not fixed position, so a differently-ordered export
// of the same shape still works - the only real requirement is Latitude/
// Longitude/Distance columns existing somewhere in the header.
//
// Distance is in *meters* (this is what the grouping tool that produces
// this CSV emits) - the AHK geofilter command's radius: parameter is in
// kilometers, so every row's Distance gets divided by 1000 here.
const REQUIRED_COLUMNS = ["latitude", "longitude", "distance"];

/** @returns {Record<string, number> | null} column name -> index, or null if a required column is missing. */
function findColumnIndexes(headerCells) {
  const normalized = headerCells.map((c) => c.trim().toLowerCase());
  const indexes = {};
  for (const name of REQUIRED_COLUMNS) {
    const i = normalized.indexOf(name);
    if (i === -1) return null;
    indexes[name] = i;
  }
  return indexes;
}

/**
 * @param {string} csvText
 * @returns {{ groups: {lat: string, lon: string, radiusKm: string}[], errors: string[] }}
 *   `lat`/`lon` are passed through as-is (whatever precision the CSV had) -
 *   only Distance needs actual numeric conversion.
 */
export function parseScanGroupsCsv(csvText) {
  const lines = (csvText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { groups: [], errors: ["Empty - paste the CSV contents first."] };

  const header = lines[0].split(",");
  const indexes = findColumnIndexes(header);
  if (!indexes) return { groups: [], errors: [`Header must include Latitude, Longitude, and Distance columns - got: "${lines[0]}"`] };

  const groups = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const lat = cells[indexes.latitude]?.trim();
    const lon = cells[indexes.longitude]?.trim();
    const distanceMeters = Number(cells[indexes.distance]?.trim());
    if (!lat || !lon || !Number.isFinite(distanceMeters)) {
      errors.push(`Row ${i + 1}: couldn't parse - "${lines[i]}"`);
      continue;
    }
    groups.push({ lat, lon, radiusKm: (distanceMeters / 1000).toFixed(5) });
  }
  return { groups, errors };
}

// The geofilter commands are real Discord slash commands with two named
// parameters (center, radius) - a plain space between them just becomes
// part of the center value's own text, it doesn't move to the next
// parameter field. A literal Tab character does, so http_send.ahk's
// TypeIt sends a real {Tab} keypress whenever it hits one, rather than
// typing it as text (see that file's Chars loop).
const PARAM_SEPARATOR = "\t";

/** @param {{lat: string, lon: string, radiusKm: string}} group */
export function buildQuestGroupCommands({ lat, lon, radiusKm }) {
  return [`/questset geofilter center:${lat},${lon}${PARAM_SEPARATOR}radius:${radiusKm}`, "/questsearch encounter", "/questsearch item"];
}

/** @param {{lat: string, lon: string, radiusKm: string}} group */
export function buildRaidGroupCommands({ lat, lon, radiusKm }) {
  return [`/raidset geofilter center:${lat},${lon}${PARAM_SEPARATOR}radius:${radiusKm}`, "/raidsearch hatched"];
}
