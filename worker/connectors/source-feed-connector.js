// Turns raw scraped Source Feed message HTML (forwarded by the operator's
// Tampermonkey companion script - see worker-bridge/README.md for where it
// actually lives) into normalized `spawn.observed` /
// `quest.observed` / `raid.observed` events on the EventBus. This is the
// "Normalization" stage of the processing pipeline; it does not decide what
// becomes authoritative state (that's services/pokemon-state.js) and it
// never publishes to Nostr directly.
//
// Message-shape routing order (no-results ack -> quest search results ->
// raid search results -> pokesearch results -> plain quest -> plain raid)
// matters - a search-result reply's :pokestop: emoji can otherwise
// false-match the plain quest detector, etc.
import { parseQuestMessage, parseRaidMessage, parseSearchResultMessage, isNoResultsAck } from "../../userscript/fieldresearch-parser.js";
import { parsePokesearchReply, parseRaidSearchReply, ownMessageContentEl } from "../../shared/source-feed-pokemon-search-parser.js";
import { resolvePoi } from "../../shared/poi-resolver.js";
import { resolveSpecies, resolveItemSprite, FALLBACK_SPRITE_URL } from "../../shared/species-resolver.js";
import { stableIntId, stableSpawnKey, snowflakeToMs, ivTier } from "../../shared/stable-id.js";
import { BRIDGE_EVENTS, bridgeChannel } from "../transports/bridge-channel.js";

const MEGA_ENERGY_RE = /^Mega Energy \(([^)]+)\)$/i;
const MAX_SEEN_MESSAGE_IDS = 5000;

export class SourceFeedConnector {
  #bus;
  #logger;
  #state;
  #getGeofilterAnchor;
  #getTrackedChannelIds;
  #seenMessageIds = new Set();
  #speciesCache;

