// Pure text/DOM-parsing logic for Source Feed quest/raid/search-result
// messages, kept as real testable functions.

export function emojiLabel(img) {
  const dataName = img.getAttribute("data-name");
  const alt = img.getAttribute("alt");
  return (dataName || alt || "").toLowerCase().replace(/^:|:$/g, "");
}

// Source Feed's relative-time text ("in 15 hours", "2 days ago", "a day ago")
// is the only expiry signal present anywhere in the DOM for these messages
// - no datetime/title attribute is exposed (confirmed against the real
// captured samples in sampledata/fieldresearch*.html). "... ago" only
// shows up when re-scanning old history - mapped to 0 rather than dropped.
const UNIT_MINUTES = { minute: 1, hour: 60, day: 1440 };
export function parseRelativeMinutes(text) {
  const match = text.trim().match(/^(in\s+)?(a|an|\d+)\s+(minute|hour|day)s?(\s+ago)?$/i);
  if (!match) return null;
  const amount = /^(a|an)$/i.test(match[2]) ? 1 : Number(match[2]);
  const minutes = amount * UNIT_MINUTES[match[3].toLowerCase()];
  return match[4] ? -minutes : minutes;
}

// Reward text parses into two shapes (verified against every reward
// string in both sample files):
//   item:      "<Item Name[ (Qualifier)]> x<Qty>"  e.g. "Mega Energy (Sceptile) x10", "Stardust x1000"
//   encounter: "<Species>[ (FORM)] encounter"       e.g. "Rattata (ALOLA) encounter", "Spinda (02) encounter"
export function parseReward(text) {
  const t = text.trim();
  const encounterMatch = t.match(/^(.+?)(?:\s*\(([^)]+)\))?\s+encounter$/i);
  if (encounterMatch) {
    return {
      rewardType: "encounter",
      rewardName: encounterMatch[1].trim(),
      rewardForm: encounterMatch[2] || null,
      rewardQuantity: null,
    };
  }
  const itemMatch = t.match(/^(.+?)\s*x(\d+)$/i);
  if (itemMatch) {
    return {
      rewardType: "item",
      rewardName: itemMatch[1].trim(),
      rewardQuantity: Number(itemMatch[2]),
      rewardForm: null,
    };
  }
  return null;
}

// Quest message shape (3 lines once split on the literal newlines between
// each field's span run):
//   [reward icon] **Reward**
//   [pokestop emoji] Pokestop Name | Ends <relative>
//   [flag emoji] City, Region, Country
export function parseQuestMessage(contentEl) {
  if (!contentEl.querySelector('img.emoji[alt=":pokestop:"]')) return null;
  // A "search"/AR-scan reply batches several of these same quest-shaped
  // blocks into one message plus a Google Maps link per entry - it must be
  // routed to parseSearchResultMessage instead, or this would silently read
  // just its first entry and drop the rest (see parseSearchResultMessage's
  // own comment for how that was found and confirmed against the real
  // ingested data).
  if (contentEl.querySelector('a[href*="maps/search"]')) return null;
  const lines = contentEl.textContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;

  const reward = parseReward(lines[0]);
  if (!reward) return null;

  const stopMatch = lines[1].match(/^(.*?)\s*\|\s*Ends\s+(.+)$/);
  if (!stopMatch) return null;
  const expiresInMinutesRaw = parseRelativeMinutes(stopMatch[2]);
  if (expiresInMinutesRaw === null) return null;

  return {
    pokestopName: stopMatch[1].trim(),
    ...reward,
    cityRaw: lines[2] || null,
    expiresInMinutes: Math.max(expiresInMinutesRaw, 0),
  };
}

// Raid message shape (5 lines):
//   [team emoji] **Gym Name**
//   [species icon?][shiny?] **Species** (<relative>) [(Form)] [gender emoji]
//   [Ms emoji] Move1 / Move2
//   [Cp emoji]**CP** | Ends <relative> (<absolute time-of-day>)
//   [flag emoji] City, Region, Country
// An unhatched egg has no Cp emoji at all in this bot's format, so it's
// simply not recognized as a raid until it hatches and gets one - matching
// the plan's scope of boss species + CP only, no tier/egg tracking.
const TEAM_LABELS = { mystic: "Mystic", valor: "Valor", instinct: "Instinct" };
export function parseRaidMessage(contentEl) {
  if (!contentEl.querySelector('img.emoji[alt=":Cp:"]')) return null;
  const lines = contentEl.textContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 5) return null;

  // The trailing variant/form marker is usually parenthesized ("(Hisuian)")
  // but this bot marks a Mega-Evolution raid boss with curly braces
  // ("{Mega}") instead - both need to be accepted or a Mega boss's whole
  // species line fails to match and bossSpecies comes back null entirely
  // (confirmed against sampledata/gymraids.html's Latias raid).
  const speciesMatch = lines[1].match(/^(.+?)\s*\([^)]*\)\s*(?:[({]([^)}]+)[)}])?$/);
  const cpEndsMatch = lines[3].match(/^(\d+)\s*\|\s*Ends\s+(.+?)\s*\([^)]*\)$/);
  if (!cpEndsMatch) return null;
  const endsInMinutesRaw = parseRelativeMinutes(cpEndsMatch[2]);
  if (endsInMinutesRaw === null) return null;

  const [move1 = null, move2 = null] = lines[2].split("/").map((m) => m.trim());
  const labels = Array.from(contentEl.querySelectorAll("img.emoji")).map(emojiLabel);

  return {
    gymName: lines[0],
    team: TEAM_LABELS[Object.keys(TEAM_LABELS).find((t) => labels.includes(t))] || null,
    bossSpecies: speciesMatch ? speciesMatch[1].trim() : null,
    bossForm: speciesMatch ? speciesMatch[2] || null : null,
    bossCp: Number(cpEndsMatch[1]),
    move1,
    move2,
    shinyEligible: labels.includes("shiny"),
    gender: ["male", "female", "genderless"].find((g) => labels.includes(g)) || null,
    cityRaw: lines[4] || null,
    endsInMinutes: Math.max(endsInMinutesRaw, 0),
  };
}

