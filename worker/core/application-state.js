// The single authoritative state layer (per the architecture brief:
// "ApplicationState { spawns, raids, fieldResearch, users, pushSubscriptions,
// processedEvents, workerMetadata }"). Connectors and services never touch
// storage/indexeddb.js directly - they call state.spawns.upsert(...) etc.
// here, which is the only place that decides "is this actually new/changed"
// and emits the *.created/*.updated/*.expired events everything else
// (Nostr publishing, notifications) reacts to.
import { openStorage } from "../storage/indexeddb.js";

/**
 * One authoritative collection of expiring entities (spawns, raids, field
 * research). `expiryField` is the ISO-timestamp property name that decides
 * visibility (despawnAt / endsAt / expiresAt) - mirrors
 * cusucomap-viewer's src/nostr-contract.ts's isSpawnVisible/isQuestVisible/isRaidVisible,
 * just evaluated server-side (worker-side) instead of per-viewer.
 */
class EntityStore {
  #collection;
  #bus;
  #kindLabel;
  #expiryField;

  constructor(collection, bus, kindLabel, expiryField) {
    this.#collection = collection;
    this.#bus = bus;
    this.#kindLabel = kindLabel;
    this.#expiryField = expiryField;
  }

  async get(id) {
    return this.#collection.get(id);
  }

  async all() {
    return this.#collection.getAll();
  }

