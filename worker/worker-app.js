// Orchestrator: wires every module together and drives the two-screen UI
// (setup -> dashboard) in index.html. This file intentionally does the
// "wiring" only - business logic lives in services/connectors, Nostr
// mechanics live in transports/nostr-transport.js, etc. See worker/README.md
// for the module map this implements.
import { EventBus } from "./core/event-bus.js";
import { Logger } from "./core/logging.js";
import { createApplicationState } from "./core/application-state.js";
import { loadPublicConfig, savePublicConfig, loadSecretConfig, saveSecretConfig, clearPersistedSecrets, defaultSearchConfig, defaultSecretConfig } from "./core/config.js";
import { NostrTransport } from "./transports/nostr-transport.js";
import { Rpc } from "./transports/rpc.js";
import { MiniscordPushTransport } from "./transports/push-transport.js";
import { SourceFeedConnector } from "./connectors/source-feed-connector.js";
import { MiniscordConnector } from "./connectors/miniscord-connector.js";
import { WatchChannelConnector } from "./connectors/watch-channel-connector.js";
import { buildSpawnFromMiniscordRecord } from "./core/miniscord-spawn.js";
import { buildMiniscordPokesearchCommand } from "./core/miniscord-pokesearch.js";
import { buildRaidFromGym, gymLocationKey } from "./core/miniscord-gym.js";
import { loadScheduledSearches, saveScheduledSearches, validateScheduledSearches } from "./core/scheduled-searches.js";
import { PokemonStateService } from "./services/pokemon-state.js";
import { AccountsService } from "./services/accounts.js";
import { NotificationsService } from "./services/notifications.js";
import { startDashboard } from "./dashboard/dashboard.js";
import { parseScanGroupsCsv } from "./core/scan-groups.js";
import { buildMiniscordQuestsearchCommand } from "./core/miniscord-questsearch.js";
import { buildQuestFromMiniscordRecord } from "./core/miniscord-quest.js";
import { generateHexLattice, buildAreaScanCommand, buildSubscriberAreaScanCommand } from "./core/area-scan.js";
import { isValidDexNumber, buildSpeciesScanCommand } from "./core/species-scan.js";
import { exportAllData } from "./storage/indexeddb.js";
import { crc16Tag } from "../shared/crc16.js";
import { KIND_SPAWN, KIND_QUEST, KIND_RAID, TRUSTED_VIEWER_PUBKEYS_HEX } from "../shared/nostr-protocol.js";

const WORKER_STATUS_INTERVAL_MS = 60_000;

// This tab is meant to stay open indefinitely as the live backend, so
// nothing else would ever prompt it to pick up a fresh deploy on its own -
// polling for a new Build: timestamp (deploy.sh stamps a fresh one into
// this exact file's own HTML every deploy - see its own comment) and
// reloading is the only way that happens automatically. sessionStorage
// (not localStorage - cleared when the tab closes, not a new persisted
// "remember" setting) carries the exact config this instance was running
// with across that one self-triggered reload, so main() can jump straight
// back into a running worker with no re-entry needed on the very next
// load - even when "remember secrets" was never turned on, since this is
// carrying forward an already-running session, not establishing a new
// persisted one. Same trust model as that existing "remember" opt-in
// already accepts (any JS on this origin can read either storage) - not a
// new class of exposure, just a shorter-lived instance of the same one.
const UPDATE_CHECK_INTERVAL_MS = 60_000;
const AUTO_RESUME_SESSION_KEY = "cusucomap-worker:auto-resume:v1";

function getRenderedBuildDate() {
  return document.getElementById("build-date")?.textContent ?? null;
}

/**
 * Reference-counted pause/resume, keyed by an arbitrary reason string -
 * lets more than one independent caller (the dashboard's own manual
 * toggle, a running quest scan) each hold their own pause without one's
 * resume() clearing the other's. Used to keep the scheduled pokesearch
 * loop (see runMiniscordScheduledBatch) from queuing its own calls onto
 * miniscord's shared pacing chain while something else needs uncontested
 * use of it. `onChange` fires only on an actual overall paused/not-paused
 * transition, not on every pause()/resume() call - a caller adding a
 * reason that was already covered by another one is a no-op for the UI.
 */
