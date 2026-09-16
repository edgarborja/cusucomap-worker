// Orchestrator: wires every module together and drives the two-screen UI
// (setup -> dashboard) in index.html. This file intentionally does the
// "wiring" only - business logic lives in services/connectors, Nostr
// mechanics live in transports/nostr-transport.js, etc. See worker/README.md
// for the module map this implements.
import { EventBus } from "./core/event-bus.js";
import { Logger } from "./core/logging.js";
import { createApplicationState } from "./core/application-state.js";
import { loadPublicConfig, savePublicConfig, loadSecretConfig, saveSecretConfig, clearPersistedSecrets, defaultAhkConfig, defaultSecretConfig } from "./core/config.js";
import { NostrTransport } from "./transports/nostr-transport.js";
import { Rpc } from "./transports/rpc.js";
import { TampermonkeyPushTransport } from "./transports/push-transport.js";
import { AhkTransport } from "./transports/ahk-transport.js";
import { SourceFeedConnector } from "./connectors/source-feed-connector.js";
import { AhkConnector } from "./connectors/ahk-connector.js";
import { WatchChannelConnector } from "./connectors/watch-channel-connector.js";
import { PokemonStateService } from "./services/pokemon-state.js";
import { AccountsService } from "./services/accounts.js";
import { NotificationsService } from "./services/notifications.js";
import { startDashboard } from "./dashboard/dashboard.js";
import { parseScanGroupsCsv, buildQuestGroupCommands, buildRaidGroupCommands } from "./core/scan-groups.js";
import { generateHexLattice, buildAreaScanCommand } from "./core/area-scan.js";
import { exportAllData } from "./storage/indexeddb.js";
import { crc16Tag } from "../shared/crc16.js";
import { KIND_SPAWN, KIND_QUEST, KIND_RAID, TRUSTED_VIEWER_PUBKEYS_HEX } from "../shared/nostr-protocol.js";

const WORKER_STATUS_INTERVAL_MS = 60_000;

function parseLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Local calendar date - matches ahk-connector.js's own todayKey() and
// pokemon-state.js's own copy; not worth a shared helper for three lines.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

const AHK_ENABLE_GRACE_MS = 5_000;

/**
 * Wires the dashboard's "Enable/Disable AHK" toggle. Starts disabled by
 * design (see worker/index.html's ahk-toggle button and this repo's own
 * incident where scheduled AHK commands silently overwrote the operator's
 * clipboard on their own timer) - AhkConnector.start()/stop() themselves
 * have no concept of "disabled by default" or a grace period, that's a
 * UI/operator-workflow concern owned entirely here, not connector business
 * logic. Enabling waits AHK_ENABLE_GRACE_MS before actually starting, so
 * there's time to alt-tab into the Source Feed window - the AHK script still
 * needs it focused to simulate keystrokes correctly, same as the old
 * clipboard-paste path did. Clicking again during the countdown cancels it.
 * @returns {{ isEnabled: () => boolean, enableThenRun: (syncCallback: () => unknown) => Promise<unknown> }}
 */