  /** Entities with status "active" and not yet past their expiry field. */
  async active(now = new Date()) {
    const all = await this.#collection.getAll();
    return all.filter((e) => e.status === "active" && new Date(e[this.#expiryField]).getTime() > now.getTime());
  }

  /**
   * Inserts or replaces an entity by id, and emits exactly one event
   * describing what happened - "created" (new id), "updated" (existing id,
   * content actually differs), or nothing at all (byte-identical resend,
   * e.g. the same Source Feed message rescanned). Callers (pokemon-state.js)
   * decide what "differs" means before calling this, since a despawn timer
   * ticking down one message-scrape to the next isn't a meaningful change;
   * this method itself only does the identical-JSON short circuit.
   * @returns {"created"|"updated"|"unchanged"}
   */
  async upsert(entity) {
    const previous = await this.#collection.get(entity.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(entity)) return "unchanged";
    await this.#collection.put(entity);
    const kind = previous ? "updated" : "created";
    this.#bus.emit(`${this.#kindLabel}.${kind}`, { entity, previous: previous ?? null });
    return kind;
  }

  /**
   * Sweeps every entity whose expiry has passed and is still marked
   * "active", flips it to "expired", persists, and emits one
   * `${kind}.expired` event per entity. Callers should schedule this on an
   * interval (see worker-app.js) - expiry is a state transition the worker
   * itself must decide, not something inferred solely from absence.
   */
  async sweepExpired(now = new Date()) {
    const all = await this.#collection.getAll();
    let count = 0;
    for (const entity of all) {
      if (entity.status !== "active") continue;
      if (new Date(entity[this.#expiryField]).getTime() > now.getTime()) continue;
      const expired = { ...entity, status: "expired" };
      await this.#collection.put(expired);
      this.#bus.emit(`${this.#kindLabel}.expired`, { entity: expired });
      count++;
    }
    return count;
  }

  /**
   * Actually deletes (not just status-flips - see sweepExpired above) every
   * entity whose expiry passed more than `maxAgeMs` ago, regardless of its
   * current status - a defensive floor rather than "only ever delete
   * already-'expired' rows", in case sweepExpired somehow hasn't run yet for
   * one. This is what keeps the database from growing forever (see
   * PokemonStateService's own daily retention trim) - deleting the local
   * row doesn't retroactively unpublish anything: whatever this entity's
   * state was at expiry is already what every subscriber's own relay/viewer
   * last saw, per PROTOCOL.md's "reconstruct from the newest event per d"
   * model, so removing it here has no effect on anyone else.
   * @returns {number} how many were deleted
   */
  async pruneOlderThan(maxAgeMs, now = new Date()) {
    const all = await this.#collection.getAll();
    const cutoff = now.getTime() - maxAgeMs;
    const stale = all.filter((e) => new Date(e[this.#expiryField]).getTime() < cutoff);
    await Promise.all(stale.map((e) => this.#collection.delete(e.id)));
    return stale.length;
  }
}

class UserStore {
  #collection;
  constructor(collection) {
    this.#collection = collection;
  }
  async get(userId) {
    return this.#collection.get(userId);
  }
  async all() {
    return this.#collection.getAll();
  }
  async put(user) {
    return this.#collection.put(user);
  }
  /** Finds an application user by external identity (e.g. {provider:"google", subject:"..."}). */
  async findByIdentity(provider, subject) {
    const users = await this.#collection.getAll();
    return users.find((u) => u.identities?.some((i) => i.provider === provider && i.subject === subject)) ?? null;
  }
}

class PushSubscriptionStore {
  #collection;
  constructor(collection) {
    this.#collection = collection;
  }
  // Keyed by the device's own Nostr pubkey, not its Web Push endpoint - see
  // shared/notifications.md section 4.
  async get(nostrPubkey) {
    return this.#collection.get(nostrPubkey);
  }
  async put(subscription) {
    return this.#collection.put(subscription);
  }
  async delete(nostrPubkey) {
    return this.#collection.delete(nostrPubkey);
  }
  async all() {
    return this.#collection.getAll();
  }
  async byUser(userId) {
    return this.#collection.getAllByIndex("byUser", userId);
  }
}

/**
 * The "cusuco" scan-subscription ledger (see worker/storage/indexeddb.js's
 * own comment on why this is its own store, never merged into
 * PushSubscriptionStore). Rows: { pubkeyHex, activeUntil: ISOString, note?:
 * string, scansUsedToday?: number, scansUsedDate?: "YYYY-MM-DD" }. Never
 * auto-deletes anything - an operator's explicit `remove` (see
 * worker-app.js's removeScanSubscriber) is the only way a row disappears.
 */
class ScanSubscriberStore {
  #collection;
  constructor(collection) {
    this.#collection = collection;
  }
  async get(pubkeyHex) {
    return this.#collection.get(pubkeyHex);
  }
  async put(subscriber) {
    return this.#collection.put(subscriber);
  }
  async delete(pubkeyHex) {
    return this.#collection.delete(pubkeyHex);
  }
  async all() {
    return this.#collection.getAll();
  }
}

/**
 * Pending (not-yet-public) scan results - see worker-app.js's
 * runAreaScan/getScanResults/approveScanResults and
 * worker/storage/indexeddb.js's own comment. Rows: { scanId, scanType,
 * requestedByPubkeyHex, createdAt, status: "collecting"|"pending"|
 * "broadcast", spawns: object[] }.
 */
class PendingScanPoolStore {
  #collection;
  constructor(collection) {
    this.#collection = collection;
  }
  async get(scanId) {
    return this.#collection.get(scanId);
  }
  async put(pool) {
    return this.#collection.put(pool);
  }
  async delete(scanId) {
    return this.#collection.delete(scanId);
  }
  async all() {
    return this.#collection.getAll();
  }
  /** Read-modify-write: appends one spawn to a still-collecting pool. No-op if the pool doesn't exist (e.g. it was somehow discarded mid-scan). */
  async appendSpawn(scanId, spawn) {
    const pool = await this.#collection.get(scanId);
    if (!pool) return;
    await this.#collection.put({ ...pool, spawns: [...pool.spawns, spawn] });
  }
}

class ProcessedEventStore {
  #collection;
  constructor(collection) {
    this.#collection = collection;
  }
  async has(eventId) {
    return Boolean(await this.#collection.get(eventId));
  }
  async mark(eventId) {
    return this.#collection.put({ eventId, at: Date.now() });
  }
  /** Deletes entries older than `maxAgeMs` - dedup only needs to cover the reconnect/retry window, not forever. */
  async prune(maxAgeMs) {
    const all = await this.#collection.getAll();
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(all.filter((e) => e.at < cutoff).map((e) => this.#collection.delete(e.eventId)));
  }
}

class MetadataStore {
  #collection;
  constructor(collection) {
    this.#collection = collection;
  }
  async get(key, fallback = null) {
    const row = await this.#collection.get(key);
    return row ? row.value : fallback;
  }
  async set(key, value) {
    return this.#collection.put({ key, value });
  }
  /** Atomic-enough for a single tab: read-modify-write a numeric counter. */
  async increment(key, by = 1) {
    const current = await this.get(key, 0);
    const next = current + by;
    await this.set(key, next);
    return next;
  }
}

export function createApplicationState(bus) {
  const storage = openStorage();
  return {
    spawns: new EntityStore(storage.spawns, bus, "spawn", "despawnAt"),
    raids: new EntityStore(storage.raids, bus, "raid", "endsAt"),
    fieldResearch: new EntityStore(storage.fieldResearch, bus, "fieldResearch", "expiresAt"),
    users: new UserStore(storage.users),
    pushSubscriptions: new PushSubscriptionStore(storage.pushSubscriptions),
    processedEvents: new ProcessedEventStore(storage.processedEvents),
    workerMetadata: new MetadataStore(storage.workerMetadata),
    scanSubscribers: new ScanSubscriberStore(storage.scanSubscribers),
    pendingScanPools: new PendingScanPoolStore(storage.pendingScanPools),
  };
}
