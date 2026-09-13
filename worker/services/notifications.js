// Decides who gets a push notification and sends it, and owns the
// device-side registration/preferences state behind that decision.
// Preference matching: IV alert OR species alert OR any alerted type OR any
// alerted badge (zeroIv/maxLevel/highCp/xxl/dulceXl - mirrors the viewer's
// own spawn detail badges), one notification even if several match -
// evaluated against IndexedDB
// subscriptions, sent via services/push-sender.js (Web Push) or
// services/fcm-sender.js (FCM), both through the same PushTransport
// bridge, instead of the `web-push`/`firebase-admin` npm packages.
// Registration state arrives as KIND_DEVICE_NOTIFY_CONFIG (addressable,
// NIP-44 encrypted, published by the device) rather than an RPC call - see
// shared/notifications.md section 1 for why the ephemeral RPC kinds can't
// satisfy "recover state after reconnecting."
//
// Two independent delivery channels, one per stored row's `type`: a
// browser/PWA device registers `webpush` (unchanged since this was Web
// Push-only); the Android wrapper app (Capacitor WebView, which can't use
// the Push API at all) registers `fcm` instead. Both are additive and
// fully independent - see shared/notifications.md's FCM section for why
// they're never merged into one "target" per user: each device already
// gets its own row keyed by its own Nostr pubkey, so a phone with the
// native app and a desktop browser for the same person are already two
// separate rows before FCM ever entered the picture. A missing/failed
// channel never blocks the other from sending.
import { createWebPushRequest } from "./push-sender.js";
import { sendFcmMessage } from "./fcm-sender.js";
import { KIND_DEVICE_NOTIFY_CONFIG } from "../../shared/nostr-protocol.js";

function normalize(text) {
  return String(text).trim().toLowerCase();
}

// A 100% IV alert that arrives with almost no time left on the clock isn't
// actionable - the device's owner can't reasonably get there before it
// despawns. Gates the whole notification pass per spawn (not per
// subscription/preference), since despawn timing is a property of the
// spawn itself.
const MIN_REMAINING_MS_TO_NOTIFY = 5 * 60_000;

/** "2:34pm" - lowercase, no leading zero on the hour, no space before am/pm. */
function formatDespawnTime(despawnAtIso) {
  const d = new Date(despawnAtIso);
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const period = d.getHours() >= 12 ? "pm" : "am";
  const hour = d.getHours() % 12 || 12;
  return `${hour}:${minutes}${period}`;
}

// Mirrors cusucomap-viewer's src/cusuco-sidebar.ts's NOTE_BADGE_DEFS_ES
// exactly - these are the same five badges the viewer's own spawn detail
// pane already computes from a spawn's own fields, just evaluated
// worker-side against `preferences.badges` instead of always-on. Keyed by
// the same recognized-value strings a device sends in that array; an
// unrecognized string in `preferences.badges` (typo, future viewer-side
// addition not yet mirrored here) is simply never matched, not an error -
// matching this file's existing tolerance for species/types.
const BADGE_MATCHERS = {
  zeroIv: (spawn) => spawn.ivPercent === 0,
  maxLevel: (spawn) => spawn.level === 35,
  highCp: (spawn) => spawn.cp !== null && spawn.cp >= 2500,
  xxl: (spawn) => spawn.sizeTag === "XXL",
  dulceXl: (spawn) => spawn.level !== null && spawn.level >= 31 && spawn.level <= 34,
};

/**
 * True if `preferences` should fire for `spawn`. `preferences.ivPerfect`
 * defaults to true (unset, not `false`) - V1 behavior is "every enabled
 * device gets notified on a 100% IV spawn" regardless of species/type/badge
 * configuration (see shared/notifications.md section 3); an explicit
 * `false` is how a device opts out of just that category. `species`/
 * `types`/`badges` are independent categories, ORed together - any one
 * match is enough. Exported for unit testing.
 * @param {object} preferences
 * @param {{species: string, types: string[], ivPercent: number|null, level: number|null, cp: number|null, sizeTag: string|null}} spawn
 */
export function matchesSpawnAlert(preferences, spawn) {
  const speciesSet = new Set((preferences.species ?? []).map(normalize));
  const typeSet = new Set((preferences.types ?? []).map(normalize));
  const matchedTypes = (spawn.types ?? []).filter((t) => typeSet.has(normalize(t)));
  const ivMatch = preferences.ivPerfect !== false && spawn.ivPercent === 100;
  const badgeSet = new Set(preferences.badges ?? []);
  const matchedBadges = Object.keys(BADGE_MATCHERS).filter((badge) => badgeSet.has(badge) && BADGE_MATCHERS[badge](spawn));
  return {
    isMatch: ivMatch || speciesSet.has(normalize(spawn.species)) || matchedTypes.length > 0 || matchedBadges.length > 0,
    matchedTypes,
    matchedBadges,
    ivMatch,
  };
}

