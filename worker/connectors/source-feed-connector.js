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
import { parseQuestMessage, parseRaidMessage, parseSearchResultMessage, isNoResultsAck, detectApplicationError } from "../../userscript/fieldresearch-parser.js";
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
  #getScanChannelId;
  #getActiveScanId;
  #seenMessageIds = new Set();
  #speciesCache;

  /**
   * @param {() => {lat:number, lon:number}} getGeofilterAnchor - lazy accessor for the
   *   configured disambiguation center, used only when a quest/raid name
   *   matches more than one bundled POI and no exact coordinates came with it.
   * @param {() => string[]} getTrackedChannelIds - Source Feed channel ids the bridge should scrape; pushed to it on start() and whenever a Source Feed tab (re)connects, since the bridge script itself has no hardcoded channel to fall back on.
   * @param {() => string} getScanChannelId - the channel id the dedicated second browser tab sits on (see config.js's own doc comment on scanChannelId). A message is only ever eligible for a subscriber's private pool if it arrived on *this* channel - a structural check independent of getActiveScanId's timing, so an organic reply on any other channel can never be captured into a pool no matter what activeScanId happens to be at that instant, and a stray reply on this channel with no scan active is dropped rather than ever becoming public.
   * @param {() => string|null} getActiveScanId - lazy accessor set (by worker-app.js's runAreaScan handler) for the duration of a subscriber-requested scan's own bulk-scan-priority window; null the rest of the time. While set *and* the message is on the scan channel, a parsed spawn is appended to that scan's private pending pool instead of becoming normal authoritative state - see #emitSpawn.
   */
  constructor({ bus, logger, state, getGeofilterAnchor, getTrackedChannelIds, getScanChannelId, getActiveScanId }) {
    this.#bus = bus;
    this.#logger = logger;
    this.#state = state;
    this.#getGeofilterAnchor = getGeofilterAnchor;
    this.#getTrackedChannelIds = getTrackedChannelIds;
    this.#getScanChannelId = getScanChannelId;
    this.#getActiveScanId = getActiveScanId;
    this.#speciesCache = {
      get: (key) => this.#state.workerMetadata.get(`speciesResolverCache:${key}`, null),
      set: (key, value) => this.#state.workerMetadata.set(`speciesResolverCache:${key}`, value),
    };
  }

  #pushTrackedChannels() {
    bridgeChannel.send(BRIDGE_EVENTS.SET_TRACKED_CHANNEL_IDS, { channelIds: this.#getTrackedChannelIds() });
  }

  /** See getScanChannelId's own doc comment - false if unconfigured, never matches an empty channelId. */
  #isScanChannel(channelId) {
    const scanChannelId = this.#getScanChannelId();
    return Boolean(scanChannelId) && channelId === scanChannelId;
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

    const applicationError = detectApplicationError(contentEl);
    if (applicationError) {
      // A real failure, not a "nothing here" result (see the isNoResultsAck
      // branch below) - whatever command this replied to got no actual
      // response, which the caller (a scheduled search, a daily command, an
      // area scan) has no other way to notice. Warn rather than info so it
      // stands out from routine activity in the log.
      this.#markSeen(messageId);
      this.#logger.warn("source-feed", `bot error: "${applicationError}"`);
      // Lets a subscriber scan's own orchestration (see worker-app.js's
      // runAreaScan/runSpeciesScan) know its search failed, so it can retry
      // - see this file's own getActiveScanId/getScanChannelId doc
      // comments. Gated on the scan channel, not just activeScanId's own
      // timing: an error on any other channel is never this scan's own
      // reply, no matter what activeScanId says at that instant.
      const activeScanId = this.#getActiveScanId();
      if (activeScanId && this.#isScanChannel(channelId)) this.#bus.emit("scanReply.observed", { scanId: activeScanId, kind: "error", error: applicationError });
      return;
    }

    if (isNoResultsAck(contentEl)) {
      this.#markSeen(messageId);
      // Otherwise indistinguishable from a message that just hasn't
      // finished rendering yet (see the unmarked fallthrough at the bottom
      // of this method) - a real "nothing here" reply is a normal, expected
      // outcome, not a problem, but it's still worth a line so an operator
      // scanning the activity log (e.g. after an area scan) can tell a
      // search genuinely came back empty rather than silently failing.
      this.#logger.info("source-feed", `no results: "${contentEl.textContent.trim()}"`);
      const activeScanId = this.#getActiveScanId();
      if (activeScanId && this.#isScanChannel(channelId)) this.#bus.emit("scanReply.observed", { scanId: activeScanId, kind: "empty" });
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
    const activeScanId = this.#getActiveScanId();
    const isScanReply = Boolean(activeScanId) && this.#isScanChannel(ids.channelId);
    // Signals a subscriber scan's own orchestration that *some* reply to
    // its search arrived - even one unusable below (no despawn timer, no
    // exact coords) still proves the command got a real response, which is
    // what decides whether a bot-error reply gets retried (see
    // worker-app.js's runAreaScan/runSpeciesScan and this file's own
    // getActiveScanId/getScanChannelId doc comments).
    if (isScanReply) this.#bus.emit("scanReply.observed", { scanId: activeScanId, kind: "spawn" });

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

    const normalized = {
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
    };

    // While a subscriber-requested scan holds bulk-scan priority *and* this
    // message arrived on the dedicated scan channel (see getScanChannelId's
    // own doc comment - a structural check, not just activeScanId's
    // timing), everything it turns up goes into that scan's own private
    // pending pool instead of becoming normal authoritative state - it
    // never reaches PokemonStateService, so it doesn't appear on this
    // worker's own map/dashboard or trigger notifications, until the
    // requester explicitly approves it (see approveScanResults). The
    // operator's own (self) scans are unaffected - activeScanId is only
    // ever set for a non-self requester, and self scans never run in the
    // scan channel anyway.
    if (isScanReply) {
      // stableIntId(stableSpawnKey(...)) (already computed above, as `id`)
      // is deterministic per real-world spawn - the same species/coords/cp
      // always produces the same id regardless of which search turned it
      // up. That's what lets "already public knowledge" mean something
      // concrete here: if this exact spawn is already active state.spawns
      // (published from some earlier search, in or out of a scan), it
      // isn't a new discovery for this subscriber to take credit for -
      // skip adding it to their pool rather than showing them something
      // that's already on the public map. An expired/despawned prior
      // sighting under the same id doesn't count as "known" - it's no
      // longer visible to anyone, so this sighting is worth surfacing.
      const existing = await this.#state.spawns.get(normalized.id);
      const alreadyKnown = Boolean(existing) && existing.status === "active" && new Date(existing.despawnAt).getTime() > Date.now();
      if (!alreadyKnown) await this.#state.pendingScanPools.appendSpawn(activeScanId, normalized);
      return;
    }
    this.#bus.emit("spawn.observed", normalized);
  }
}
