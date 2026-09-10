// Orchestrator: wires every module together and drives the two-screen UI
// (setup -> dashboard) in index.html. This file intentionally does the
// "wiring" only - business logic lives in services/connectors, Nostr
// mechanics live in transports/nostr-transport.js, etc. See worker/README.md
// for the module map this implements.
import { EventBus } from "./core/event-bus.js";
import { Logger } from "./core/logging.js";
import { createApplicationState } from "./core/application-state.js";
import { loadPublicConfig, savePublicConfig, loadSecretConfig, saveSecretConfig, clearPersistedSecrets, defaultAhkConfig } from "./core/config.js";
import { NostrTransport } from "./transports/nostr-transport.js";
import { Rpc } from "./transports/rpc.js";
import { TampermonkeyPushTransport } from "./transports/push-transport.js";
import { AhkTransport } from "./transports/ahk-transport.js";
import { SourceFeedConnector } from "./connectors/source-feed-connector.js";
import { AhkConnector } from "./connectors/ahk-connector.js";
import { PokemonStateService } from "./services/pokemon-state.js";
import { AccountsService } from "./services/accounts.js";
import { NotificationsService } from "./services/notifications.js";
import { startDashboard } from "./dashboard/dashboard.js";
import { KIND_SPAWN, KIND_QUEST, KIND_RAID, TRUSTED_VIEWER_PUBKEYS_HEX } from "../shared/nostr-protocol.js";

const WORKER_STATUS_INTERVAL_MS = 60_000;

function parseLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
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
 * @returns {{ isEnabled: () => boolean }}
 */
function wireAhkControls({ ahkConnector, logger }) {
  const toggleButton = document.getElementById("ahk-toggle");
  const statusEl = document.getElementById("ahk-status");
  let enabled = false;
  let countdownTimer = null;

  function setDisabled() {
    clearTimeout(countdownTimer);
    countdownTimer = null;
    if (enabled) ahkConnector.stop();
    enabled = false;
    toggleButton.textContent = "Enable AHK";
    statusEl.textContent = "Disabled";
  }

  function setEnabling() {
    const startedAt = Date.now();
    toggleButton.textContent = "Cancel";
    const tick = () => {
      const remainingS = Math.max(0, Math.ceil((AHK_ENABLE_GRACE_MS - (Date.now() - startedAt)) / 1000));
      if (remainingS <= 0) {
        countdownTimer = null;
        enabled = true;
        ahkConnector.start();
        toggleButton.textContent = "Disable AHK";
        statusEl.textContent = "Enabled";
        logger.info("ahk", "AHK enabled - sending scheduled/daily/manual commands.");
        return;
      }
      statusEl.textContent = `Starting in ${remainingS}s - switch to the Source Feed window now`;
      countdownTimer = setTimeout(tick, 250);
    };
    tick();
  }

  toggleButton.addEventListener("click", () => {
    if (enabled || countdownTimer) setDisabled();
    else setEnabling();
  });

  setDisabled();
  return { isEnabled: () => enabled };
}

/** Re-broadcasts everything currently active on startup - a relay that pruned an entity while the worker was offline (or a newly-added relay with no history at all) still converges to the correct current state. */
async function republishAllActive(state, transport, logger) {
  const [spawns, raids, research] = await Promise.all([state.spawns.active(), state.raids.active(), state.fieldResearch.active()]);
  for (const s of spawns) await transport.publishEntity(KIND_SPAWN, s.id, s.despawnAt, s, `spawn ${s.species} (resync)`);
  for (const r of raids) await transport.publishEntity(KIND_RAID, r.id, r.endsAt, r, `raid ${r.bossSpecies ?? "?"} (resync)`);
  for (const q of research) await transport.publishEntity(KIND_QUEST, q.id, q.expiresAt, q, `quest ${q.rewardName} (resync)`);
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

  const sourceFeedConnector = new SourceFeedConnector({ bus, logger, state, getGeofilterAnchor: () => publicConfig.geofilterAnchor, getTrackedChannelIds: () => publicConfig.trackedChannelIds });
  sourceFeedConnector.start();

  const ahkTransport = new AhkTransport();
  const ahkConnector = new AhkConnector({ bus, logger, state, getConfig: defaultAhkConfig, ahkTransport });
  const ahkControls = wireAhkControls({ ahkConnector, logger });

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

  logger.info("worker", `started as ${transport.identity.npub}`);
}

function populateSetupForm(publicConfig, secretConfig) {
  document.getElementById("field-relays").value = publicConfig.relays.join("\n");
  document.getElementById("field-source-feed-channels").value = publicConfig.trackedChannelIds.join("\n");
  document.getElementById("field-google-client-id").value = publicConfig.googleClientId;
  document.getElementById("field-vapid-public").value = publicConfig.vapidPublicKey;
  document.getElementById("field-vapid-contact").value = publicConfig.vapidContact;
  document.getElementById("field-remember-secrets").checked = publicConfig.rememberSecrets;
  document.getElementById("field-nsec").value = secretConfig.nsec;
  document.getElementById("field-vapid-private").value = secretConfig.vapidPrivateKey;
}

function readSetupForm() {
  const publicConfig = {
    relays: parseLines(document.getElementById("field-relays").value),
    trackedChannelIds: parseLines(document.getElementById("field-source-feed-channels").value),
    googleClientId: document.getElementById("field-google-client-id").value.trim(),
    vapidPublicKey: document.getElementById("field-vapid-public").value.trim(),
    vapidContact: document.getElementById("field-vapid-contact").value.trim(),
    rememberSecrets: document.getElementById("field-remember-secrets").checked,
    geofilterAnchor: { lat: 13.675873, lon: -89.281163 },
  };
  const secretConfig = {
    nsec: document.getElementById("field-nsec").value.trim(),
    vapidPrivateKey: document.getElementById("field-vapid-private").value.trim(),
  };
  return { publicConfig, secretConfig };
}

function main() {
  const publicConfig = loadPublicConfig();
  const secretConfig = publicConfig.rememberSecrets ? loadSecretConfig() : { nsec: "", vapidPrivateKey: "" };
  populateSetupForm(publicConfig, secretConfig);

  const errorEl = document.getElementById("setup-error");
  const setupForm = document.getElementById("setup-form");
  const submitButton = setupForm.querySelector('button[type="submit"]');
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
    const { publicConfig, secretConfig } = readSetupForm();

    if (!secretConfig.nsec) {
      errorEl.textContent = "Worker NSEC is required to start.";
      errorEl.hidden = false;
      starting = false;
      submitButton.disabled = false;
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
    }
  });
}

main();