export class NotificationsService {
  #state;
  #bus;
  #transport;
  #pushTransport;
  #getVapidConfig;
  #getFcmConfig;
  #logger;

  /**
   * @param {object} deps
   * @param {import("../transports/nostr-transport.js").NostrTransport} deps.transport
   *   Used to subscribe for KIND_DEVICE_NOTIFY_CONFIG - the Nostr side, not
   *   pushTransport (which only sends the already-built HTTP request, Web
   *   Push or FCM).
   * @param {() => { vapidPublicKey: string, vapidPrivateKey: string, contact: string } | null} deps.getVapidConfig
   *   Lazy accessor (not a captured value) so a config change/Start Worker
   *   after construction is picked up without re-wiring this service.
   * @param {() => { project_id: string, client_email: string, private_key: string } | null} deps.getFcmConfig
   *   Same lazy-accessor shape as getVapidConfig, for the parsed Firebase
   *   service-account JSON (see core/config.js's SecretConfig).
   */
  constructor({ state, bus, transport, pushTransport, getVapidConfig, getFcmConfig, logger }) {
    this.#state = state;
    this.#bus = bus;
    this.#transport = transport;
    this.#pushTransport = pushTransport;
    this.#getVapidConfig = getVapidConfig;
    this.#getFcmConfig = getFcmConfig;
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
    const fcmConfig = this.#getFcmConfig();
    if (!vapid && !fcmConfig) {
      // Was a silent no-op before - made noisy on purpose: both are stored
      // in SecretConfig, which is memory-only unless "remember secrets" is
      // checked, so either can silently go blank on a reload that only
      // re-entered the NSEC. Without this log there was no way to tell
      // "nothing matched" apart from "nothing was ever configured to send."
      this.#logger.warn("push", `skipped notification check for spawn ${spawn.species} (${spawn.ivPercent ?? "?"}% IV) - neither Web Push (VAPID) nor FCM configured`);
      return;
    }

    const remainingMs = new Date(spawn.despawnAt).getTime() - Date.now();
    if (remainingMs <= MIN_REMAINING_MS_TO_NOTIFY) {
      this.#logger.info(
        "push",
        `skipped notification check for spawn ${spawn.species} (${spawn.ivPercent ?? "?"}% IV) - only ${Math.max(0, Math.round(remainingMs / 60_000))} min left before despawn`
      );
      return;
    }

