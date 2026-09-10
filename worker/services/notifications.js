// Decides who gets a Web Push notification and sends it, and owns the
// device-side registration/preferences state behind that decision.
// Preference matching: IV alert OR species alert OR any alerted type, one
// notification even if several match - evaluated against IndexedDB
// subscriptions, sent via services/push-sender.js + a PushTransport
// instead of the `web-push` npm package. Registration state arrives as
// KIND_DEVICE_NOTIFY_CONFIG (addressable, NIP-44 encrypted, published by
// the device) rather than an RPC call - see shared/notifications.md
// section 1 for why the ephemeral RPC kinds can't satisfy "recover state
// after reconnecting."
import { createWebPushRequest } from "./push-sender.js";
import { KIND_DEVICE_NOTIFY_CONFIG } from "../../shared/nostr-protocol.js";

function normalize(text) {
  return String(text).trim().toLowerCase();
}

/**
 * True if `preferences` should fire for a spawn with this species/types/IV.
 * `preferences.ivPerfect` defaults to true (unset, not `false`) - V1
 * behavior is "every enabled device gets notified on a 100% IV spawn"
 * regardless of species/type configuration (see shared/notifications.md
 * section 3); an explicit `false` is how a device opts out of just that
 * category once more preference categories exist. Exported for unit
 * testing.
 */
export function matchesSpawnAlert(preferences, species, types, ivPercent) {
  const speciesSet = new Set((preferences.species ?? []).map(normalize));
  const typeSet = new Set((preferences.types ?? []).map(normalize));
  const matchedTypes = (types ?? []).filter((t) => typeSet.has(normalize(t)));
  const ivMatch = preferences.ivPerfect !== false && ivPercent === 100;
  return { isMatch: ivMatch || speciesSet.has(normalize(species)) || matchedTypes.length > 0, matchedTypes, ivMatch };
}

export class NotificationsService {
  #state;
  #bus;
  #transport;
  #pushTransport;
  #getVapidConfig;
  #logger;

  /**
   * @param {object} deps
   * @param {import("../transports/nostr-transport.js").NostrTransport} deps.transport
   *   Used to subscribe for KIND_DEVICE_NOTIFY_CONFIG - the Nostr side, not
   *   pushTransport (which only sends the already-built Web Push HTTP
   *   request).
   * @param {() => { vapidPublicKey: string, vapidPrivateKey: string, contact: string } | null} deps.getVapidConfig
   *   Lazy accessor (not a captured value) so a config change/Start Worker
   *   after construction is picked up without re-wiring this service.
   */
  constructor({ state, bus, transport, pushTransport, getVapidConfig, logger }) {
    this.#state = state;
    this.#bus = bus;
    this.#transport = transport;
    this.#pushTransport = pushTransport;
    this.#getVapidConfig = getVapidConfig;
    this.#logger = logger;
  }

  start() {
    this.#bus.on("spawn.created", ({ entity }) => this.#notifySpawn(entity));
    this.#transport.subscribeEncrypted(KIND_DEVICE_NOTIFY_CONFIG, (msg) =>
      this.#handleDeviceConfig(msg).catch((err) => this.#logger.error("push", `device config handling threw: ${err.message}`))
    );
  }

  async #notifySpawn(spawn) {
    const vapid = this.#getVapidConfig();
    if (!vapid) return; // Web Push not configured - silently skip, dashboard already shows VAPID as not-ready

    const subscriptions = await this.#state.pushSubscriptions.all();
    for (const sub of subscriptions) {
      const { isMatch, matchedTypes } = matchesSpawnAlert(sub.preferences ?? {}, spawn.species, spawn.types ?? [], spawn.ivPercent);
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
        // expired, or the browser rotated it without the device managing to
        // publish an updated KIND_DEVICE_NOTIFY_CONFIG yet) - per the
        // reliability brief, remove rather than retry. Keyed by the
        // device's own pubkey, not the now-dead endpoint (see
        // shared/notifications.md section 4) - this is also how a device
        // that vanished (site data cleared, no way to tell the worker
        // directly) eventually gets cleaned up, per that section's addendum.
        await this.#state.pushSubscriptions.delete(subscription.nostrPubkey);
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

  /**
   * Handles one decrypted KIND_DEVICE_NOTIFY_CONFIG event - a device's full
   * current notification state (see shared/notifications.md section 1 for
   * the wire shape). `fromPubkey` is the device's identity; its signature
   * on this event (already verified before this method runs - see
   * NostrTransport#subscribeEncrypted) is the only authentication needed,
   * so a device can only ever update its own row.
   */
  async #handleDeviceConfig({ fromPubkey, createdAt, data }) {
    if (!data || typeof data !== "object") {
      this.#logger.warn("push", `dropped malformed device config from ${fromPubkey.slice(0, 8)}…`);
      return;
    }

    // NIP-33 "latest wins": a relay should only ever hand us the newest
    // event per (kind, pubkey, d), but not every relay is perfectly
    // compliant and a subscription spanning several relays can otherwise
    // race - compare against what's already stored so an older duplicate
    // can't undo a newer change.
    const existing = await this.#state.pushSubscriptions.get(fromPubkey);
    if (existing && createdAt <= existing.sourceCreatedAt) {
      this.#logger.warn("push", `ignored stale/replayed device config from ${fromPubkey.slice(0, 8)}…`);
      return;
    }

    if (!data.enabled) {
      await this.#state.pushSubscriptions.delete(fromPubkey);
      return;
    }

    const { subscription, preferences } = data;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      this.#logger.warn("push", `dropped device config from ${fromPubkey.slice(0, 8)}… - invalid subscription shape`);
      return;
    }

    const user = await this.#state.users.findByIdentity("nostr", fromPubkey);
    await this.#state.pushSubscriptions.put({
      nostrPubkey: fromPubkey,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userId: user?.userId ?? null,
      preferences: {
        ivPerfect: preferences?.ivPerfect !== false,
        species: preferences?.species ?? [],
        types: preferences?.types ?? [],
      },
      updatedAt: Date.now(),
      sourceCreatedAt: createdAt,
    });
  }
}
