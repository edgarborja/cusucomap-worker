// Command-text building for a /questsearch call submitted through
// miniscord (see worker/connectors/miniscord-connector.js). Same quoting
// rule as /pokesearch (see miniscord-pokesearch.js's own comment, and
// questsearch-api.md's "same rules as /pokesearch's command field"): the
// combined argument is quoted whenever it has more than one token, never
// quoted for a single bare token.
//
// Unlike the old AHK path (worker/core/scan-groups.js's now-removed
// buildQuestGroupCommands, three commands per location - a geofilter set
// plus one /questsearch call each for "encounter" and "item"), this is
// one call per location with no reward-type filter at all: the response
// already carries each result's own rewardType, so there's nothing a
// second, type-filtered call would add.

/**
 * @param {...(string|number)} tokens - parts to join with a space, in
 *   order (falsy/empty ones are dropped) - e.g. "lat,lon", "Nkm".
 * @returns {string} a full "/questsearch ..." command, quoted iff the
 *   combined text has more than one token.
 */
export function buildMiniscordQuestsearchCommand(...tokens) {
  const text = tokens.filter((t) => t !== null && t !== undefined && t !== "").join(" ");
  return text.includes(" ") ? `/questsearch "${text}"` : `/questsearch ${text}`;
}
