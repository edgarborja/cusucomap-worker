// Thin promise wrapper around IndexedDB plus this worker's store/migration
// definitions. Business logic (worker/core/application-state.js and
// everything above it) never touches `indexedDB` directly - it only calls
// the Collection methods this module returns, so the persistence mechanism
// could be swapped later without touching services/connectors.

const DB_NAME = "cusucomap-worker";
const DB_VERSION = 3;

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
  // The operator-maintained ledger of who has an active "cusuco" scan
  // subscription (see commands/commands-app.js's admin panel and
  // worker-app.js's runAreaScan authorization) - deliberately its own store,
  // not a field bolted onto pushSubscriptions above: that collection
  // self-deletes rows under several conditions unrelated to payment (a
  // stale/expired push endpoint, malformed key cleanup), and a paid
  // subscriber's access must never be silently revoked by that unrelated
  // cleanup. Rows here are never auto-deleted - an expired subscription
  // just fails its activeUntil check, kept as a record rather than erased.
  // A row's mere *existence* doesn't mean anything was ever granted:
  // checkScanSubscription (worker-app.js) auto-creates one with
  // activeUntil: null the first time any visitor's pubkey asks about its
  // own subscription status - that's the discovery mechanism that turns
  // "everyone who's opened the map" into a list the operator can grant
  // access from, without anyone needing to hand over their npub separately.
  // Every checkScanSubscription call also stamps lastSeenAt and increments
  // seenCount (firstSeenAt is set once and never touched again) - not yet
  // acted on by anything, but it's what a future cleanup could use to tell
  // a one-time visitor from a repeat one before trimming rows that were
  // never granted access. attributionTag (a CRC16 of the npub - see
  // shared/crc16.js) is also computed once, at that same first-encounter
  // moment, and never recomputed - it's what approveScanResults stamps
  // onto shared spawns as an anonymous-but-consistent "who found this"
  // marker (see PROTOCOL.md's Spawn content), but only as the *default* -
  // the admin panel's own "note" field doubles as a public override when
  // the operator sets one (e.g. a subscriber's real name/alias, at their
  // request); approveScanResults already prefers a non-empty note over
  // attributionTag.
  // dailyLimit (null/absent = use scanDailyLimitPerSubscriber, the
  // fleet-wide default in defaultSearchConfig()) lets the operator grant a
  // specific subscriber more (or fewer) scans/day than everyone else -
  // set via the commands page's admin panel, read by
  // resolveSubscriberDailyLimit (worker-app.js), which both
  // authorizeScanRequest and checkScanSubscription's own cusucosRemaining
  // go through, so the two can never disagree on what the limit actually is.
  scanSubscribers: { keyPath: "pubkeyHex" },
  // A scan's private, not-yet-public results (see worker-app.js's
  // runAreaScan/getScanResults/approveScanResults) - holds whatever spawns
  // were observed while that scan held bulk-scan priority, until the
  // requester either approves (publishes them for real, the normal way) or
  // lets the pool expire once every spawn in it has despawned.
  pendingScanPools: { keyPath: "scanId" },
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

/**
 * Dumps every store's full contents, keyed by store name - for the
 * dashboard's local "Export data" button (see worker/dashboard/dashboard.js).
 * Generic over whatever's in STORE_DEFS, so a store added later is
 * automatically included with no change here. Opens its own short-lived
 * connection rather than reusing the app's long-lived one - this is a rare,
 * one-off action, not something worth threading through the rest of the
 * app's startup wiring.
 * @returns {Promise<Record<string, unknown[]>>}
 */
export async function exportAllData() {
  const collections = openStorage();
  const dump = {};
  for (const [name, collection] of Object.entries(collections)) {
    dump[name] = await collection.getAll();
  }
  return dump;
}
