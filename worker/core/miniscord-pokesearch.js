// Command-text building for a /pokesearch call submitted through
// miniscord (see worker/connectors/miniscord-connector.js) - shared by
// area-scan.js and species-scan.js's own subscriber-scan builders.
//
// miniscord's underlying bot command takes a single free-text argument
// that can combine species/location/radius/filter tokens in any mix
// (confirmed live: "/pokesearch 25 13.677440,-89.283353 10km" combines a
// dex number with a location+radius in one argument) - discordo (the
// bot integration miniscord itself wraps) requires that whole argument to
// be quoted whenever it contains more than one space-separated token; a
// single bare token (e.g. just a dex number) must NOT be quoted, or it's
// resolved as a different/invalid interaction. This wraps that rule once
// so every caller building a /pokesearch command for miniscord gets it
// right without re-deriving it.

/**
 * @param {...(string|number)} tokens - parts to join with a space, in
 *   order (falsy/empty ones are dropped) - e.g. a dex number, "lat,lon",
 *   "Nkm".
 * @returns {string} a full "/pokesearch ..." command, quoted iff the
 *   combined text has more than one token.
 */
export function buildMiniscordPokesearchCommand(...tokens) {
  const text = tokens.filter((t) => t !== null && t !== undefined && t !== "").join(" ");
  return text.includes(" ") ? `/pokesearch "${text}"` : `/pokesearch ${text}`;
}