function createPauseGate(onChange) {
  const reasons = new Set();
  let waiters = [];
  const isPaused = () => reasons.size > 0;
  return {
    isPaused,
    reasons: () => [...reasons],
    pause(reason) {
      if (reasons.has(reason)) return;
      const wasPaused = isPaused();
      reasons.add(reason);
      if (!wasPaused) onChange?.();
    },
    resume(reason) {
      if (!reasons.has(reason)) return;
      reasons.delete(reason);
      if (!isPaused()) {
        const toRelease = waiters;
        waiters = [];
        for (const resolve of toRelease) resolve();
        onChange?.();
      }
    },
    /** Resolves immediately if not currently paused, otherwise once every reason has been resume()'d. */
    waitIfPaused() {
      if (!isPaused()) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function extractBuildDate(html) {
  return html.match(/id="build-date">([^<]*)<\/p>/)?.[1] ?? null;
}

function parseLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Local calendar date - matches pokemon-state.js's own copy; not worth a
// shared helper for three lines.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @returns {string} pubkey hex. Throws if `npub` isn't a valid npub. */
function decodeNpub(npub) {
  if (!window.NostrTools) throw new Error("NostrTools global not found.");
  const decoded = window.NostrTools.nip19.decode(String(npub ?? "").trim());
  if (decoded.type !== "npub") throw new Error("not an npub");
  return decoded.data;
}

function encodeNpub(pubkeyHex) {
  if (!window.NostrTools) throw new Error("NostrTools global not found.");
  return window.NostrTools.nip19.npubEncode(pubkeyHex);
}

/** Publishes an entity that just became authoritative (created/updated) - the only place connecting ApplicationState changes to the Nostr transport, per the brief's "central state layer decides what becomes visible" requirement. */
function wireNostrPublishing(bus, transport, logger) {
  const publishers = [
    { topics: ["spawn.created", "spawn.updated"], kind: KIND_SPAWN, expiryField: "despawnAt", label: (e) => `spawn ${e.species}` },
    { topics: ["raid.created", "raid.updated"], kind: KIND_RAID, expiryField: "endsAt", label: (e) => `raid ${e.bossSpecies ?? "?"}@${e.gymName}` },
    { topics: ["fieldResearch.created", "fieldResearch.updated"], kind: KIND_QUEST, expiryField: "expiresAt", label: (e) => `quest ${e.rewardName}@${e.pokestopName}` },
  ];
  for (const { topics, kind, expiryField, label } of publishers) {
    for (const topic of topics) {
      bus.on(topic, ({ entity }) => {
        transport.publishEntity(kind, entity.id, entity[expiryField], entity, label(entity)).catch((err) => logger.error("nostr", err.message));
      });
    }
  }
}

// Not a secret - just pasted scan-group coordinates - so this persists
// unconditionally, unlike the commands page's opt-in-only NSEC storage.
const SCAN_CSV_STORAGE_PREFIX = "cusucomap-worker:scan-csv:";

/**
 * Wires the "Quest scan" section (see index.html) - loops the pasted CSV
 * of scan-group centers through one miniscord POST /questsearch call per
 * location (see core/miniscord-questsearch.js's own comment for why this
 * is a single un-filtered call, not the old AHK path's geofilter-set plus
 * two type-filtered /questsearch commands per location). No more raid-scan
 * counterpart - /gyms already polls every gym in the configured area
 * continuously, so there's nothing left for a per-location bulk scan to do
 * for raids.
 *
 * Pauses the scheduled pokesearch loop (scheduledLoopGate, "quest-scan"
 * reason) for the scan's own duration - without this, the scheduled
 * loop's own calls interleave with the quest scan's on the same shared
 * miniscord pacing chain, slowing both down for no benefit. Always
 * resumed in the finally block below, whether the scan finished, failed,
 * or was cancelled.
 */
// Retried the same way as a subscriber's own single-search scan (see
// MINISCORD_SCAN_MAX_RETRIES/MINISCORD_SCAN_RETRY_PAUSE_MS inside
// startWorker) - up to this many additional attempts (so up to this + 1
// total) per row before giving up. Unlike that scan, exhausting retries
// here stops the whole batch rather than just skipping the one row: a
// batch operator watching this run wants to know a location is
// consistently failing, not have it silently skipped while the rest
// quietly continues.
const QUEST_SCAN_MAX_RETRIES = 5;
const QUEST_SCAN_RETRY_PAUSE_MS = 3000;

function wireQuestScanSection({ miniscordConnector, speciesCache, getGeofilterAnchor, scheduledLoopGate, bus, logger }) {
  const id = "quest-scan";
  const textarea = document.getElementById(`${id}-csv`);
  const startButton = document.getElementById(`${id}-start`);
  const cancelButton = document.getElementById(`${id}-cancel`);
  const statusEl = document.getElementById(`${id}-status`);
  const storageKey = `${SCAN_CSV_STORAGE_PREFIX}${id}`;

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) textarea.value = saved;
  } catch {
    // Private browsing/storage disabled - just means it won't remember.
  }
  textarea.addEventListener("input", () => {
    try {
      localStorage.setItem(storageKey, textarea.value);
    } catch {
      // ignore
    }
  });

  let cancelRequested = false;

  startButton.addEventListener("click", async () => {
    const { groups, errors } = parseScanGroupsCsv(textarea.value);
    for (const err of errors) logger.warn("miniscord", `${id}: ${err}`);
    if (groups.length === 0) {
      logger.warn("miniscord", `${id}: nothing to scan - paste the group list first.`);
      return;
    }
    if (!miniscordConnector.isConfigured()) {
      logger.warn("miniscord", `${id}: miniscord isn't configured - set the Miniscord URL first.`);
      return;
    }
    if (!confirm(`Start a quest scan over ${groups.length} groups? Each location is a separate miniscord call, spaced a few seconds apart.`)) return;

    cancelRequested = false;
    startButton.hidden = true;
    cancelButton.hidden = false;
    statusEl.hidden = false;

    scheduledLoopGate.pause("quest-scan");
    let sent = 0;
    try {
      for (const group of groups) {
        if (cancelRequested) break;
        statusEl.textContent = `Sending ${sent}/${groups.length}…`;
        const command = buildMiniscordQuestsearchCommand(`${group.lat},${group.lon}`, `${group.radiusKm}km`);
        const groupLabel = `${group.lat},${group.lon}`;

        let result;
        for (let attempt = 0; attempt <= QUEST_SCAN_MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            logger.warn(
              "miniscord",
              `${id}: group ${groupLabel} attempt ${attempt + 1}/${QUEST_SCAN_MAX_RETRIES + 1} - retrying after a failure (${result.error})`
            );
            await sleep(QUEST_SCAN_RETRY_PAUSE_MS);
          }
          result = await miniscordConnector.searchQuest(command);
          if (result.ok) break;
        }

        if (!result.ok) {
          logger.error(
            "miniscord",
            `${id}: group ${groupLabel} failed after ${QUEST_SCAN_MAX_RETRIES + 1} attempts (${result.error}) - stopping the batch`
          );
          statusEl.textContent = `Stopped after ${sent}/${groups.length} - group ${groupLabel} failed repeatedly.`;
          return;
        }

        const built = await Promise.all(result.results.map((record) => buildQuestFromMiniscordRecord(record, speciesCache, getGeofilterAnchor())));
        for (const quest of built.filter(Boolean)) bus.emit("quest.observed", quest);
        sent++;
      }
      statusEl.textContent = cancelRequested ? `Cancelled after ${sent}/${groups.length}.` : `Done - sent ${sent} group(s).`;
    } catch (err) {
      logger.error("miniscord", `${id} failed: ${err.message}`);
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      scheduledLoopGate.resume("quest-scan");
      startButton.hidden = false;
      cancelButton.hidden = true;
    }
  });

  cancelButton.addEventListener("click", () => {
    cancelRequested = true;
  });
}

/** Re-broadcasts everything currently active on startup - a relay that pruned an entity while the worker was offline (or a newly-added relay with no history at all) still converges to the correct current state. */
async function republishAllActive(state, transport, logger) {
  const [spawns, raids, research] = await Promise.all([state.spawns.active(), state.raids.active(), state.fieldResearch.active()]);
  // Concurrent, not one-at-a-time: each publishEntity() call is its own
  // relay round trip, and #publishTemplate already resolves (never
  // rejects) via Promise.allSettled internally, so there's nothing here
  // for one slow/failed entity to block behind. On a worker with many
  // active entities this is most of what made Start Worker take up to
  // ~30s - now it's roughly one round-trip's worth of wall-clock time
  // for the whole batch instead of N of them back to back.
  await Promise.all([
    ...spawns.map((s) => transport.publishEntity(KIND_SPAWN, s.id, s.despawnAt, s, `spawn ${s.species} (resync)`)),
    ...raids.map((r) => transport.publishEntity(KIND_RAID, r.id, r.endsAt, r, `raid ${r.bossSpecies ?? "?"} (resync)`)),
    ...research.map((q) => transport.publishEntity(KIND_QUEST, q.id, q.expiresAt, q, `quest ${q.rewardName} (resync)`)),
  ]);
  logger.info("worker", `resynced ${spawns.length} spawns, ${raids.length} raids, ${research.length} quests on startup`);
}

