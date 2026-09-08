// Decides who gets a Web Push notification and sends it. Preference
// matching: species alert OR any alerted type, one notification even if
// both match - evaluated against IndexedDB subscriptions, sent via
// services/push-sender.js + a PushTransport instead of the `web-push` npm
// package.
import { createWebPushRequest } from "./push-sender.js";

function normalize(text) {
  return String(text).trim().toLowerCase();
}

/** True if `preferences` should fire for a spawn of this species/types. Exported for unit testing. */
export function matchesSpawnAlert(preferences, species, types) {
  const speciesSet = new Set((preferences.species ?? []).map(normalize));
  const typeSet = new Set((preferences.types ?? []).map(normalize));
  const matchedTypes = (types ?? []).filter((t) => typeSet.has(normalize(t)));
  return { isMatch: speciesSet.has(normalize(species)) || matchedTypes.length > 0, matchedTypes };
}

export class NotificationsService {
  #state;
  #bus;
  #pushTransport;
  #getVapidConfig;
  #logger;

  /**
   * @param {object} deps
   * @param {() => { vapidPublicKey: string, vapidPrivateKey: string, contact: string } | null} deps.getVapidConfig
   *   Lazy accessor (not a captured value) so a config change/Start Worker
   *   after construction is picked up without re-wiring this service.
   */
  constructor({ state, bus, pushTransport, getVapidConfig, logger }) {
    this.#state = state;
    this.#bus = bus;
    this.#pushTransport = pushTransport;
    this.#getVapidConfig = getVapidConfig;
    this.#logger = logger;
  }

  start() {
    this.#bus.on("spawn.created", ({ entity }) => this.#notifySpawn(entity));
  }

  async #notifySpawn(spawn) {
    const vapid = this.#getVapidConfig();
    if (!vapid) return; // Web Push not configured - silently skip, dashboard already shows VAPID as not-ready

    const subscriptions = await this.#state.pushSubscriptions.all();
    for (const sub of subscriptions) {
      const { isMatch, matchedTypes } = matchesSpawnAlert(sub.preferences ?? {}, spawn.species, spawn.types ?? []);
      if (!isMatch) continue;
      const typeSuffix = matchedTypes.length > 0 && !sub.preferences.species?.some((s) => normalize(s) === normalize(spawn.species))
        ? ` (${matchedTypes.map((t) => t[0].toUpperCase() + t.slice(1)).join("/")} alert)`
        : "";
      await this.#send(sub, {
        title: `${spawn.species} spawned!`,
        body: `${spawn.ivPercent ?? "?"}% IV near ${spawn.cityRaw ?? "unknown location"}${typeSuffix}`,
        entityType: "spawn",
        entityId: spawn.id,
      });
    }
  }

  async #send(subscription, payload) {
    const vapid = this.#getVapidConfig();
    try {
      const request = await createWebPushRequest(subscription, payload, vapid);
      const result = await this.#pushTransport.send(request);
      if (result.ok) {
        await this.#state.workerMetadata.increment("pushesSent");
      } else if (result.status === 404 || result.status === 410) {
        // Permanently invalid endpoint (browser uninstalled/subscription
        // expired) - per the reliability brief, remove rather than retry.
        await this.#state.pushSubscriptions.delete(subscription.endpoint);
        this.#logger.info("push", `removed invalid subscription (HTTP ${result.status}): ${subscription.endpoint.slice(0, 60)}…`);
      } else {
        await this.#state.workerMetadata.increment("pushErrors");
        this.#logger.warn("push", `send failed (${result.status ?? result.error}): ${subscription.endpoint.slice(0, 60)}…`);
      }
    } catch (err) {
      await this.#state.workerMetadata.increment("pushErrors");
      this.#logger.error("push", `send threw: ${err.message}`);
    }
  }

  /** RPC handler: viewer enables/updates push notifications. */
  async updateNotificationPreferences({ subscription, preferences }, { fromPubkey }) {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      throw new Error("subscription.{endpoint, keys.p256dh, keys.auth} are required.");
    }
    const user = await this.#state.users.findByIdentity("nostr", fromPubkey);
    await this.#state.pushSubscriptions.put({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userId: user?.userId ?? null,
      nostrPubkey: fromPubkey,
      preferences: { species: preferences?.species ?? [], types: preferences?.types ?? [] },
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  /** RPC handler: viewer disables push notifications on this device. */
  async disableNotifications({ endpoint }) {
    if (typeof endpoint !== "string") throw new Error("endpoint is required.");
    await this.#state.pushSubscriptions.delete(endpoint);
    return { ok: true };
  }

  registerRpc(rpc) {
    rpc.handle("updateNotificationPreferences", (params, ctx) => this.updateNotificationPreferences(params, ctx));
    rpc.handle("disableNotifications", (params, ctx) => this.disableNotifications(params, ctx));
  }
}