// Ack from the bot's own "/geofilter" command - the reference center used
// to disambiguate a quest/raid name that matches more than one bundled POI
// (see shared/poi-resolver.js's geofilterAnchor parameter).
const GEOFILTER_RE = /Geofilter set to the area within ([\d.]+)\s*km of (-?\d+\.\d+),\s*(-?\d+\.\d+)\./i;
export function parseGeofilterAck(contentEl) {
  const match = contentEl.textContent.trim().match(GEOFILTER_RE);
  if (!match) return null;
  return { radiusKm: Number(match[1]), lat: Number(match[2]), lon: Number(match[3]) };
}

// A zero-result reply to a species search ("No Pikachu AR quests within
// 0.3km of 13.68,-89.28.") - informational, nothing to send.
const NO_RESULTS_RE = /^No .+ within .+ of .+\.$/i;
export function isNoResultsAck(contentEl) {
  return NO_RESULTS_RE.test(contentEl.textContent.trim());
}

// A non-empty reply to a species search ("/questsearch <species>" or
// similar) - one or more quest-shaped blocks, each followed by a Google
// Maps link giving its *exact* coordinates, unlike a normal quest post.
// The result list is batched across several Source Feed messages when it's
// long (confirmed in the real captured sample: a 21-result search came
// back as 3 separate messages) - only the first one carries the "Found
// these <species> quests within <radius>km of <lat>,<lon>:" header line,
// so that line is stripped when present rather than relied on to detect
// the message at all (a continuation message has none).
//
// Real bug this replaces: before this function existed, a continuation
// message (no header, no :pokestop: URL guard) fell through to
// parseQuestMessage, which read only its first quest-shaped block (lines
// 0-2) and silently ignored the Google Maps link plus every other entry
// in the message - confirmed live in the real database as exactly 3 extra
// "quests" table rows, each a redundant duplicate of a pokestop's already-
// tracked active quest that also (via the normal same-poi_id
// active-quest-replacement logic) incorrectly expired the real original
// row. Anchoring each entry off its own Maps-link line, rather than
// assuming a fixed line count per message, is what makes this immune to
// that same class of bug for any future batch layout.
const FOUND_HEADER_RE = /^Found these .+ within .+ of .+:$/i;
const MAPS_LINK_RE = /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=(-?\d+\.\d+),(-?\d+\.\d+)$/;

export function parseSearchResultMessage(contentEl) {
  if (!contentEl.querySelector('a[href*="maps/search"]')) return null;

  const lines = contentEl.textContent
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Each entry is exactly 4 lines - reward, "pokestop | Ends ...", city,
  // Maps link - confirmed against every entry in the real captured sample.
  // Anchored off the Maps-link line itself (rather than assumed group
  // boundaries) so a missing/reordered line in some future message drops
  // just that one entry instead of throwing off every entry after it.
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (FOUND_HEADER_RE.test(lines[i])) continue;
    const coordMatch = lines[i].match(MAPS_LINK_RE);
    if (!coordMatch) continue;

    const rewardLine = lines[i - 3];
    const stopLine = lines[i - 2];
    const cityLine = lines[i - 1];
    if (!rewardLine || !stopLine) continue;
    const reward = parseReward(rewardLine);
    const stopMatch = stopLine.match(/^(.*?)\s*\|\s*Ends\s+(.+)$/);
    if (!reward || !stopMatch) continue;
    const expiresInMinutesRaw = parseRelativeMinutes(stopMatch[2]);
    if (expiresInMinutesRaw === null) continue;

    results.push({
      pokestopName: stopMatch[1].trim(),
      ...reward,
      cityRaw: cityLine || null,
      expiresInMinutes: Math.max(expiresInMinutesRaw, 0),
      exactLat: Number(coordMatch[1]),
      exactLon: Number(coordMatch[2]),
    });
  }
  // A message can have Maps links without being a quest-search reply at
  // all (e.g. a /pokesearch or /raidsearch reply) - returning [] here (an
  // empty array is truthy) would make a caller's `if (searchResults)`
  // claim the message and stop trying other detectors before any of them
  // ever got a look at it. null means "not this format, keep trying the
  // next detector" the same way the no-Maps-link case above already does.
  return results.length > 0 ? results : null;
}
