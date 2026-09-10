// Thin promise wrapper around IndexedDB plus this worker's store/migration
// definitions. Business logic (worker/core/application-state.js and
// everything above it) never touches `indexedDB` directly - it only calls
// the Collection methods this module returns, so the persistence mechanism
// could be swapped later without touching services/connectors.

const DB_NAME = "cusucomap-worker";
const DB_VERSION = 2;

/** @type {Record<string, { keyPath: string, indexes?: [string, string, IDBIndexParameters?][] }>} */
const STORE_DEFS = {
  spawns: { keyPath: "id" },
  raids: { keyPath: "id" },
  fieldResearch: { keyPath: "id" },
  users: { keyPath: "userId" },
  // Keyed by the device's own Nostr pubkey, not its Web Push endpoint - an
  // endpoint can rotate (browser replaces the PushSubscription) but the
  // device identity doesn't, so a new KIND_DEVICE_NOTIFY_CONFIG event from
  // the same device replaces its one row instead of leaving an orphaned
  // row under the old endpoint. See shared/notifications.md section 4.
  pushSubscriptions: { keyPath: "nostrPubkey", indexes: [["byUser", "userId", { unique: false }], ["byEndpoint", "endpoint", { unique: false }]] },
  // Dedup guard for inbound Nostr RPC requests (replay protection) - see
  // worker/transports/rpc.js. Pruned on a timer, not kept forever.
  processedEvents: { keyPath: "eventId" },
  // Single-row-per-key bag for small worker-wide facts (last snapshot
  // publish time, counters survived across reload, etc).
  workerMetadata: { keyPath: "key" },
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // v1 -> v2: pushSubscriptions moved from keyPath "endpoint" to
      // "nostrPubkey" (see STORE_DEFS above). No live data ever existed
      // under the old shape - nothing wrote to this store before this
      // version (see shared/notifications.md) - so drop-and-recreate is
      // safe; a real migration would copy rows across instead.
      if (event.oldVersion < 2 && db.objectStoreNames.contains("pushSubscriptions")) {
        db.deleteObjectStore("pushSubscriptions");
      }
      for (const [name, def] of Object.entries(STORE_DEFS)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [indexName, keyPath, options] of def.indexes ?? []) {
          store.createIndex(indexName, keyPath, options);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class Collection {
  #dbPromise;
  #storeName;

  constructor(dbPromise, storeName) {
    this.#dbPromise = dbPromise;
    this.#storeName = storeName;
  }

  async #store(mode) {
    const db = await this.#dbPromise;
    return db.transaction(this.#storeName, mode).objectStore(this.#storeName);
  }

  async get(key) {
    return reqToPromise((await this.#store("readonly")).get(key));
  }

  async getAll() {
    return reqToPromise((await this.#store("readonly")).getAll());
  }

  async getAllByIndex(indexName, value) {
    const store = await this.#store("readonly");
    return reqToPromise(store.index(indexName).getAll(value));
  }

  async put(value) {
    return reqToPromise((await this.#store("readwrite")).put(value));
  }

  async delete(key) {
    return reqToPromise((await this.#store("readwrite")).delete(key));
  }

  async count() {
    return reqToPromise((await this.#store("readonly")).count());
  }
}

/**
 * Opens (or creates/migrates) the worker's IndexedDB database and returns
 * one Collection per object store. Safe to call once at startup; the
 * underlying connection is shared/lazy behind a single promise.
 */
export function openStorage() {
  const dbPromise = openDb();
  /** @type {Record<keyof typeof STORE_DEFS, Collection>} */
  const collections = {};
  for (const name of Object.keys(STORE_DEFS)) {
    collections[name] = new Collection(dbPromise, name);
  }
  return collections;
}