async function startWorker(publicConfig, secretConfig) {
  const bus = new EventBus();
  const logger = new Logger(bus);
  const state = createApplicationState(bus);

  const transport = new NostrTransport({ relays: publicConfig.relays, logger });
  transport.setIdentity(secretConfig.nsec);
  transport.connect();
  if (!TRUSTED_VIEWER_PUBKEYS_HEX.includes(transport.identity.hex)) {
    logger.warn(
      "nostr",
      `this worker's pubkey (${transport.identity.npub}) is not in the viewer's trusted list - the CusucoMap viewer won't show anything this worker publishes until cusucomap-viewer's src/nostr-config.ts's PUBKEYS_HEX includes it.`
    );
  }

  const pokemonState = new PokemonStateService({ state, bus, logger });
  pokemonState.start();

  const sourceFeedConnector = new SourceFeedConnector({
    bus,
    logger,
    state,
    getGeofilterAnchor: () => publicConfig.geofilterAnchor,
    getTrackedChannelIds: () => publicConfig.trackedChannelIds,
  });
  sourceFeedConnector.start();

  // Replaces AHK/the browser/Tampermonkey for every pokesearch/questsearch
  // command - scheduled searches, the watch-channel's special search, both
  // the operator's own (self) and a subscriber's area/species scan, and
  // the quest scan (see wireQuestScanSection) - see
  // worker/connectors/miniscord-connector.js and the
  // "project_scan_feature_v1_hexlattice" memory for the earlier
  // dedicated-second-tab design this superseded. AHK itself has been fully
  // retired.
  const miniscordConnector = new MiniscordConnector({ getBaseUrl: () => publicConfig.miniscordUrl, logger });
  // Same cache backing (and key prefix) as source-feed-connector.js's own
  // speciesCache - shares resolved PokeAPI lookups across both paths
  // rather than each maintaining an independent copy.
  const speciesCache = {
    get: (key) => state.workerMetadata.get(`speciesResolverCache:${key}`, null),
    set: (key, value) => state.workerMetadata.set(`speciesResolverCache:${key}`, value),
  };

  // Inclusive on both ends - jitters a rest interval.
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Reassigned once watchChannelConnector is constructed below - a plain
  // mutable binding rather than depending on hoisting/declaration order,
  // since runOrganicMiniscordSearch is defined (though not yet called)
  // before that point. See WatchChannelConnector#notifyMiniscordActivity
  // for why piggybacking here matters: it's what lets a new watch-channel
  // message get noticed sooner than its own 15s fallback poll.
  let notifyWatchChannelActivity = () => {};

  /**
   * Runs one miniscord search and publishes whatever it finds the normal,
   * organic way - the shared "just search and make the results public"
   * primitive behind the scheduled loop, the watch-channel's own special
   * search, and the operator's own self area/species scans. Never retries;
   * a caller that cares whether this actually got a reply can check the
   * returned result's own `ok` field.
   * @param {string} command
   * @returns {Promise<{ok:true, results:object[]} | {ok:false, error:string}>}
   */
  async function runOrganicMiniscordSearch(command) {
    const result = await miniscordConnector.search(command);
    notifyWatchChannelActivity();
    if (!result.ok) return result;
    const built = await Promise.all(result.results.map((record) => buildSpawnFromMiniscordRecord(record, speciesCache)));
    for (const spawn of built.filter(Boolean)) bus.emit("spawn.observed", spawn);
    return result;
  }

  // A scheduledSearches entry is a full command string (e.g.
  // "/pokesearch iv100") - this strips the "/pokesearch " prefix back off
  // so the bare filter text can be recombined with an explicit
  // center/radius via buildMiniscordPokesearchCommand instead.
  function stripPokesearchPrefix(command) {
    return command.replace(/^\/pokesearch\s+/, "");
  }

  // Reflects scheduledLoopGate's own paused/running state on the
  // dashboard - see wireScheduledLoopControls for the toggle button this
  // pairs with, and createPauseGate's own comment for why quest-scan
  // holds its own independent pause reason here too (see
  // wireQuestScanSection).
  function refreshScheduledLoopStatus() {
    const statusEl = document.getElementById("scheduled-loop-status");
    const toggleButton = document.getElementById("scheduled-loop-toggle");
    if (!statusEl || !toggleButton) return;
    if (scheduledLoopGate.isPaused()) {
      statusEl.textContent = `Paused (${scheduledLoopGate.reasons().join(", ")})`;
      toggleButton.textContent = "Resume";
    } else {
      statusEl.textContent = "Running";
      toggleButton.textContent = "Pause";
    }
  }
  const scheduledLoopGate = createPauseGate(refreshScheduledLoopStatus);

  // Runs scheduledSearches (see core/scheduled-searches.js - the
  // admin-edited source of truth, edited via the commands page or
  // tools/set-scheduled-searches.mjs) through miniscord one at a time,
  // resting batchRestMinMin/MaxMin minutes between full passes. Starts
  // automatically (see the unconditional call below) and checks
  // scheduledLoopGate before every command, not just at the top of a
  // pass, so a pause mid-pass takes effect before the next send rather
  // than waiting for the current pass to finish.
  let scheduledLoopGeneration = 0;
  async function runMiniscordScheduledBatch(generation) {
    if (miniscordConnector.isConfigured()) {
      const scheduledSearches = await loadScheduledSearches(state, defaultSearchConfig().scheduledSearches);
      const { defaultSearchCenterLat, defaultSearchCenterLon, defaultSearchRadiusKmText } = defaultSearchConfig();
      for (const entry of scheduledSearches) {
        if (generation !== scheduledLoopGeneration) return;
        await scheduledLoopGate.waitIfPaused();
        if (generation !== scheduledLoopGeneration) return; // re-check - could have been stopped while waiting
        const command = buildMiniscordPokesearchCommand(
          stripPokesearchPrefix(entry),
          `${defaultSearchCenterLat.toFixed(6)},${defaultSearchCenterLon.toFixed(6)}`,
          `${defaultSearchRadiusKmText}km`
        );
        const result = await runOrganicMiniscordSearch(command);
        if (!result.ok) logger.warn("miniscord", `scheduled search "${entry}" failed: ${result.error}`);
      }
    }
    if (generation !== scheduledLoopGeneration) return;
    const { batchRestMinMin, batchRestMaxMin } = defaultSearchConfig();
    setTimeout(() => runMiniscordScheduledBatch(generation), randomInt(batchRestMinMin, batchRestMaxMin) * 60_000);
  }
  runMiniscordScheduledBatch(scheduledLoopGeneration);

  document.getElementById("scheduled-loop-toggle").addEventListener("click", () => {
    if (scheduledLoopGate.isPaused()) scheduledLoopGate.resume("manual");
    else scheduledLoopGate.pause("manual");
  });
  refreshScheduledLoopStatus();

  // Polls miniscord's GET /gyms cache and publishes every gym currently
  // hosting a raid with a known boss - see core/miniscord-gym.js for what
  // gets skipped (no active raid, an unhatched egg, an unrevealed
  // mega-tier boss) and why. 5 minutes matches miniscord's own background
  // refresh cadence (see its docs) - polling faster would only re-read the
  // same cached snapshot. Independent of the scheduled/priority-scan
  // pacing above: GET /gyms never touches Discord, so there's no shared
  // cooldown to respect here.
  //
  // gymNameByLocation backs the one-time include_name=true request below:
  // per miniscord's own docs, that flag permanently flips a service-wide
  // switch (not a per-request one), so it's requested at most once here
  // (only until it actually succeeds) rather than on every poll - a name
  // seen that way is remembered here (keyed the same way
  // miniscord-gym.js's own stable id is, so they always agree on which
  // gym a lat/lon means) and reused as a fallback on any later poll whose
  // own gym.name briefly comes back null (the background poller can take
  // up to 5 minutes to catch up after the switch flips).
  const GYM_POLL_INTERVAL_MS = 5 * 60_000;
  const gymNameByLocation = new Map();
  let gymNamesRequested = false;
  async function runMiniscordGymPoll() {
    if (miniscordConnector.isConfigured()) {
      const result = await miniscordConnector.getGyms({ includeName: !gymNamesRequested });
      notifyWatchChannelActivity();
      if (result.ok) {
        gymNamesRequested = true;
        for (const gym of result.results) {
          if (gym.name) gymNameByLocation.set(gymLocationKey(gym.location.lat, gym.location.lon), gym.name);
        }
        const built = await Promise.all(result.results.map((gym) => buildRaidFromGym(gym, speciesCache, gymNameByLocation)));
        for (const raid of built.filter(Boolean)) bus.emit("raid.observed", raid);
      } else {
        logger.warn("miniscord", `gym poll failed: ${result.error}`);
      }
    }
    setTimeout(runMiniscordGymPoll, GYM_POLL_INTERVAL_MS);
  }
  runMiniscordGymPoll();

  // Fixed center/radius/filter for the watch channel's own special
  // pokesearch (see WatchChannelConnector) - the lat/lon deliberately
  // reuses the tracked channel's own geofilterAnchor (the same point the
  // real /geofilter command was set to), not defaultSearchCenterLat/Lon,
  // which is a separate, general-purpose default for the scheduled loop.
  const WATCH_CHANNEL_SEARCH_RADIUS = "10km";
  const WATCH_CHANNEL_SEARCH_FILTER = "iv100";

  const watchChannelConnector = new WatchChannelConnector({
    logger,
    getWatchChannelName: () => publicConfig.watchChannelName,
    miniscordConnector,
    runSpecialSearch: () =>
      runOrganicMiniscordSearch(
        buildMiniscordPokesearchCommand(
          `${publicConfig.geofilterAnchor.lat},${publicConfig.geofilterAnchor.lon}`,
          WATCH_CHANNEL_SEARCH_RADIUS,
          WATCH_CHANNEL_SEARCH_FILTER
        )
      ),
    lastSeenMessageIdCache: {
      get: () => state.workerMetadata.get("watchChannelLastSeenMessageId", null),
      set: (id) => state.workerMetadata.set("watchChannelLastSeenMessageId", id),
    },
  });
  notifyWatchChannelActivity = () => watchChannelConnector.notifyMiniscordActivity();
  watchChannelConnector.start();

  wireQuestScanSection({ miniscordConnector, speciesCache, getGeofilterAnchor: () => publicConfig.geofilterAnchor, scheduledLoopGate, bus, logger });

  // secretConfig.fcmServiceAccountJson is fixed for this session (set once
  // at Start Worker time, like vapidPrivateKey/nsec), so parsing it once
  // here and caching the result - rather than re-parsing on every
  // #notifySpawn call - is enough; also means a malformed paste only ever
  // logs once instead of on every spawn.
  let fcmConfigCache; // undefined = not parsed yet, null = unset/invalid
  function getFcmConfig() {
    if (fcmConfigCache !== undefined) return fcmConfigCache;
    if (!secretConfig.fcmServiceAccountJson) {
      fcmConfigCache = null;
    } else {
      try {
        fcmConfigCache = JSON.parse(secretConfig.fcmServiceAccountJson);
      } catch (err) {
        logger.error("push", `FCM service account JSON is invalid, ignoring it: ${err.message}`);
        fcmConfigCache = null;
      }
    }
    return fcmConfigCache;
  }

  const pushTransport = new MiniscordPushTransport({ miniscordConnector });
  const notifications = new NotificationsService({
    state,
    bus,
    transport,
    pushTransport,
    getVapidConfig: () =>
      publicConfig.vapidPublicKey && secretConfig.vapidPrivateKey
        ? { vapidPublicKey: publicConfig.vapidPublicKey, vapidPrivateKey: secretConfig.vapidPrivateKey, contact: publicConfig.vapidContact }
        : null,
    getFcmConfig,
    logger,
  });
  notifications.start();

  const accounts = new AccountsService({ state, googleClientId: publicConfig.googleClientId, logger });

  const rpc = new Rpc({ transport, state, logger });
  accounts.registerRpc(rpc);
  rpc.handle("getSnapshot", async () => ({
    spawns: await state.spawns.active(),
    raids: await state.raids.active(),
    fieldResearch: await state.fieldResearch.active(),
  }));
  // Both self-pubkey-only (see commands/commands-app.js and
  // tools/set-scheduled-searches.mjs, which sign as the worker's own
  // identity): this is admin control over the scheduled search loop's own
  // filter list, not something to expose to an arbitrary caller who
  // merely knows the worker's public npub. Returning {ok:false, ...} here
  // rather than throwing is deliberate - rpc.js's #dispatch collapses any
  // thrown error into a generic "Internal error" message.
  rpc.handle("getScheduledSearches", async (_params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    return { ok: true, scheduledSearches: await loadScheduledSearches(state, defaultSearchConfig().scheduledSearches) };
  });
  rpc.handle("setScheduledSearches", async (params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    const error = validateScheduledSearches(params?.scheduledSearches);
    if (error) return { ok: false, error };
    await saveScheduledSearches(state, params.scheduledSearches);
    return { ok: true, scheduledSearches: params.scheduledSearches };
  });
  // A subscriber's own dailyLimit (set via setScanSubscriber's admin panel
  // field) overrides the fleet-wide default - absent/null means "use the
  // default", not "zero". Centralized here so authorizeScanRequest and
  // checkScanSubscription's own cusucosRemaining can never drift apart on
  // what "the limit" actually means for a given subscriber.
  function resolveSubscriberDailyLimit(subscriber) {
    return subscriber?.dailyLimit ?? defaultSearchConfig().scanDailyLimitPerSubscriber;
  }

  // Every scan-request rejection goes through this, not a bare `return
  // {ok:false,...}` - a request that never even shows up in the activity
  // log (success is already logged, right before its own ack) is
  // impossible to tell apart from "never arrived at all" when
  // troubleshooting, which is exactly what made two near-simultaneous
  // requests (one claims a single-scan-at-a-time mutex, the other gets
  // silently rejected by it) look like a dropped request instead of a
  // real, structurally-correct "only one scan at a time" rejection.
  function rejectScanRequest(fromPubkey, method, error) {
    logger.warn("worker", `${method} request from ${fromPubkey.slice(0, 8)}… rejected: ${error}`);
    return { ok: false, error };
  }

  // A subscriber's scan retries its own single search this many additional
  // times (so up to this + 1 total attempts) on a miniscord failure before
  // giving up - miniscord itself makes exactly one attempt per call and
  // never retries internally (confirmed in its own docs), so retry policy
  // is entirely this worker's concern, same as it was for the old
  // AHK-based path.
  const MINISCORD_SCAN_MAX_RETRIES = 2;
  // Pause before retrying a failed attempt - not trying to look human like
  // the search-pacing pauses elsewhere, just not hammering Discord with the
  // exact same command back-to-back after it just failed. On top of
  // MiniscordConnector's own MIN_GAP_MS, which already paces every call
  // regardless of caller.
  const MINISCORD_SCAN_RETRY_PAUSE_MS = 3000;

  // Reverses authorizeScanRequest's charge - a scan that never got a usable
  // reply after every retry was exhausted shouldn't cost the subscriber
  // their daily allowance. Safe even if the day rolled over since charging
  // (scansUsedDate won't match today's key any more, so there's nothing to
  // undo).
  async function reimburseScanRequest(fromPubkey) {
    const subscriber = await state.scanSubscribers.get(fromPubkey);
    if (!subscriber || subscriber.scansUsedDate !== todayKey()) return;
    await state.scanSubscribers.put({ ...subscriber, scansUsedToday: Math.max(0, (subscriber.scansUsedToday ?? 0) - 1) });
  }

  /**
   * Runs a subscriber's single-search scan (area or species) end to end via
   * miniscord: one HTTP call per attempt, retrying up to
   * MINISCORD_SCAN_MAX_RETRIES times on failure, then writing results
   * straight into the pool. No dedicated tab, no wait-for-event machinery,
   * no bulk-scan mutex needed - miniscord's response IS the complete,
   * unambiguous answer to this exact call, so there's nothing left to
   * attribute after the fact the way the old DOM-scraped/dedicated-tab
   * design needed extensive machinery for (see the
   * "project_scan_feature_v1_hexlattice" memory for that history).
   * Doesn't touch AHK at all - that stack has been fully retired.
   *
   * On exhausted retries: reimburses the caller's cusuco and marks the pool
   * "failed" rather than leaving it looking like a genuine zero-result scan
   * (see getScanResults/PROTOCOL.md).
   * @param {string} scanId
   * @param {string} fromPubkey
   * @param {() => string} buildCommand - called fresh for each attempt; the
   *   command text itself never changes between retries.
   * @returns {Promise<"ok"|"error">}
   */
  async function runSubscriberScanViaMiniscord(scanId, fromPubkey, buildCommand) {
    let records = null;
    for (let attempt = 0; attempt <= MINISCORD_SCAN_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        logger.warn("worker", `scan ${scanId} attempt ${attempt + 1}/${MINISCORD_SCAN_MAX_RETRIES + 1} - retrying after a miniscord failure`);
        await sleep(MINISCORD_SCAN_RETRY_PAUSE_MS);
      }
      const result = await miniscordConnector.search(buildCommand());
      if (result.ok) {
        records = result.results;
        break;
      }
    }

    if (records === null) {
      logger.warn("worker", `scan ${scanId} got no usable reply after ${MINISCORD_SCAN_MAX_RETRIES + 1} attempts - reimbursing cusuco`);
      await reimburseScanRequest(fromPubkey);
      const pool = await state.pendingScanPools.get(scanId);
      if (pool) await state.pendingScanPools.put({ ...pool, status: "failed" });
      logger.info("worker", `scan ${scanId} status: collecting -> failed`);
      return "error";
    }

    const built = await Promise.all(records.map((record) => buildSpawnFromMiniscordRecord(record, speciesCache)));
    const spawns = built.filter(Boolean);
    if (spawns.length < built.length) {
      logger.warn("worker", `scan ${scanId}: ${built.length - spawns.length} miniscord record(s) had no location/despawnAt - skipped`);
    }
    // Same "already publicly known" skip the old DOM-scraped path applied -
    // a subscriber shouldn't get credit for something already on the map
    // (see stableIntId/stableSpawnKey's own comment on why the same
    // real-world spawn always produces the same id regardless of which
    // search turned it up).
    const newSpawns = [];
    for (const spawn of spawns) {
      const existing = await state.spawns.get(spawn.id);
      const alreadyKnown = Boolean(existing) && existing.status === "active" && new Date(existing.despawnAt).getTime() > Date.now();
      if (!alreadyKnown) newSpawns.push(spawn);
    }

    const pool = await state.pendingScanPools.get(scanId);
    if (pool) await state.pendingScanPools.put({ ...pool, status: "pending", spawns: newSpawns });
    logger.info("worker", `scan ${scanId} status: collecting -> pending (${newSpawns.length} spawn(s))`);
    return "ok";
  }

  // Authorizes a scan request (runAreaScan, runSpeciesScan) and, for a
  // non-self caller, charges one scan against their daily "cusuco" quota in
  // the same call - see worker/storage/indexeddb.js's own comment on why
  // this ledger is its own store, never merged into pushSubscriptions. The
  // operator's own (self) requests are always allowed, unlimited, no quota
  // touched.
  async function authorizeScanRequest(fromPubkey, method) {
    if (fromPubkey === transport.identity.hex) return { ok: true, isSelf: true };
    // A subscriber's scan runs entirely through miniscord (see
    // miniscord-connector.js) - without one configured there is no way to
    // run it at all.
    if (!miniscordConnector.isConfigured()) return rejectScanRequest(fromPubkey, method, "miniscord not configured - ask the operator to set it up.");
    const subscriber = await state.scanSubscribers.get(fromPubkey);
    if (!subscriber) return rejectScanRequest(fromPubkey, method, "no scan subscription found for this account.");
    if (new Date(subscriber.activeUntil).getTime() < Date.now()) return rejectScanRequest(fromPubkey, method, "scan subscription has expired.");
    const today = todayKey();
    const usedToday = subscriber.scansUsedDate === today ? (subscriber.scansUsedToday ?? 0) : 0;
    if (usedToday >= resolveSubscriberDailyLimit(subscriber)) return rejectScanRequest(fromPubkey, method, "daily scan limit reached - resets tomorrow.");
    await state.scanSubscribers.put({ ...subscriber, scansUsedToday: usedToday + 1, scansUsedDate: today });
    return { ok: true, isSelf: false };
  }

  // Starts a bulk area scan (see commands/commands-app.js's "Area scan"
  // section and worker/core/area-scan.js) and returns as soon as it's
  // *started*, not once it finishes - a scan can run for many minutes
  // (dozens of /pokesearch commands through miniscord, each paced behind
  // the last), far longer than an RPC round trip over Nostr relays should
  // ever block for. For the operator's own (self) request, results publish
  // immediately and normally, no pool involved (see runOrganicMiniscordSearch).
  // For a subscriber, results instead land in a private pendingScanPools
  // row (see runSubscriberScanViaMiniscord) that only they (or the
  // operator) can read back via getScanResults, and only they (or the
  // operator) can make public via approveScanResults - the request body of
  // that call carries no spawn data at all, only the id, so there is no way
  // for a caller to inject anything into what gets broadcast.
  rpc.handle("runAreaScan", async (params, { fromPubkey }) => {
    // centerLat/centerLon are validated before authorizeScanRequest,
    // deliberately - that call is what charges one cusuco against a
    // non-self caller's daily quota, and a subscriber must never be
    // charged for a request that was going to be rejected anyway.
    // radiusKmText/rings depend on auth.isSelf, so those stay validated
    // after - they can never actually fail for a subscriber, since their
    // values are always the fixed server-side constants below, not
    // anything the caller supplied.
    const centerLat = Number(params?.centerLat);
    const centerLon = Number(params?.centerLon);
    if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) return rejectScanRequest(fromPubkey, "runAreaScan", "centerLat must be a number between -90 and 90.");
    if (!Number.isFinite(centerLon) || centerLon < -180 || centerLon > 180) return rejectScanRequest(fromPubkey, "runAreaScan", "centerLon must be a number between -180 and 180.");

    const auth = await authorizeScanRequest(fromPubkey, "runAreaScan");
    if (!auth.ok) return auth;

    const { subscriberScanRadiusKmText } = defaultSearchConfig();
    // Two entirely different scan shapes past this point - see
    // area-scan.js's own doc comment for why - but both submitted through
    // miniscord now, with no mutex needed between them: the operator's own
    // commands-page scans (self) keep the full hex-lattice/rings design,
    // specifying their own radius, sent as many self-contained circle
    // commands one at a time; a subscriber's scan is always a single point
    // at a fixed radius.
    let total;
    let scanId = null;
    if (auth.isSelf) {
      const radiusKmText = String(params?.radiusKmText ?? "").trim();
      const radiusKm = Number(radiusKmText);
      const rings = Number(params?.rings);
      if (!radiusKmText || !Number.isFinite(radiusKm) || radiusKm <= 0) return rejectScanRequest(fromPubkey, "runAreaScan", "radiusKmText must be a positive number.");
      if (!Number.isInteger(rings) || rings < 1 || rings > 5) return rejectScanRequest(fromPubkey, "runAreaScan", "rings must be an integer between 1 and 5.");
      const points = generateHexLattice({ centerLat, centerLon, radiusKm, rings });
      total = points.length;
      // Deliberately not awaited - see this handler's own doc comment
      // above: the ack below returns as soon as the scan has *started*.
      // No retry per circle (matches this scan's own prior AHK-based
      // behavior, which never verified a reply came back either) - just a
      // warning and move on if one call fails.
      (async () => {
        let sent = 0;
        for (const point of points) {
          const result = await runOrganicMiniscordSearch(buildAreaScanCommand({ ...point, radiusKmText }));
          if (!result.ok) {
            logger.warn("miniscord", `area scan circle at ${point.lat.toFixed(6)},${point.lon.toFixed(6)} failed: ${result.error}`);
            continue;
          }
          sent++;
        }
        logger.info("worker", `area scan done - sent ${sent}/${points.length} commands`);
      })().catch((err) => logger.error("worker", `area scan failed: ${err.message}`));
    } else {
      total = 1;
      scanId = crypto.randomUUID();
      await state.pendingScanPools.put({ scanId, scanType: "area", requestedByPubkeyHex: fromPubkey, createdAt: Date.now(), status: "collecting", spawns: [] });
      // Deliberately not awaited - see this handler's own doc comment
      // above: the ack below returns as soon as the scan has *started*,
      // not once it finishes.
      runSubscriberScanViaMiniscord(scanId, fromPubkey, () => buildSubscriberAreaScanCommand({ lat: centerLat, lon: centerLon, radiusKmText: subscriberScanRadiusKmText }))
        .then((outcome) => {
          logger.info("worker", outcome === "ok" ? "area scan done" : "area scan got no usable reply after retries - cusuco reimbursed");
        })
        .catch((err) => logger.error("worker", `area scan failed: ${err.message}`));
    }

    // The ack itself - returned as soon as the cusuco is charged and the
    // scan is confirmed to actually be starting (see the reordering above:
    // by this point every rejection path has already returned, so a
    // caller that gets this response really was charged and really did
    // start a scan). No human-facing text here on purpose - presentation
    // (copy, language, UI) is entirely the viewer's concern; `ok: true`
    // plus `scanId` is a complete, unambiguous structured signal on its own.
    logger.info(
      "worker",
      `area scan request from ${fromPubkey.slice(0, 8)}… accepted (${auth.isSelf ? "operator" : "subscriber, cusuco charged"}) - ack sent (scanId=${scanId ?? "n/a"}, ${total} commands)`
    );
    return { ok: true, total, scanId };
  });

  // Same authorization/ack/pool wiring as runAreaScan (see that handler's
  // own comments for the reasoning behind each piece, not repeated here).
  // Just one command, always - no follow-up queries even if the base
  // search hits its own per-query result cap (see the
  // "project_scan_feature_v1_hexlattice" memory for the earlier,
  // conditional-follow-up design this replaced). The command text itself
  // is now identical for self and subscriber alike (see species-scan.js's
  // own doc comment) - only the outcome differs: self publishes
  // organically, a subscriber's goes into a private pool with retries.
  rpc.handle("runSpeciesScan", async (params, { fromPubkey }) => {
    const dexNumber = Number(params?.dexNumber);
    if (!isValidDexNumber(dexNumber)) return rejectScanRequest(fromPubkey, "runSpeciesScan", "dexNumber must be a positive integer below 4096.");

    const auth = await authorizeScanRequest(fromPubkey, "runSpeciesScan");
    if (!auth.ok) return auth;

    const { defaultSearchCenterLat, defaultSearchCenterLon, defaultSearchRadiusKmText } = defaultSearchConfig();
    const command = buildSpeciesScanCommand(dexNumber, {
      lat: defaultSearchCenterLat,
      lon: defaultSearchCenterLon,
      radiusKmText: defaultSearchRadiusKmText,
    });

    let scanId = null;
    if (auth.isSelf) {
      // Deliberately not awaited - see runAreaScan's own doc comment.
      runOrganicMiniscordSearch(command)
        .then((result) => {
          logger.info("worker", result.ok ? `species scan done for dex #${dexNumber}` : `species scan for dex #${dexNumber} failed: ${result.error}`);
        })
        .catch((err) => logger.error("worker", `species scan failed: ${err.message}`));
    } else {
      scanId = crypto.randomUUID();
      await state.pendingScanPools.put({ scanId, scanType: "species", requestedByPubkeyHex: fromPubkey, createdAt: Date.now(), status: "collecting", spawns: [] });
      // Deliberately not awaited - see runAreaScan's own doc comment.
      runSubscriberScanViaMiniscord(scanId, fromPubkey, () => command)
        .then((outcome) => {
          logger.info(
            "worker",
            outcome === "ok" ? `species scan done for dex #${dexNumber}` : `species scan for dex #${dexNumber} got no usable reply after retries - cusuco reimbursed`
          );
        })
        .catch((err) => logger.error("worker", `species scan failed: ${err.message}`));
    }

    logger.info(
      "worker",
      `species scan request from ${fromPubkey.slice(0, 8)}… accepted (${auth.isSelf ? "operator" : "subscriber, cusuco charged"}) - ack sent (scanId=${scanId ?? "n/a"}, dex #${dexNumber})`
    );
    return { ok: true, scanId };
  });

  // Lets the requester (or the operator) read back a scan's private
  // results - this is the entire "private delivery" channel: nothing about
  // a subscriber's scan is ever public until approveScanResults is called.
  rpc.handle("getScanResults", async (params, { fromPubkey }) => {
    const pool = params?.scanId ? await state.pendingScanPools.get(params.scanId) : null;
    if (!pool) return { ok: false, error: "unknown scanId." };
    if (fromPubkey !== transport.identity.hex && fromPubkey !== pool.requestedByPubkeyHex) return { ok: false, error: "forbidden - not your scan." };
    return { ok: true, status: pool.status, scanType: pool.scanType, spawns: pool.spawns };
  });

  // Makes a scan's results public, for real, the normal way - replaying
  // each stored spawn through the exact same "spawn.observed" event an
  // organic sighting emits, rather than writing to state.spawns directly,
  // is what's important here: it's the only path that runs
  // PokemonStateService's own validateSpawn() check and its "already
  // expired by the time this reaches state" skip (approval can happen
  // several minutes after a spawn was collected - late enough for either
  // to matter) before anything is published, exactly as if it had just now
  // been observed for the first time. Only ever publishes what this worker
  // itself already stored under this scanId - the request carries no spawn
  // data of its own, so there is no way to inject anything here.
  rpc.handle("approveScanResults", async (params, { fromPubkey }) => {
    const pool = params?.scanId ? await state.pendingScanPools.get(params.scanId) : null;
    if (!pool) return { ok: false, error: "unknown scanId." };
    if (fromPubkey !== transport.identity.hex && fromPubkey !== pool.requestedByPubkeyHex) return { ok: false, error: "forbidden - not your scan." };
    if (pool.status === "broadcast") return { ok: false, error: "already broadcast." };

    // Anonymous-but-consistent attribution (see checkScanSubscription's own
    // comment on attributionTag) plus which kind of scan this was -
    // PROTOCOL.md documents both as additive, optional Spawn fields. The
    // admin panel's own "note" field doubles as a public display-name
    // override when set (the operator's call - see the panel's own label) -
    // the CRC16 attributionTag is only ever the default/fallback, used
    // whenever no note has been set. Falls back to a fixed placeholder
    // rather than failing the whole approve if the requester's own ledger
    // row is somehow gone (e.g. manually removed by the operator between
    // request and approval).
    const requester = await state.scanSubscribers.get(pool.requestedByPubkeyHex);
    const sharedByTag = requester?.note || requester?.attributionTag || "????";
    const discoveredVia = pool.scanType === "species" ? "species-scan" : "area-scan";

    for (const spawn of pool.spawns) bus.emit("spawn.observed", { ...spawn, discoveredVia, sharedByTag });
    await state.pendingScanPools.put({ ...pool, status: "broadcast" });
    logger.info("worker", `scan ${pool.scanId} status: ${pool.status} -> broadcast (${pool.spawns.length} published)`);
    return { ok: true, published: pool.spawns.length };
  });

  // Callable by anyone (no auth check at all - this is the discovery path,
  // not an admin one): the viewer calls this to learn whether the visitor
  // has an active "cusuco" subscription and how many scans they have left
  // today, and in doing so, a never-seen pubkey gets a row created here
  // with activeUntil: null - "known, but never granted access". This is
  // deliberately the *only* way scanSubscribers rows come into existence
  // other than the operator's own admin panel - it's what turns "every
  // visitor who opens the map" into "a list of npubs the operator can
  // choose to grant a subscription to", without requiring anyone to
  // manually hand over their own npub out of band. Never grants anything
  // itself - an auto-created row's activeUntil is always null, which reads
  // as "not active" exactly like an admin-set one that's expired.
  // seenCount reaching this many checkScanSubscription calls is what
  // frequentVisitor (below) reports - purely a viewer-facing courtesy
  // signal (e.g. "welcome back" copy), no effect on cusuco access/quota.
  const FREQUENT_VISITOR_THRESHOLD = 10;

  rpc.handle("checkScanSubscription", async (_params, { fromPubkey }) => {
    const now = Date.now();
    const existing = await state.scanSubscribers.get(fromPubkey);
    // firstSeenAt is set once and never touched again; lastSeenAt and
    // seenCount are bumped on every call, including an existing row's -
    // this is what eventually lets a "showed up once and never came back"
    // row be told apart from a repeat visitor (see the retention discussion
    // this came out of - not yet acted on by anything, just recorded for
    // now). seenCount is purely informational (an operator sanity check on
    // how real/active a given npub is), nothing currently reads it.
    // attributionTag (see approveScanResults) is computed once, right here,
    // the first time this npub is ever encountered - never recomputed after
    // that, so it stays stable across every scan this npub ever shares,
    // even if the underlying CRC16 implementation's exact bytes-in were to
    // change later. It's the CRC16 of the npub (bech32 form, not raw hex)
    // per the operator's own spec: short, deterministic, and reveals
    // nothing about the actual identity - a future feature will let the
    // operator override it with a real display name (see
    // scanSubscribers' own storage comment), which is why the resolution
    // in approveScanResults checks for that override first rather than
    // assuming this tag is always what gets shown.
    const subscriber = existing
      ? { ...existing, lastSeenAt: now, seenCount: (existing.seenCount ?? 1) + 1 }
      : {
          pubkeyHex: fromPubkey,
          activeUntil: null,
          note: "",
          firstSeenAt: now,
          lastSeenAt: now,
          seenCount: 1,
          attributionTag: crc16Tag(encodeNpub(fromPubkey)),
        };
    await state.scanSubscribers.put(subscriber);
    const isActive = Boolean(subscriber.activeUntil) && new Date(subscriber.activeUntil).getTime() >= Date.now();
    const today = todayKey();
    const usedToday = subscriber.scansUsedDate === today ? (subscriber.scansUsedToday ?? 0) : 0;
    return {
      ok: true,
      active: isActive,
      activeUntil: subscriber.activeUntil,
      cusucosRemaining: isActive ? Math.max(0, resolveSubscriberDailyLimit(subscriber) - usedToday) : 0,
      frequentVisitor: subscriber.seenCount >= FREQUENT_VISITOR_THRESHOLD,
    };
  });

  // Every visitor who's ever called checkScanSubscription gets a row here
  // (see that handler), most of which never get granted access - as the
  // map's own visitor count grows, an unpaginated response eventually
  // exceeds relay event-size limits (confirmed live: "event too large").
  const SCAN_SUBSCRIBERS_PAGE_SIZE = 20;

  // Granted subscribers (activeUntil set) first, soonest-to-expire first -
  // the operator's most actionable view (who needs renewal attention) -
  // tie-broken by seenCount descending; never-granted visitors (activeUntil
  // null) after all of those, sorted by seenCount descending so the most
  // frequent unreviewed visitors surface first within that group. Relies on
  // Array#sort's stability (guaranteed since ES2019) for any remaining tie,
  // rather than a third explicit key.
  function compareScanSubscribers(a, b) {
    const aGranted = Boolean(a.activeUntil);
    const bGranted = Boolean(b.activeUntil);
    if (aGranted !== bGranted) return aGranted ? -1 : 1;
    if (aGranted) {
      const byActiveUntil = new Date(a.activeUntil).getTime() - new Date(b.activeUntil).getTime();
      if (byActiveUntil !== 0) return byActiveUntil;
    }
    return (b.seenCount ?? 0) - (a.seenCount ?? 0);
  }

  // Admin-only (self-pubkey) view/edit of the scan-subscriber ledger - see
  // worker/storage/indexeddb.js's own comment on scanSubscribers. Paginated
  // (see SCAN_SUBSCRIBERS_PAGE_SIZE/compareScanSubscribers above) - sorted
  // fresh, then sliced, on every call, so an admin paging through stays
  // consistent only as long as nothing else edits the ledger mid-browse (an
  // accepted, minor edge case for an admin-only tool like this).
  rpc.handle("listScanSubscribers", async (params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    const offset = Math.max(0, Number(params?.offset) || 0);
    const all = await state.scanSubscribers.all();
    all.sort(compareScanSubscribers);
    const subscribers = all.slice(offset, offset + SCAN_SUBSCRIBERS_PAGE_SIZE);
    return { ok: true, subscribers, total: all.length, hasMore: offset + SCAN_SUBSCRIBERS_PAGE_SIZE < all.length };
  });
  rpc.handle("setScanSubscriber", async (params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    let pubkeyHex;
    try {
      pubkeyHex = decodeNpub(params?.npub);
    } catch (err) {
      return { ok: false, error: `invalid npub: ${err.message}` };
    }
    const activeUntil = String(params?.activeUntil ?? "").trim();
    if (!activeUntil || Number.isNaN(new Date(activeUntil).getTime())) return { ok: false, error: "activeUntil must be a valid date." };
    const note = typeof params?.note === "string" ? params.note : "";
    const existing = await state.scanSubscribers.get(pubkeyHex);

    // Per-subscriber override of scanDailyLimitPerSubscriber - see
    // resolveSubscriberDailyLimit. Omitting the param entirely preserves
    // whatever was already set; an explicit blank clears it back to "use
    // the fleet-wide default" rather than being rejected as invalid.
    let dailyLimit = existing?.dailyLimit ?? null;
    if (params?.dailyLimit !== undefined) {
      const raw = String(params.dailyLimit).trim();
      if (raw === "") {
        dailyLimit = null;
      } else {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, error: "dailyLimit must be a positive integer, or blank to use the default." };
        dailyLimit = parsed;
      }
    }

    // Preserves any existing quota-usage fields - this call only ever
    // touches activeUntil/note/dailyLimit, never scansUsedToday/scansUsedDate.
    await state.scanSubscribers.put({ ...existing, pubkeyHex, activeUntil, note, dailyLimit });
    return { ok: true };
  });
  rpc.handle("removeScanSubscriber", async (params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    let pubkeyHex;
    try {
      pubkeyHex = decodeNpub(params?.npub);
    } catch (err) {
      return { ok: false, error: `invalid npub: ${err.message}` };
    }
    await state.scanSubscribers.delete(pubkeyHex);
    return { ok: true };
  });
  rpc.start();

  wireNostrPublishing(bus, transport, logger);
  await republishAllActive(state, transport, logger);
  // Once at startup, not on the 60s status heartbeat - see
  // NostrTransport#publishWorkerConfig. `null` tells a viewer push
  // registration isn't available rather than erroring.
  await transport
    .publishWorkerConfig({ vapidPublicKey: publicConfig.vapidPublicKey ?? null })
    .catch((err) => logger.error("nostr", `worker config publish failed: ${err.message}`));

  setInterval(() => {
    transport
      .publishWorkerStatus({ at: Date.now(), relays: publicConfig.relays.length })
      .catch((err) => logger.error("nostr", `status publish failed: ${err.message}`));
  }, WORKER_STATUS_INTERVAL_MS);

  startDashboard({
    bus,
    state,
    transport,
    pushTransport,
    getConfig: () => publicConfig,
    getVapidPrivateKeyPresent: () => Boolean(secretConfig.vapidPrivateKey),
  });

  document.getElementById("export-data").addEventListener("click", async () => {
    const statusEl = document.getElementById("export-data-status");
    statusEl.textContent = "Exporting…";
    statusEl.hidden = false;
    try {
      const dump = await exportAllData();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const link = document.createElement("a");
      link.href = url;
      link.download = `cusucomap-worker-backup-${timestamp}.json`;
      link.click();
      URL.revokeObjectURL(url);
      statusEl.textContent = "Downloaded.";
    } catch (err) {
      logger.error("worker", `export failed: ${err.message}`);
      statusEl.textContent = `Failed: ${err.message}`;
    }
    setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  });

  document.getElementById("expire-field-research").addEventListener("click", async () => {
    const activeCount = (await state.fieldResearch.active()).length;
    if (activeCount === 0) {
      logger.info("pokemon-state", "no active field research to expire.");
      return;
    }
    if (!confirm(`Expire all ${activeCount} active field research quests now? This can't be undone.`)) return;

    const statusEl = document.getElementById("expire-field-research-status");
    statusEl.textContent = "Expiring…";
    statusEl.hidden = false;
    const expiredCount = await pokemonState.expireAllFieldResearchNow();
    statusEl.textContent = `Expired ${expiredCount}.`;
    setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  });

  // See UPDATE_CHECK_INTERVAL_MS/AUTO_RESUME_SESSION_KEY's own comment for
  // why this exists at all. Skipped entirely if the currently-rendered
  // page has no build-date element to compare against (shouldn't happen
  // on a real deploy, but a stray dev-server load has nothing meaningful
  // to detect a change against either way).
  const runningBuildDate = getRenderedBuildDate();
  if (runningBuildDate) {
    setInterval(async () => {
      let latestBuildDate;
      try {
        const res = await fetch(location.pathname, { cache: "no-store" });
        if (!res.ok) return;
        latestBuildDate = extractBuildDate(await res.text());
      } catch (err) {
        logger.warn("worker", `update check failed: ${err.message}`);
        return;
      }
      if (!latestBuildDate || latestBuildDate === runningBuildDate) return;

      logger.info("worker", `new build detected (${runningBuildDate} -> ${latestBuildDate}) - reloading to pick it up`);
      try {
        sessionStorage.setItem(AUTO_RESUME_SESSION_KEY, JSON.stringify({ publicConfig, secretConfig }));
      } catch (err) {
        logger.warn("worker", `couldn't stash auto-resume state (${err.message}) - reloading to the setup screen instead`);
      }
      location.reload();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  logger.info("worker", `started as ${transport.identity.npub}`);
}

function populateSetupForm(publicConfig, secretConfig) {
  document.getElementById("field-relays").value = publicConfig.relays.join("\n");
  document.getElementById("field-source-feed-channels").value = publicConfig.trackedChannelIds.join("\n");
  document.getElementById("field-watch-channel-name").value = publicConfig.watchChannelName;
  document.getElementById("field-miniscord-url").value = publicConfig.miniscordUrl;
  document.getElementById("field-google-client-id").value = publicConfig.googleClientId;
  document.getElementById("field-vapid-public").value = publicConfig.vapidPublicKey;
  document.getElementById("field-vapid-contact").value = publicConfig.vapidContact;
  document.getElementById("field-remember-secrets").checked = publicConfig.rememberSecrets;
  document.getElementById("field-nsec").value = secretConfig.nsec;
  document.getElementById("field-vapid-private").value = secretConfig.vapidPrivateKey;
  document.getElementById("field-fcm-service-account").value = secretConfig.fcmServiceAccountJson;
}

function readSetupForm() {
  const publicConfig = {
    relays: parseLines(document.getElementById("field-relays").value),
    trackedChannelIds: parseLines(document.getElementById("field-source-feed-channels").value),
    watchChannelName: document.getElementById("field-watch-channel-name").value.trim(),
    miniscordUrl: document.getElementById("field-miniscord-url").value.trim(),
    googleClientId: document.getElementById("field-google-client-id").value.trim(),
    vapidPublicKey: document.getElementById("field-vapid-public").value.trim(),
    vapidContact: document.getElementById("field-vapid-contact").value.trim(),
    rememberSecrets: document.getElementById("field-remember-secrets").checked,
    geofilterAnchor: { lat: 13.675873, lon: -89.281163 },
  };
  const secretConfig = {
    nsec: document.getElementById("field-nsec").value.trim(),
    vapidPrivateKey: document.getElementById("field-vapid-private").value.trim(),
    fcmServiceAccountJson: document.getElementById("field-fcm-service-account").value.trim(),
  };
  return { publicConfig, secretConfig };
}

async function activateDashboard(publicConfig, secretConfig) {
  await startWorker(publicConfig, secretConfig);
  document.getElementById("setup-screen").hidden = true;
  document.getElementById("dashboard-screen").hidden = false;
}

/**
 * Consumes (single-use) the sessionStorage note a self-triggered reload
 * left for itself - see UPDATE_CHECK_INTERVAL_MS's own comment. Returns
 * whether it actually found and used one, so main() knows whether to fall
 * back to the normal setup screen.
 */
async function tryAutoResume() {
  let raw;
  try {
    raw = sessionStorage.getItem(AUTO_RESUME_SESSION_KEY);
    if (raw) sessionStorage.removeItem(AUTO_RESUME_SESSION_KEY);
  } catch {
    return false; // sessionStorage unavailable (private-browsing edge cases) - nothing to resume from
  }
  if (!raw) return false;

  try {
    const { publicConfig, secretConfig } = JSON.parse(raw);
    await activateDashboard(publicConfig, secretConfig);
    return true;
  } catch (err) {
    console.error("[worker-app] auto-resume failed, falling back to the setup screen:", err);
    return false;
  }
}

function main() {
  tryAutoResume().then((resumed) => {
    if (!resumed) renderSetupScreen();
  });
}

function renderSetupScreen() {
  const publicConfig = loadPublicConfig();
  const secretConfig = publicConfig.rememberSecrets ? loadSecretConfig() : defaultSecretConfig();
  populateSetupForm(publicConfig, secretConfig);

  const errorEl = document.getElementById("setup-error");
  const setupForm = document.getElementById("setup-form");
  const submitButton = setupForm.querySelector('button[type="submit"]');
  const statusEl = document.getElementById("setup-status");
  // startWorker() awaits a lot of network I/O (republishAllActive, etc.)
  // before the setup screen ever gets hidden below - a second click/Enter
  // in that window used to run the whole thing twice, standing up two
  // independent SourceFeedConnector/NostrTransport/etc. instances that each
  // registered their own bridgeChannel listeners, so every subsequent
  // bridge message got handled (and logged) twice for the rest of the
  // page's life. Guarded here since nothing downstream is idempotent to
  // being started more than once.
  let starting = false;

  setupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (starting) return;
    starting = true;
    submitButton.disabled = true;
    errorEl.hidden = true;
    // startWorker() mostly waits on relay round trips - connecting, then
    // republishAllActive() re-publishing every currently-active spawn/raid/
    // quest one at a time - which is why this can take up to ~30s on a
    // worker with a lot of active entities. Not a log, just enough to say
    // the button press registered and something is actually happening.
    statusEl.textContent = "Connecting to relays and syncing active spawns/raids/quests…";
    statusEl.hidden = false;
    const { publicConfig, secretConfig } = readSetupForm();

    if (!secretConfig.nsec) {
      errorEl.textContent = "Worker NSEC is required to start.";
      errorEl.hidden = false;
      starting = false;
      submitButton.disabled = false;
      statusEl.hidden = true;
      return;
    }

    savePublicConfig(publicConfig);
    if (publicConfig.rememberSecrets) {
      saveSecretConfig(secretConfig);
    } else {
      clearPersistedSecrets();
    }

    try {
      await activateDashboard(publicConfig, secretConfig);
    } catch (err) {
      console.error("[worker-app] failed to start:", err);
      errorEl.textContent = `Failed to start: ${err.message}`;
      errorEl.hidden = false;
      starting = false;
      submitButton.disabled = false;
      statusEl.hidden = true;
    }
  });
}

main();