  /**
   * @param {() => {lat:number, lon:number}} getGeofilterAnchor - lazy accessor for the
   *   configured disambiguation center, used only when a quest/raid name
   *   matches more than one bundled POI and no exact coordinates came with it.
   * @param {() => string[]} getTrackedChannelIds - Source Feed channel ids the bridge should scrape; pushed to it on start() and whenever a Source Feed tab (re)connects, since the bridge script itself has no hardcoded channel to fall back on.
   */
  constructor({ bus, logger, state, getGeofilterAnchor, getTrackedChannelIds }) {
    this.#bus = bus;
    this.#logger = logger;
    this.#state = state;
    this.#getGeofilterAnchor = getGeofilterAnchor;
    this.#getTrackedChannelIds = getTrackedChannelIds;
    this.#speciesCache = {
      get: (key) => this.#state.workerMetadata.get(`speciesResolverCache:${key}`, null),
      set: (key, value) => this.#state.workerMetadata.set(`speciesResolverCache:${key}`, value),
    };
  }

  #pushTrackedChannels() {
    bridgeChannel.send(BRIDGE_EVENTS.SET_TRACKED_CHANNEL_IDS, { channelIds: this.#getTrackedChannelIds() });
  }

  start() {
    bridgeChannel.on(BRIDGE_EVENTS.SOURCE_FEED_MESSAGE, (msg) => this.#handleMessage(msg).catch((err) => this.#logger.error("source-feed", `handleMessage threw: ${err.message}`)));
    this.#pushTrackedChannels();

    // The bridge script only tells us it's alive when it sends a status
    // heartbeat - the *absence* of one (bridge script disabled, Source Feed tab
    // closed, wrong page matched) has to be detected here via a watchdog,
    // not assumed away.
    let lastStatusAt = 0;
    let wasConnected = false;
    bridgeChannel.on(BRIDGE_EVENTS.SOURCE_FEED_BRIDGE_STATUS, (status) => {
      lastStatusAt = Date.now();
      // A Source Feed tab that just (re)connected - a fresh tab, a reload, a
      // second tab watching a different channel - starts from whatever
      // GM storage last persisted, which could be stale or (on a
      // brand-new install) empty. Re-pushing here, not just once in
      // start() above, is what makes that tab converge on the real list
      // without needing the worker itself to restart.
      if (!wasConnected) this.#pushTrackedChannels();
      wasConnected = true;
      this.#bus.emit("source-feed.bridge-status", { ...status, connected: true });
    });
    const STALE_AFTER_MS = 15_000;
    setInterval(() => {
      if (lastStatusAt !== 0 && Date.now() - lastStatusAt > STALE_AFTER_MS) {
        wasConnected = false;
        this.#bus.emit("source-feed.bridge-status", { connected: false });
      }
    }, 5_000);
  }

  #markSeen(messageId) {
    this.#seenMessageIds.add(messageId);
    if (this.#seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      const it = this.#seenMessageIds.values();
      for (let i = 0; i < 1000; i++) this.#seenMessageIds.delete(it.next().value);
    }
  }

  /** @param {{ channelId: string, messageId: string, outerHTML: string }} raw */
  async #handleMessage({ channelId, messageId, outerHTML }) {
    // Not a correctness guard (downstream ApplicationState.upsert already
    // no-ops on a byte-identical resend) - just avoids re-parsing/re-fetching
    // sprites for the same message every time the bridge's periodic rescan
    // (see the bridge script) re-reports something still on screen.
    if (this.#seenMessageIds.has(messageId)) return;

    const doc = new DOMParser().parseFromString(outerHTML, "text/html");
    const messageEl = doc.body.firstElementChild;
    if (!messageEl) return;
    const contentEl = ownMessageContentEl(messageEl);
    if (!contentEl) return;

    const ids = { channelId, messageId };

    if (isNoResultsAck(contentEl)) {
      this.#markSeen(messageId);
      return;
    }

    const searchResults = parseSearchResultMessage(contentEl);
    if (searchResults) {
      this.#markSeen(messageId);
      this.#logger.info("source-feed", `parsed search result: ${searchResults.length} quest(s) in msg ${messageId}`);
      await Promise.all(searchResults.map((quest, i) => this.#emitQuest({ ...ids, messageId: `${messageId}:${i}` }, quest)));
      return;
    }

    const raidSearchResults = parseRaidSearchReply(messageEl);
    if (raidSearchResults.length > 0) {
      this.#markSeen(messageId);
      this.#logger.info("source-feed", `parsed raid search result: ${raidSearchResults.length} raid(s) in msg ${messageId}`);
      await Promise.all(raidSearchResults.map((raid, i) => this.#emitRaid({ ...ids, messageId: `${messageId}:${i}` }, raid)));
      return;
    }

    const pokesearchResults = parsePokesearchReply(messageEl);
    if (pokesearchResults.length > 0) {
      this.#markSeen(messageId);
      this.#logger.info("source-feed", `parsed pokesearch result: ${pokesearchResults.length} pokemon in msg ${messageId}`);
      await Promise.all(pokesearchResults.map((spawn, i) => this.#emitSpawn(ids, spawn, i)));
      return;
    }

    const quest = parseQuestMessage(contentEl);
    if (quest) {
      this.#markSeen(messageId);
      this.#logger.info("source-feed", `parsed quest: ${quest.rewardName} @ ${quest.pokestopName}`);
      await this.#emitQuest(ids, quest);
      return;
    }

    const raid = parseRaidMessage(contentEl);
    if (raid) {
      this.#markSeen(messageId);
      this.#logger.info("source-feed", `parsed raid: ${raid.bossSpecies || "(unknown boss)"} @ ${raid.gymName}`);
      await this.#emitRaid(ids, raid);
      return;
    }

    const text = contentEl.textContent.trim();
    if (/^Will now post/i.test(text) || /^Geofilter set to/i.test(text)) this.#markSeen(messageId);
    // Anything else is left unmarked - a message that doesn't match any
    // detector *yet* might still be mid-render, and the bridge's own
    // periodic rescan will retry it.
  }

  // Field shapes below match Quest/Raid/Spawn in cusucomap-viewer's
  // src/entities.ts exactly - the viewer trusts this content shape as-is.

  async #emitQuest(ids, quest) {
    const exactLatLon = quest.exactLat != null ? { lat: quest.exactLat, lon: quest.exactLon } : null;
    const poi = resolvePoi(quest.pokestopName, "S", exactLatLon, this.#getGeofilterAnchor());
    if (!poi) {
      this.#logger.warn("source-feed", `unknown pokestop "${quest.pokestopName}" - skipping quest (${quest.rewardName})`);
      return;
    }

    const megaMatch = quest.rewardType === "item" ? quest.rewardName.match(MEGA_ENERGY_RE) : null;
    const speciesToResolve = quest.rewardType === "encounter" ? quest.rewardName : megaMatch ? megaMatch[1] : null;
    const sprite = speciesToResolve ? await resolveSpecies(speciesToResolve, this.#speciesCache) : null;
    const itemSpriteUrl = quest.rewardType === "item" && !megaMatch ? await resolveItemSprite(quest.rewardName, this.#speciesCache) : null;

    const expiresAt = new Date(Date.now() + quest.expiresInMinutes * 60000).toISOString();
    this.#bus.emit("quest.observed", {
      id: poi.id,
      channelId: 0,
      messageId: ids.messageId,
      poiId: poi.id,
      pokestopName: quest.pokestopName,
      location: { lat: poi.lat, lon: poi.lon },
      poiPhotoUrl: null,
      rewardType: quest.rewardType,
      rewardName: quest.rewardName,
      rewardQuantity: quest.rewardQuantity,
      rewardForm: quest.rewardForm,
      cityRaw: quest.cityRaw,
      expiresAt,
      scrapedAt: new Date().toISOString(),
      status: "active",
      spriteUrl: sprite ? sprite.spriteUrl : itemSpriteUrl,
      types: sprite ? sprite.types : [],
      isMegaEnergy: megaMatch !== null,
    });
  }

  async #emitRaid(ids, raid) {
    const exactLatLon = raid.exactLat != null ? { lat: raid.exactLat, lon: raid.exactLon } : null;
    const poi = resolvePoi(raid.gymName, "G", exactLatLon, this.#getGeofilterAnchor());
    if (!poi) {
      this.#logger.warn("source-feed", `unknown gym "${raid.gymName}" - skipping raid (${raid.bossSpecies || "unknown boss"})`);
      return;
    }

    const sprite = raid.bossSpecies ? await resolveSpecies(raid.bossSpecies, this.#speciesCache) : null;
    const endsAt = new Date(Date.now() + raid.endsInMinutes * 60000).toISOString();
    this.#bus.emit("raid.observed", {
      id: poi.id,
      channelId: 0,
      messageId: ids.messageId,
      poiId: poi.id,
      gymName: raid.gymName,
      location: { lat: poi.lat, lon: poi.lon },
      team: raid.team,
      bossSpecies: raid.bossSpecies,
      bossForm: raid.bossForm,
      bossCp: raid.bossCp,
      moves: [raid.move1, raid.move2].filter(Boolean),
      shinyEligible: raid.shinyEligible,
      gender: raid.gender,
      endsAt,
      cityRaw: raid.cityRaw,
      scrapedAt: new Date().toISOString(),
      status: "active",
      spriteUrl: sprite ? sprite.spriteUrl : null,
      types: sprite ? sprite.types : [],
    });
  }

  async #emitSpawn(ids, spawn, index) {
    if (spawn.despawnInMinutes === null) {
      this.#logger.warn("source-feed", `no parseable despawn timer for ${spawn.species} - skipping (can't derive despawnAt)`);
      return;
    }
    if (!spawn.exactCoords) {
      this.#logger.warn("source-feed", `no exact coordinates for ${spawn.species} - skipping`);
      return;
    }

    const messageId = `${ids.messageId}:${index}`;
    const id = stableIntId(stableSpawnKey(spawn));
    const sprite = await resolveSpecies(spawn.species, this.#speciesCache);
    const despawnAt = new Date(snowflakeToMs(ids.messageId) + spawn.despawnInMinutes * 60000).toISOString();
    const location = { lat: spawn.exactCoords.lat, lon: spawn.exactCoords.lon };

    this.#bus.emit("spawn.observed", {
      id,
      channelId: 0,
      source: "source-feed", // wire-protocol value (see PROTOCOL.md) - not renamed, the viewer expects this exact string
      messageId,
      species: spawn.species,
      disguisedAs: spawn.disguisedAs,
      gender: spawn.gender,
      shiny: spawn.shiny,
      ivPercent: spawn.ivPercent,
      ivSpread: spawn.atk !== null ? { atk: spawn.atk, def: spawn.def, sta: spawn.sta } : null,
      level: spawn.level,
      cp: spawn.cp,
      sizeTag: spawn.sizeTag,
      moves: [spawn.move1, spawn.move2].filter(Boolean),
      cityRaw: spawn.cityRaw,
      countryFlag: spawn.countryFlag,
      approxLocation: null,
      exactLocation: location,
      bestLocation: location,
      despawnAt,
      scrapedAt: new Date().toISOString(),
      revealPending: false,
      revealedAt: null,
      status: "active",
      ivTier: ivTier(spawn.ivPercent),
      spriteUrl: sprite ? sprite.spriteUrl : FALLBACK_SPRITE_URL,
      types: sprite ? sprite.types : [],
      unevolved: false,
    });
  }
}