function wireAhkControls({ ahkConnector, logger, getConfig }) {
  const toggleButton = document.getElementById("ahk-toggle");
  const statusEl = document.getElementById("ahk-status");
  let enabled = false;
  let countdownTimer = null;
  let cancelCurrentEnable = null;
  // Only the very first enable of this page load sends the geofilter
  // safety-net reset (see defaultAhkConfig's own comment on
  // defaultGeofilterCommand) - a later disable/re-enable within the same
  // session isn't the "worker got interrupted mid-scan" case this exists
  // for, so it shouldn't re-fire every time.
  let startupGeofilterResetSent = false;

  function setDisabled() {
    clearTimeout(countdownTimer);
    countdownTimer = null;
    cancelCurrentEnable?.();
    cancelCurrentEnable = null;
    if (enabled) ahkConnector.stop();
    enabled = false;
    toggleButton.textContent = "Enable AHK";
    statusEl.textContent = "Disabled";
  }

  /**
   * Enables AHK if it isn't already (running the same grace-period
   * countdown as before), then calls `syncCallback` and resolves/rejects
   * with its result - used directly by the toggle button (with a no-op
   * callback) and by the bulk-scan buttons (see wireBulkScanSection),
   * which need their scan to claim priority the instant AHK starts rather
   * than race the scheduled batch for it. That guarantee is *why*
   * `syncCallback` is invoked synchronously, in the same tick as
   * ahkConnector.start(), rather than via a caller separately awaiting a
   * resolved promise and calling it after - going through even one extra
   * `await` before calling it would leave a window for #runScheduledBatch's
   * own already-suspended continuation to run first (see
   * AhkConnector#runBulkScan's own "no await gap" reasoning for the same
   * class of bug, fixed the same way here).
   * @param {() => unknown} syncCallback
   */
  function enableThenRun(syncCallback) {
    if (enabled) return Promise.resolve(syncCallback());
    if (countdownTimer) return Promise.reject(new Error("Already enabling AHK - wait for that to finish first."));

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      toggleButton.textContent = "Cancel";
      let cancelled = false;
      cancelCurrentEnable = () => {
        cancelled = true;
      };
      const tick = () => {
        if (cancelled) {
          reject(new Error("Enabling AHK was cancelled."));
          return;
        }
        const remainingS = Math.max(0, Math.ceil((AHK_ENABLE_GRACE_MS - (Date.now() - startedAt)) / 1000));
        if (remainingS <= 0) {
          countdownTimer = null;
          cancelCurrentEnable = null;
          enabled = true;
          ahkConnector.start();
          toggleButton.textContent = "Disable AHK";
          statusEl.textContent = "Enabled";
          logger.info("ahk", "AHK enabled - sending scheduled/daily/manual commands.");
          if (!startupGeofilterResetSent) {
            startupGeofilterResetSent = true;
            // Not awaited - same "no await gap before syncCallback" reasoning
            // as this function's own doc comment above: sendCustomCommand
            // still queues onto the same #sendChain as syncCallback's own
            // first send (e.g. an area scan's beforeCommand), so ordering
            // between the two is preserved without blocking this tick.
            ahkConnector
              .sendCustomCommand(getConfig().defaultGeofilterCommand)
              .catch((err) => logger.error("ahk", `startup geofilter reset failed: ${err.message}`));
          }
          resolve(syncCallback());
          return;
        }
        statusEl.textContent = `Starting in ${remainingS}s - switch to the Source Feed window now`;
        countdownTimer = setTimeout(tick, 250);
      };
      tick();
    });
  }

  toggleButton.addEventListener("click", () => {
    if (enabled || countdownTimer) setDisabled();
    else enableThenRun(() => {}).catch(() => {}); // errors are already reflected in statusEl above
  });

  setDisabled();
  return { isEnabled: () => enabled, enableThenRun };
}

// Not a secret - just pasted scan-group coordinates - so this persists
// unconditionally, unlike the commands page's opt-in-only NSEC storage.
const SCAN_CSV_STORAGE_PREFIX = "cusucomap-worker:scan-csv:";

/**
 * Wires one bulk-scan <details> section (see index.html's quest-scan/
 * raid-scan id groups) - shared between both sections since they're
 * identical apart from which command-builder they use.
 * @param {string} id - "quest-scan" or "raid-scan".
 * @param {(location: object) => string[]} buildRowCommands
 */
