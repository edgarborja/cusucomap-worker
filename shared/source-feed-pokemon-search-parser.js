// Pure DOM-parsing logic for two message shapes NOT covered by
// userscript/fieldresearch-parser.js: a `/pokesearch` pokemon-search reply,
// and a raid-search reply (`/raidsearch` or similar) - kept here as real,
// testable functions rather than inline in
// worker/connectors/source-feed-connector.js. Reuses parseRelativeMinutes
// and isNoResultsAck from fieldresearch-parser.js rather than duplicating
// those too.
import { parseRelativeMinutes } from "../userscript/fieldresearch-parser.js";

const TEAM_LABELS = { mystic: "Mystic", valor: "Valor", instinct: "Instinct" };

export function emojiLabel(img) {
  const dataName = img.getAttribute("data-name");
  const alt = img.getAttribute("alt");
  return (dataName || alt || "").toLowerCase().replace(/^:|:$/g, "");
}

export function sanitizeMoveName(text) {
  if (!text) return null;
  return /[\d()]/.test(text) ? null : text;
}

export function decodeHtmlEntities(text, doc) {
  const el = doc.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

export function parseGenderAndShiny(labels) {
  let gender = null;
  let shiny = false;
  for (const label of labels) {
    if (label.includes("female")) gender = "female";
    else if (label.includes("male")) gender = "male";
    if (label.includes("shiny")) shiny = true;
  }
  return { gender, shiny };
}

export function siblingTextAfterEmoji(img) {
  if (!img) return null;
  const container = img.closest('span[class*="emojiContainer"]') || img.parentElement;
  const sibling = container?.nextElementSibling;
  return sibling ? sibling.textContent.replace(/\n/g, " ").trim() : null;
}

/** A message's own content element, addressed by the `chat-messages-<channel>-<message>` id convention Source Feed uses. */
export function ownMessageContentEl(messageEl) {
  const match = messageEl.id.match(/-(\d+)$/);
  if (!match) return messageEl.querySelector('[id^="message-content-"]');
  return messageEl.querySelector(`#message-content-${match[1]}`) || messageEl.querySelector('[id^="message-content-"]');
}

/** One pokemon record from a `/pokesearch` reply's DOM child-node segment. */
export function parsePokesearchRecord(nodes) {
  const doc = nodes.find((n) => n.ownerDocument)?.ownerDocument;
  if (!doc) return null;
  const scratch = doc.createElement("div");
  nodes.forEach((n) => scratch.appendChild(n.cloneNode(true)));

  const strongs = Array.from(scratch.querySelectorAll("strong"));
  const speciesStrong = strongs.find((s) => {
    const t = (s.textContent || "").trim();
    if (!t || /^[\d.]+$/.test(t)) return false;
    if (/\bwithin\b.*km of\b/i.test(t)) return false;
    return true;
  });
  const formSuffix = speciesStrong?.nextElementSibling?.textContent?.trim();
  const disguiseMatch = formSuffix?.match(/^\{(.+)\}$/);
  const disguisedAs = disguiseMatch ? disguiseMatch[1].trim() : null;
  const species = speciesStrong
    ? decodeHtmlEntities([speciesStrong.textContent.trim(), disguiseMatch ? null : formSuffix].filter(Boolean).join(" "), doc)
    : null;
  if (!species) return null;

  const emojiImgs = Array.from(scratch.querySelectorAll("img.emoji"));
  const labels = emojiImgs.map(emojiLabel);
  const { gender, shiny } = parseGenderAndShiny(labels);
  const findEmoji = (label) => emojiImgs.find((im) => emojiLabel(im) === label);

  const ivImg = findEmoji("iv");
  const ivText = siblingTextAfterEmoji(ivImg);
  const ivStrongEl = ivImg?.closest("strong");
  const isPerfectIv = Boolean(ivStrongEl && Array.from(ivStrongEl.querySelectorAll("img.emoji")).some((im) => emojiLabel(im) === "100"));
  const spreadText = ivStrongEl?.nextElementSibling?.textContent || "";
  let spread = spreadText.match(/(\d+)\D+(\d+)\D+(\d+)/);

  const cpText = siblingTextAfterEmoji(findEmoji("cp"));
  const lvText = siblingTextAfterEmoji(findEmoji("lv"));

  const movesRawText = siblingTextAfterEmoji(findEmoji("ms")) || "";
  const trailingSpread = ivImg ? null : movesRawText.match(/\(\s*(\d+)\D+(\d+)\D+(\d+)\s*\)\s*$/);
  if (trailingSpread) spread = trailingSpread;
  const movesText = trailingSpread ? movesRawText.slice(0, trailingSpread.index).trim() : movesRawText;
  const moves = movesText ? movesText.split("/").map((s) => s.trim()) : [];

  const atk = spread ? Number(spread[1]) : null;
  const def = spread ? Number(spread[2]) : null;
  const sta = spread ? Number(spread[3]) : null;
  const ivPercent = ivText ? Number(ivText) : isPerfectIv ? 100 : trailingSpread ? Math.round(((atk + def + sta) / 45) * 1000) / 10 : null;

  const flagImg = emojiImgs.find((im) => emojiLabel(im).startsWith("flag_"));
  const cityRaw = siblingTextAfterEmoji(flagImg);
  const countryFlag = flagImg ? flagImg.getAttribute("alt") : null;

  const fullText = scratch.textContent || "";
  const sizeMatch = fullText.match(/\((XXS|XS|S|M|L|XL|XXL)\)\s*\(/);
  const sizeTag = sizeMatch ? sizeMatch[1] : null;

  const despawn = fullText.match(/\(in\s+(\d+)\s*(minute|second)s?\)/i);
  let despawnInMinutes = null;
  if (despawn) {
    const n = Number(despawn[1]);
    despawnInMinutes = despawn[2].toLowerCase() === "second" ? n / 60 : n;
  }

  const mapsLink = scratch.querySelector('a[href*="google.com/maps"], a[href*="maps.google.com"]');
  const coordsMatch = mapsLink?.getAttribute("href")?.match(/[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const exactCoords = coordsMatch ? { lat: Number(coordsMatch[1]), lon: Number(coordsMatch[2]) } : null;

  return {
    species,
    disguisedAs,
    gender,
    shiny,
    ivPercent,
    atk,
    def,
    sta,
    cp: cpText ? Number(cpText) : null,
    level: lvText ? Number(lvText) : null,
    sizeTag,
    move1: sanitizeMoveName(moves[0]),
    move2: sanitizeMoveName(moves[1]),
    cityRaw,
    countryFlag,
    despawnInMinutes,
    exactCoords,
  };
}

export function parsePokesearchReply(messageEl) {
  const contentEl = ownMessageContentEl(messageEl);
  if (!contentEl) return [];

  const children = Array.from(contentEl.childNodes);
  const mapsLinkIndices = [];
  children.forEach((node, i) => {
    if (node.nodeType === 1 && node.tagName === "A" && /google\.com\/maps|maps\.google\.com/.test(node.getAttribute("href") || "")) {
      mapsLinkIndices.push(i);
    }
  });
  if (mapsLinkIndices.length === 0) return [];

  const firstStrong = contentEl.querySelector("strong");
  const hasHeader = Boolean(firstStrong && /^Found these .*\bwithin\b.*km of/i.test(firstStrong.textContent || ""));
  let start = 0;
  if (hasHeader) {
    const idx = children.findIndex((n) => n === firstStrong || (n.contains && n.contains(firstStrong)));
    if (idx !== -1) start = idx + 1;
  }

  const records = [];
  for (const endIdx of mapsLinkIndices) {
    records.push(children.slice(start, endIdx + 1));
    start = endIdx + 1;
  }
  return records.map(parsePokesearchRecord).filter(Boolean);
}

/** One raid record from a raid-search reply's DOM child-node segment. */
export function parseRaidSearchRecord(nodes, doc) {
  const scratch = doc.createElement("div");
  nodes.forEach((n) => scratch.appendChild(n.cloneNode(true)));

  const lines = scratch.textContent.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 5) return null;

  const speciesMatch = lines[1].match(/^(.+?)\s*\([^)]*\)\s*(?:[({]([^)}]+)[)}])?$/);
  const cpEndsMatch = lines[3].match(/^(\d+)\s*\|\s*Ends\s+(.+?)\s*\([^)]*\)$/);
  if (!cpEndsMatch) return null;
  const endsInMinutesRaw = parseRelativeMinutes(cpEndsMatch[2]);
  if (endsInMinutesRaw === null) return null;

  const [move1 = null, move2 = null] = lines[2].split("/").map((m) => m.trim());
  const labels = Array.from(scratch.querySelectorAll("img.emoji")).map(emojiLabel);

  const mapsLink = scratch.querySelector('a[href*="maps/search"]');
  const coordsMatch = mapsLink?.getAttribute("href")?.match(/[?&]query=(-?\d+\.\d+),(-?\d+\.\d+)/);

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
    exactLat: coordsMatch ? Number(coordsMatch[1]) : null,
    exactLon: coordsMatch ? Number(coordsMatch[2]) : null,
  };
}

export function parseRaidSearchReply(messageEl) {
  const contentEl = ownMessageContentEl(messageEl);
  if (!contentEl) return [];

  const children = Array.from(contentEl.childNodes);
  const mapsLinkIndices = [];
  children.forEach((node, i) => {
    if (node.nodeType === 1 && node.tagName === "A" && /maps\/search/.test(node.getAttribute("href") || "")) {
      mapsLinkIndices.push(i);
    }
  });
  if (mapsLinkIndices.length === 0) return [];

  const firstStrong = contentEl.querySelector("strong");
  const hasHeader = Boolean(firstStrong && /^Found these .*\bwithin\b.*km of/i.test(firstStrong.textContent || ""));
  let start = 0;
  if (hasHeader) {
    const idx = children.findIndex((n) => n === firstStrong || (n.contains && n.contains(firstStrong)));
    if (idx !== -1) start = idx + 1;
  }

  const doc = contentEl.ownerDocument;
  const segments = [];
  for (const endIdx of mapsLinkIndices) {
    segments.push(children.slice(start, endIdx + 1));
    start = endIdx + 1;
  }
  return segments.map((seg) => parseRaidSearchRecord(seg, doc)).filter(Boolean);
}
