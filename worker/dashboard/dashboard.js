// Renders into the static DOM already in index.html's #dashboard-screen -
// this file only updates cells/rows on an interval and in response to bus
// events, it doesn't own page navigation or the setup form (see
// worker-app.js for that). All untrusted text (species/city/etc, ultimately
// from Source Feed) goes through escapeHtml before landing in innerHTML.
import { escapeHtml } from "../../shared/schemas.js";

const MAX_LOG_ROWS = 200;

function statusClass(ok) {
  if (ok === true) return "status-ok";
  if (ok === false) return "status-error";
  return "status-warn";
}

function row(label, ok, detail) {
  return `<tr><td>${escapeHtml(label)}</td><td class="${statusClass(ok)}">${escapeHtml(detail)}</td></tr>`;
}

/**
 * @param {object} deps
 * @param {import("../core/event-bus.js").EventBus} deps.bus
 * @param {ReturnType<typeof import("../core/application-state.js").createApplicationState>} deps.state
 * @param {import("../transports/nostr-transport.js").NostrTransport} deps.transport
 * @param {import("../transports/push-transport.js").TampermonkeyPushTransport} deps.pushTransport
 * @param {() => import("../core/config.js").PublicConfig} deps.getConfig
 * @param {() => boolean} deps.getVapidPrivateKeyPresent
 */
export function startDashboard({ bus, state, transport, pushTransport, getConfig, getVapidPrivateKeyPresent }) {
  const npubEl = document.getElementById("worker-npub");
  const healthTable = document.getElementById("health-table");
  const countersTable = document.getElementById("counters-table");
  const activityLog = document.getElementById("activity-log");

  npubEl.textContent = transport.identity.npub;
  npubEl.hidden = false;

  let sourceFeedBridgeConnected = false;
  bus.on("source-feed.bridge-status", (status) => {
    sourceFeedBridgeConnected = Boolean(status?.connected);
  });

  function renderHealth() {
    const config = getConfig();
    const relayStatus = transport.relayStatus();
    const relaysOk = relayStatus ? relayStatus.every((r) => r.connected) : null;
    const relaysDetail = relayStatus
      ? `${relayStatus.filter((r) => r.connected).length}/${relayStatus.length} connected`
      : `${config.relays.length} configured (live status unavailable)`;
    const vapidReady = Boolean(config.vapidPublicKey) && getVapidPrivateKeyPresent();

    healthTable.innerHTML = [
      row("Worker identity", true, `${transport.identity.npub.slice(0, 24)}…`),
      row("Nostr relays", relaysOk, relaysDetail),
      row("Source Feed bridge", sourceFeedBridgeConnected, sourceFeedBridgeConnected ? "connected" : "not detected"),
      row("Google auth", Boolean(config.googleClientId), config.googleClientId ? "configured" : "not configured"),
      row("VAPID", vapidReady, vapidReady ? "configured" : "not configured"),
      row("Push bridge", pushTransport.isBridgeConnected(), pushTransport.isBridgeConnected() ? "connected" : "not detected"),
    ].join("");
  }

  async function renderCounters() {
    const [spawns, raids, research, users, subs, eventsProcessed, pushesSent, validationErrors, pushErrors] = await Promise.all([
      state.spawns.active(),
      state.raids.active(),
      state.fieldResearch.active(),
      state.users.all(),
      state.pushSubscriptions.all(),
      state.workerMetadata.get("eventsProcessed", 0),
      state.workerMetadata.get("pushesSent", 0),
      state.workerMetadata.get("validationErrors", 0),
      state.workerMetadata.get("pushErrors", 0),
    ]);
    const rows = [
      ["Active spawns", spawns.length],
      ["Active raids", raids.length],
      ["Field research", research.length],
      ["Users", users.length],
      ["Push subscriptions", subs.length],
      ["Events processed", eventsProcessed],
      ["Pushes sent", pushesSent],
      ["Errors", validationErrors + pushErrors],
    ];
    countersTable.innerHTML = rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${value}</td></tr>`).join("");
  }

  bus.on("log.entry", (entry) => {
    const li = document.createElement("li");
    li.className = `level-${entry.level}`;
    li.textContent = `${new Date(entry.at).toLocaleTimeString()} [${entry.scope}] ${entry.message}`;
    // Within a few px of the bottom counts as "already following the tail" -
    // autoscrolling unconditionally on every entry would otherwise yank the
    // view back down out from under someone who deliberately scrolled up to
    // read older entries.
    const wasAtBottom = activityLog.scrollHeight - activityLog.scrollTop - activityLog.clientHeight < 4;
    activityLog.append(li);
    while (activityLog.children.length > MAX_LOG_ROWS) activityLog.firstChild.remove();
    if (wasAtBottom) activityLog.scrollTop = activityLog.scrollHeight;
  });

  for (const topic of ["spawn.created", "spawn.updated", "spawn.expired", "raid.created", "raid.updated", "raid.expired", "fieldResearch.created", "fieldResearch.updated", "fieldResearch.expired"]) {
    bus.on(topic, renderCounters);
  }

  renderHealth();
  renderCounters();
  setInterval(renderHealth, 5000);
  setInterval(renderCounters, 10_000);
}