    const subscriptions = await this.#state.pushSubscriptions.all();
    let sent = 0;
    let failed = 0;
    for (const sub of subscriptions) {
      const { isMatch } = matchesSpawnAlert(sub.preferences ?? {}, spawn);
      if (!isMatch) continue;
      // Spanish, matching the rest of the app's user-facing text (see
      // CLAUDE.md/cusucomap-viewer's TEAM_LABELS_ES etc.).
      const outcome = await this.#send(sub, vapid, fcmConfig, {
        title: `${spawn.species} ${spawn.ivPercent ?? "?"}% IV`,
        body: `${spawn.cp ?? "?"} CP, Hasta las ${formatDespawnTime(spawn.despawnAt)}`,
        // Per-notification large icon (right-side image on Android) - the
        // species' own sprite instead of a static app icon. sw.js falls
        // back to the app icon if this is missing/fails to load.
        icon: spawn.spriteUrl ?? null,
        // Read by sw.js: tag dedupes a re-notification for the same spawn
        // (replaces instead of stacking), url deep-links into the viewer -
        // format confirmed against the viewer's actual query param.
        tag: String(spawn.id),
        url: `https://cusucomap.com/?spawn=${spawn.id}`,
        entityType: "spawn",
        entityId: spawn.id,
      });
      if (outcome === "sent") sent++;
      else if (outcome === "failed") failed++;
    }

    // One line per spawn that actually matched something, not one per
    // notification sent - a busy spawn with many matching devices would
    // otherwise flood the activity log.
    if (sent + failed > 0) {
      this.#logger.info(
        "push",
        `spawn ${spawn.species} (${spawn.ivPercent ?? "?"}% IV) matched ${sent + failed}/${subscriptions.length} subscriptions - sent ${sent}${failed > 0 ? `, ${failed} failed` : ""}`
      );
    }
  }

  /**
   * Dispatches by the stored row's channel - each channel's own send path
   * is fully independent (own try/catch, own cleanup-on-invalid), so a
   * failure or misconfiguration on one can never block or roll back the
   * other. `type` defaults to "webpush" (see #handleDeviceConfig) so an
   * old row from before this field existed is never misrouted.
   * @returns {Promise<"sent"|"removed"|"failed"|"skipped">}
   */
  async #send(subscription, vapid, fcmConfig, payload) {
    if (subscription.type === "fcm") return this.#sendFcm(subscription, fcmConfig, payload);
    return this.#sendWebPush(subscription, vapid, payload);
  }

  /** Untouched from before FCM existed, apart from the log-message prefixes - see push-sender.js. */
  async #sendWebPush(subscription, vapid, payload) {
    if (!vapid) {
      this.#logger.warn("push", `skipped Web Push to device ${subscription.nostrPubkey.slice(0, 8)}… - VAPID not configured`);
      return "skipped";
    }
    try {
      const request = await createWebPushRequest(subscription, payload, vapid);
      const result = await this.#pushTransport.send(request);
      if (result.ok) {
        await this.#state.workerMetadata.increment("pushesSent");
        return "sent";
      }
      if (result.status === 404 || result.status === 410) {
        // Permanently invalid endpoint (browser uninstalled/subscription
        // expired, or the browser rotated it without the device managing to
        // publish an updated KIND_DEVICE_NOTIFY_CONFIG yet) - per the
        // reliability brief, remove rather than retry. Keyed by the
        // device's own pubkey, not the now-dead endpoint (see
        // shared/notifications.md section 4) - this is also how a device
        // that vanished (site data cleared, no way to tell the worker
        // directly) eventually gets cleaned up, per that section's addendum.
        await this.#state.pushSubscriptions.delete(subscription.nostrPubkey);
        this.#logger.info("push", `removed invalid Web Push subscription (HTTP ${result.status}): ${subscription.endpoint.slice(0, 60)}…`);
        return "removed";
      }
      await this.#state.workerMetadata.increment("pushErrors");
      this.#logger.warn("push", `Web Push send failed (${result.status ?? result.error}): ${subscription.endpoint.slice(0, 60)}…`);
      return "failed";
    } catch (err) {
      await this.#state.workerMetadata.increment("pushErrors");
      this.#logger.error("push", `Web Push send threw: ${err.message}`);
      return "failed";
    }
  }

  /** Same shape/outcomes as #sendWebPush, via fcm-sender.js instead - see that file for why it needs the transport injected rather than building a request the caller sends. */
  async #sendFcm(subscription, fcmConfig, payload) {
    if (!fcmConfig) {
      this.#logger.warn("push", `skipped FCM send to device ${subscription.nostrPubkey.slice(0, 8)}… - FCM service account not configured`);
      return "skipped";
    }
    try {
      const result = await sendFcmMessage(fcmConfig, subscription.token, payload, (request) => this.#pushTransport.send(request));
      if (result.ok) {
        await this.#state.workerMetadata.increment("pushesSent");
        return "sent";
      }
      if (result.invalidToken) {
        await this.#state.pushSubscriptions.delete(subscription.nostrPubkey);
        this.#logger.info("push", `removed invalid FCM token (HTTP ${result.status}): ${subscription.token.slice(0, 20)}…`);
        return "removed";
      }
      await this.#state.workerMetadata.increment("pushErrors");
      this.#logger.warn("push", `FCM send failed (${result.status ?? result.error}): ${subscription.token.slice(0, 20)}…`);
      return "failed";
    } catch (err) {
      await this.#state.workerMetadata.increment("pushErrors");
      this.#logger.error("push", `FCM send threw: ${err.message}`);
      return "failed";
    }
  }

  /**
   * Handles one decrypted KIND_DEVICE_NOTIFY_CONFIG event - a device's full
   * current notification state (see shared/notifications.md section 1 for
   * the wire shape, and its FCM section for the `type`/`token` addition).
   * `fromPubkey` is the device's identity; its signature on this event
   * (already verified before this method runs - see
   * NostrTransport#subscribeEncrypted) is the only authentication needed,
   * so a device can only ever update its own row.
   *
   * `type` discriminates the two storage shapes below: "webpush" (the
   * original, unchanged shape - `endpoint`/`keys`) or "fcm" (`token`
   * instead). Missing/anything-other-than-"fcm" defaults to "webpush" -
   * every row published before this field existed, and any future typo,
   * both fall back to the behavior this device already had.
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

    const type = data.type === "fcm" ? "fcm" : "webpush";
    const user = await this.#state.users.findByIdentity("nostr", fromPubkey);
    const common = {
      nostrPubkey: fromPubkey,
      type,
      userId: user?.userId ?? null,
      preferences: {
        ivPerfect: data.preferences?.ivPerfect !== false,
        species: data.preferences?.species ?? [],
        types: data.preferences?.types ?? [],
        badges: data.preferences?.badges ?? [],
      },
      updatedAt: Date.now(),
      sourceCreatedAt: createdAt,
    };

    if (type === "fcm") {
      if (typeof data.token !== "string" || data.token.trim() === "") {
        this.#logger.warn("push", `dropped fcm device config from ${fromPubkey.slice(0, 8)}… - invalid/missing token`);
        return;
      }
      await this.#state.pushSubscriptions.put({ ...common, token: data.token });
      return;
    }

    const { subscription } = data;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      this.#logger.warn("push", `dropped device config from ${fromPubkey.slice(0, 8)}… - invalid subscription shape`);
      return;
    }
    await this.#state.pushSubscriptions.put({ ...common, endpoint: subscription.endpoint, keys: subscription.keys });
  }
}
