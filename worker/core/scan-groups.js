// Parses the operator-pasted CSV of scan-group centers (see worker/
// index.html's Quest scan section) into per-location {lat, lon, radiusKm}
// groups - worker-app.js's own wireQuestScanSection turns each into one
// miniscord POST /questsearch call (see core/miniscord-questsearch.js).
// Column lookup is by header name (case-insensitive, order-independent),
// not fixed position, so a differently-ordered export of the same shape
// still works - the only real requirement is Latitude/Longitude/Distance
// columns existing somewhere in the header.
//
// Distance is in *meters* (this is what the grouping tool that produces
// this CSV emits), so every row's Distance gets divided by 1000 here to
// match the km radius miniscord's own commands expect.
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
