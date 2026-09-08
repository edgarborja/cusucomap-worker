// Points-of-interest resolution. Given a quest's pokestop name or a raid's
// gym name, finds the matching bundled POI by exact (title, entity-type)
// match, disambiguated by distance when more than one location shares that
// exact name.
import { POI_DATA } from "./generated/poi-data.js";

function haversineDistanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const poiIndex = new Map(); // "S|title" or "G|title" -> [{id, lat, lon}]
for (const [id, entityChar, title, lat, lon] of POI_DATA) {
  const key = `${entityChar}|${title}`;
  if (!poiIndex.has(key)) poiIndex.set(key, []);
  poiIndex.get(key).push({ id, lat, lon });
}

/**
 * @param {string} title - pokestop/gym name as posted by the bot.
 * @param {"S"|"G"} entityChar
 * @param {{lat:number,lon:number}|null} exactLatLon - disambiguation anchor when the caller has one on hand (e.g. a search reply's own Maps link); falls back to `geofilterAnchor`.
 * @param {{lat:number,lon:number}} geofilterAnchor - the channel's configured disambiguation center (operator config), used when no exact coords are available.
 * @returns {{id:number, lat:number, lon:number}|null} - never guesses; returns null if the name isn't a known POI.
 */
export function resolvePoi(title, entityChar, exactLatLon, geofilterAnchor) {
  const candidates = poiIndex.get(`${entityChar}|${title}`) || [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const anchor = exactLatLon || geofilterAnchor;
  let best = null;
  let bestKm = Infinity;
  for (const c of candidates) {
    const km = haversineDistanceKm(anchor, c);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return best;
}
