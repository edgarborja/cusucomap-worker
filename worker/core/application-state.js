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
  };
}