function wireBulkScanSection(id, buildRowCommands, { ahkConnector, ahkControls, logger }) {
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

  startButton.addEventListener("click", async () => {
    const { groups, errors } = parseScanGroupsCsv(textarea.value);
    for (const err of errors) logger.warn("ahk", `${id}: ${err}`);
    if (groups.length === 0) {
      logger.warn("ahk", `${id}: nothing to scan - paste the group list first.`);
      return;
    }
    const enableNotice = ahkControls.isEnabled() ? "" : " AHK is currently disabled, so this will enable it first (same 5s grace period as the toggle button).";
    if (!confirm(`Start a scan over ${groups.length} groups? This takes priority over the scheduled loop and hundo detection until it finishes.${enableNotice}`)) return;

    startButton.hidden = true;
    cancelButton.hidden = false;
    statusEl.hidden = false;
    statusEl.textContent = "Starting…";

    try {
      // enableThenRun (not just checking isEnabled()) is what makes this
      // scan take actual priority when AHK was off: it enables AHK and
      // starts the scan in the same tick, so the scan claims the send
      // queue before the freshly-started scheduled batch gets a chance to
      // queue anything - see that function's own comment for why.
      const result = await ahkControls.enableThenRun(() =>
        ahkConnector.runBulkScan(groups, buildRowCommands, (sent, total) => {
          statusEl.textContent = `Sending ${sent}/${total}…`;
        })
      );
      statusEl.textContent = result.cancelled ? `Cancelled after ${result.sent}/${result.total}.` : `Done - sent ${result.sent} commands.`;
    } catch (err) {
      logger.error("ahk", `${id} failed: ${err.message}`);
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      startButton.hidden = false;
      cancelButton.hidden = true;
    }
  });

  cancelButton.addEventListener("click", () => ahkConnector.cancelBulkScan());
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

  // Set only for the duration of a subscriber-requested scan's own
  // bulk-scan-priority window (see runAreaScan below and
  // source-feed-connector.js's #emitSpawn) - null otherwise, including for
  // the operator's own (self) scans.
  let activeScanId = null;

  const sourceFeedConnector = new SourceFeedConnector({
    bus,
    logger,
    state,
    getGeofilterAnchor: () => publicConfig.geofilterAnchor,
    getTrackedChannelIds: () => publicConfig.trackedChannelIds,
    getActiveScanId: () => activeScanId,
  });
  sourceFeedConnector.start();

  const ahkTransport = new AhkTransport();
  const ahkConnector = new AhkConnector({ bus, logger, state, getConfig: defaultAhkConfig, ahkTransport });
  const ahkControls = wireAhkControls({ ahkConnector, logger, getConfig: defaultAhkConfig });

  const watchChannelConnector = new WatchChannelConnector({
    bus,
    logger,
    getWatchChannelName: () => publicConfig.watchChannelName,
    getPriorityScanConfig: () => {
      const config = defaultAhkConfig();
      return { messages: config.priorityScanMessages, pause: { minS: config.priorityScanPauseMinS, maxS: config.priorityScanPauseMaxS } };
    },
    getClearUnreadHotkey: () => defaultAhkConfig().clearUnreadHotkey,
    ahkConnector,
    isAhkEnabled: ahkControls.isEnabled,
  });
  watchChannelConnector.start();

  wireBulkScanSection("quest-scan", buildQuestGroupCommands, { ahkConnector, ahkControls, logger });
  wireBulkScanSection("raid-scan", buildRaidGroupCommands, { ahkConnector, ahkControls, logger });

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

  const pushTransport = new TampermonkeyPushTransport();
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
  // tools/set-ahk-commands.mjs, which sign as the worker's own identity):
  // this is admin control over what gets typed into the operator's own
  // Discord session, not something to expose to an arbitrary caller who
  // merely knows the worker's public npub. Returning {ok:false, ...} here
  // rather than throwing is deliberate - rpc.js's #dispatch collapses any
  // thrown error into a generic "Internal error" message.
  rpc.handle("getAhkCommands", async (_params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    return { ok: true, ...(await ahkConnector.getCommands()) };
  });
  rpc.handle("setAhkCommands", async (params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    return ahkConnector.applyCommands(params ?? {});
  });
  // A subscriber's own dailyLimit (set via setScanSubscriber's admin panel
  // field) overrides the fleet-wide default - absent/null means "use the
  // default", not "zero". Centralized here so authorizeScanRequest and
  // checkScanSubscription's own cusucosRemaining can never drift apart on
  // what "the limit" actually means for a given subscriber.
  function resolveSubscriberDailyLimit(subscriber) {
    return subscriber?.dailyLimit ?? defaultAhkConfig().scanDailyLimitPerSubscriber;
  }

  // Authorizes a scan request (runAreaScan, and later runSpeciesScan) and,
  // for a non-self caller, charges one scan against their daily "cusuco"
  // quota in the same call - see worker/storage/indexeddb.js's own comment
  // on why this ledger is its own store, never merged into
  // pushSubscriptions. The operator's own (self) requests are always
  // allowed, unlimited, no quota touched.
  async function authorizeScanRequest(fromPubkey) {
    if (fromPubkey === transport.identity.hex) return { ok: true, isSelf: true };
    const subscriber = await state.scanSubscribers.get(fromPubkey);
    if (!subscriber) return { ok: false, error: "no scan subscription found for this account." };
    if (new Date(subscriber.activeUntil).getTime() < Date.now()) return { ok: false, error: "scan subscription has expired." };
    const today = todayKey();
    const usedToday = subscriber.scansUsedDate === today ? (subscriber.scansUsedToday ?? 0) : 0;
    if (usedToday >= resolveSubscriberDailyLimit(subscriber)) return { ok: false, error: "daily scan limit reached - resets tomorrow." };
    await state.scanSubscribers.put({ ...subscriber, scansUsedToday: usedToday + 1, scansUsedDate: today });
    return { ok: true, isSelf: false };
  }

  // Starts a bulk area scan (see commands/commands-app.js's "Area scan"
  // section and worker/core/area-scan.js) and returns as soon as it's
  // *started*, not once it finishes - a scan can run for many minutes
  // (dozens of /pokesearch commands, each with its own settle pause), far
  // longer than an RPC round trip over Nostr relays should ever block for.
  // For the operator's own (self) request, this is unchanged from before:
  // results publish immediately and normally, no pool involved. For a
  // subscriber, results instead land in a private pendingScanPools row
  // (see source-feed-connector.js's #emitSpawn) that only they (or the
  // operator) can read back via getScanResults, and only they (or the
  // operator) can make public via approveScanResults - the request body of
  // that call carries no spawn data at all, only the id, so there is no way
  // for a caller to inject anything into what gets broadcast.
  rpc.handle("runAreaScan", async (params, { fromPubkey }) => {
    const auth = await authorizeScanRequest(fromPubkey);
    if (!auth.ok) return { ok: false, error: auth.error };

    const centerLat = Number(params?.centerLat);
    const centerLon = Number(params?.centerLon);
    const { subscriberScanRadiusKmText, areaScanClearGeofilterCommand, defaultGeofilterCommand } = defaultAhkConfig();
    // A subscriber never controls the per-circle radius or ring count -
    // both fixed server-side regardless of what's sent, not just a
    // client-side limit, since a self-crafted request could otherwise ask
    // for anything. Only the operator's own (self) scans may set their own
    // radius and use the full 1-5 ring range.
    const radiusKmText = auth.isSelf ? String(params?.radiusKmText ?? "").trim() : subscriberScanRadiusKmText;
    const radiusKm = Number(radiusKmText);
    const rings = auth.isSelf ? Number(params?.rings) : 1;

    if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) return { ok: false, error: "centerLat must be a number between -90 and 90." };
    if (!Number.isFinite(centerLon) || centerLon < -180 || centerLon > 180) return { ok: false, error: "centerLon must be a number between -180 and 180." };
    if (!radiusKmText || !Number.isFinite(radiusKm) || radiusKm <= 0) return { ok: false, error: "radiusKmText must be a positive number." };
    if (!Number.isInteger(rings) || rings < 1 || rings > 5) return { ok: false, error: "rings must be an integer between 1 and 5." };
    if (ahkConnector.isBulkScanActive()) return { ok: false, error: "A scan is already running." };

    const points = generateHexLattice({ centerLat, centerLon, radiusKm, rings });

    const scanId = auth.isSelf ? null : crypto.randomUUID();
    if (scanId) {
      activeScanId = scanId;
      // Not awaited - awaiting this here would delay the enableThenRun()
      // call below by at least a tick, which is exactly the race that
      // function's own doc comment (and AhkConnector#runBulkScan's
      // identical "no await gap" reasoning) exists to prevent: the
      // scheduled loop's own already-suspended continuation only re-checks
      // #bulkScanGate at the top of its next iteration, so any gap here is
      // a window for it to queue a send first, stealing this scan's
      // priority. A local IndexedDB write completes in well under a
      // millisecond in practice, long before the scan's own
      // beforeCommand+settle-pause+first-search could possibly produce a
      // spawn for #emitSpawn to append to this pool.
      state.pendingScanPools
        .put({ scanId, scanType: "area", requestedByPubkeyHex: fromPubkey, createdAt: Date.now(), status: "collecting", spawns: [] })
        .catch((err) => logger.error("worker", `failed to create pending scan pool: ${err.message}`));
    }

    async function finishPool() {
      if (!scanId) return;
      activeScanId = null;
      const pool = await state.pendingScanPools.get(scanId);
      if (pool && pool.status === "collecting") await state.pendingScanPools.put({ ...pool, status: "pending" });
    }

    // Deliberately not awaited - see this handler's own doc comment above.
    ahkControls
      .enableThenRun(() =>
        ahkConnector.runBulkScan(points, (point) => [buildAreaScanCommand({ ...point, radiusKmText })], undefined, {
          beforeCommand: areaScanClearGeofilterCommand,
          afterCommand: defaultGeofilterCommand,
        })
      )
      .then(async (result) => {
        logger.info(
          "ahk",
          result.cancelled ? `area scan cancelled after ${result.sent}/${result.total}` : `area scan done - sent ${result.sent} commands`
        );
        await finishPool();
      })
      .catch(async (err) => {
        logger.error("ahk", `area scan failed: ${err.message}`);
        await finishPool();
      });

    return { ok: true, total: points.length, scanId };
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
    // PROTOCOL.md documents both as additive, optional Spawn fields.
    // displayNameOverride doesn't exist yet (a later feature lets the
    // operator set one, with the subscriber's approval) - checking for it
    // here now means approveScanResults won't need to change when that
    // ships. Falls back to a fixed placeholder rather than failing the
    // whole approve if the requester's own ledger row is somehow gone (e.g.
    // manually removed by the operator between request and approval).
    const requester = await state.scanSubscribers.get(pool.requestedByPubkeyHex);
    const sharedByTag = requester?.displayNameOverride || requester?.attributionTag || "????";
    const discoveredVia = pool.scanType === "species" ? "species-scan" : "area-scan";

    for (const spawn of pool.spawns) bus.emit("spawn.observed", { ...spawn, discoveredVia, sharedByTag });
    await state.pendingScanPools.put({ ...pool, status: "broadcast" });
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
    };
  });

  // Admin-only (self-pubkey) view/edit of the scan-subscriber ledger - see
  // worker/storage/indexeddb.js's own comment on scanSubscribers.
  rpc.handle("listScanSubscribers", async (_params, { fromPubkey }) => {
    if (fromPubkey !== transport.identity.hex) return { ok: false, error: "forbidden - caller's pubkey doesn't match this worker's own identity" };
    return { ok: true, subscribers: await state.scanSubscribers.all() };
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

  document.getElementById("ahk-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("ahk-command-input");
    const value = input.value.trim();
    if (!value) return;
    if (!ahkControls.isEnabled()) {
      logger.warn("ahk", "AHK is disabled - click \"Enable AHK\" first.");
      return;
    }
    input.value = "";
    await ahkConnector.sendCustomCommand(value);
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

  logger.info("worker", `started as ${transport.identity.npub}`);
}

function populateSetupForm(publicConfig, secretConfig) {
  document.getElementById("field-relays").value = publicConfig.relays.join("\n");
  document.getElementById("field-source-feed-channels").value = publicConfig.trackedChannelIds.join("\n");
  document.getElementById("field-watch-channel-name").value = publicConfig.watchChannelName;
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

function main() {
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
      await startWorker(publicConfig, secretConfig);
      document.getElementById("setup-screen").hidden = true;
      document.getElementById("dashboard-screen").hidden = false;
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
