// The only module that touches nostr-tools/relays directly. Everything else
// (services/pokemon-state.js, transports/rpc.js, the dashboard) calls the
// small API this class exposes - publishEntity/publishWorkerStatus/
// sendEncrypted/subscribeEncrypted - never raw SimplePool subscriptions.
//
// Loaded via a pinned CDN bundle URL/version - a classic <script> tag in
// worker/index.html defines the global `NostrTools`, since this worker has
// no bundler to `import "nostr-tools"` from npm the way cusucomap-viewer's
// Vite build does.
import { RELAYS, buildEntityEventTemplate, buildWorkerConfigEventTemplate, KIND_WORKER_STATUS } from "../../shared/nostr-protocol.js";

function nostrTools() {
  if (!window.NostrTools) {
    throw new Error("NostrTools global not found - check the nostr.bundle.js <script> tag in index.html loaded before worker-app.js.");
  }
  return window.NostrTools;
}

export class NostrTransport {
  #pool;
  #secretKey;
  #logger;
  /** @type {{ hex: string, npub: string } | null} */
  identity = null;
  #relays;
  #lastEventAt = Date.now();
  #reopenRpcSubscription = null;

  constructor({ relays = RELAYS, logger } = {}) {
    this.#relays = relays;
    this.#logger = logger;
  }

  /** @param {string} nsec - nsec1... string. Never stored beyond this call's local `secretKey`. */
  setIdentity(nsec) {
    const NT = nostrTools();
    const decoded = NT.nip19.decode(nsec.trim());
    if (decoded.type !== "nsec") throw new Error("Not a valid nsec key.");
    this.#secretKey = decoded.data;
    const hex = NT.getPublicKey(decoded.data);
    this.identity = { hex, npub: NT.nip19.npubEncode(hex) };
    return this.identity;
  }

  connect() {
    const NT = nostrTools();
    // See cusucomap-viewer's src/nostr-client.ts for why these two are turned on
    // explicitly (both default off in SimplePool) and why the timeout is
    // raised well past the library default - ported reasoning, simplified
    // here since the worker runs on an always-on desktop tab rather than a
    // phone that gets backgrounded/suspended.
    this.#pool = new NT.SimplePool({ enablePing: true, enableReconnect: true });
    this.#pool.maxWaitForConnection = 15_000;
    this.#scheduleHealthCheck();
  }

  // Mirrors cusucomap-viewer's src/nostr-client.ts's healthCheckTick, including its
  // documented bug fix: a recursive setTimeout, not setInterval, so the
  // cadence can relax while presumed healthy and tighten once confirmed
  // stale. #lastEventAt only moves forward when real activity is observed
  // (see #publishTemplate/subscribeEncrypted below) - it is never reset
  // here - so a setInterval version would refire the reconnect on every
  // single tick forever once triggered once, rebuilding the pool every
  // HEALTH_CHECK_INTERVAL_MS indefinitely instead of just until activity
  // resumes.
  #scheduleHealthCheck() {
    const HEALTH_CHECK_INTERVAL_MS = 90_000;
    const STALE_RECHECK_INTERVAL_MS = 20_000;
    const STALE_AFTER_MS = 5 * 60_000;

    const stale = Date.now() - this.#lastEventAt >= STALE_AFTER_MS;
    if (stale) {
      const NT = nostrTools();
      this.#logger?.warn("nostr", "no relay activity for 5+ minutes - forcing reconnect of all relays.");
      this.#pool.close(this.#relays);
      this.#pool = new NT.SimplePool({ enablePing: true, enableReconnect: true });
      this.#pool.maxWaitForConnection = 15_000;
      this.#reopenRpcSubscription?.();
    }
    setTimeout(() => this.#scheduleHealthCheck(), stale ? STALE_RECHECK_INTERVAL_MS : HEALTH_CHECK_INTERVAL_MS);
  }

  /** Best-effort per-relay connection status for the dashboard; not all nostr-tools versions expose this. */
  relayStatus() {
    try {
      const statusMap = this.#pool?.listConnectionStatus?.();
      if (!statusMap) return null;
      // listConnectionStatus()'s keys are relay URLs as SimplePool itself
      // normalized them internally (confirmed live: it adds a trailing
      // slash - "wss://relay.k1.sv" is stored as "wss://relay.k1.sv/").
      // Comparing the operator's raw, unnormalized config string directly
      // against those keys silently misses every entry and always reports
      // disconnected regardless of actual connectivity. NOT using
      // nostr-tools' own `normalizeURL` export for this - confirmed live
      // that the CDN <script> bundle this worker loads doesn't expose it
      // at the top level the way the npm package does, so calling it threw
      // and this whole method silently returned null via the catch below.
      // A bare trailing-slash strip on both sides is enough for the plain
      // relay URLs (no path/query/port quirks) this worker actually deals
      // with, without depending on that missing export at all.
      const stripSlash = (s) => s.replace(/\/$/, "");
      const normalizedStatus = new Map(Array.from(statusMap.entries()).map(([url, connected]) => [stripSlash(url), connected]));
      return this.#relays.map((url) => ({ url, connected: Boolean(normalizedStatus.get(stripSlash(url))) }));
    } catch {
      return null;
    }
  }

  async #publishTemplate(template, label) {
    const NT = nostrTools();
    if (!this.#secretKey) throw new Error("Worker identity not set - call setIdentity(nsec) first.");
    const event = NT.finalizeEvent(template, this.#secretKey);
    const settled = await Promise.allSettled(this.#pool.publish(this.#relays, event));
    const ok = settled.filter((r) => r.status === "fulfilled").length;
    const failed = settled.length - ok;
    // A successful publish ACK proves the relay connection is actually
    // alive and accepting writes - a far more reliable heartbeat than
    // waiting on the encrypted RPC subscription below, since nothing
    // requires a viewer to send an RPC request within any given window.
    // The worker's own 60s publishWorkerStatus loop (see worker-app.js)
    // keeps this fresh on its own even when nothing else is happening.
    if (ok > 0) this.#lastEventAt = Date.now();
    if (ok === 0) {
      // The generic "failed on every relay" message alone gives no way to
      // tell a dead/unreachable socket apart from a relay that connected
      // fine but rejected the event (auth-required, rate-limited,
      // malformed, policy) - surface each relay's actual rejection reason
      // so that distinction doesn't have to be guessed at.
      const reasonTexts = this.#relays.map((url, i) => ({ url, reason: settled[i]?.reason?.message ?? settled[i]?.reason ?? "unknown error" }));
      // NIP-33 "replaced: have newer event" isn't a real failure - it means
      // an equally-or-more-current copy of this same (kind, d) entity is
      // already on the relay, most often because republishAllActive()'s
      // startup resync raced a live re-observation of the same entity from
      // the Source Feed bridge's own backlog rescan and lost. The data on the
      // relay is already correct either way; logging this at error level
      // would just be noise an operator has to learn to ignore.
      const allReplaced = reasonTexts.every(({ reason }) => /replaced:/i.test(reason));
      const line = `${label} - ${reasonTexts.map(({ url, reason }) => `${url}: ${reason}`).join("; ")}`;
      if (allReplaced) this.#logger?.info("nostr", `publish superseded by a newer copy already on the relay: ${line}`);
      else this.#logger?.error("nostr", `publish failed on every relay: ${line}`);
    }
    return { ok, failed, event };
  }

  /** Publishes/replaces one spawn/quest/raid entity (see shared/nostr-protocol.js). */
  async publishEntity(kind, id, expiresAtIso, content, label) {
    return this.#publishTemplate(buildEntityEventTemplate(kind, id, expiresAtIso, content), label ?? `entity ${id}`);
  }

  /**
   * Plaintext, addressable worker-wide public config (currently just the
   * VAPID public key) - see PROTOCOL.md's kind 31505. Deliberately not part
   * of publishWorkerStatus: that republishes every 60s regardless of
   * activity, but this practically never changes, so it's published once
   * at startup instead (see worker-app.js) rather than re-versioned on
   * every status heartbeat.
   */
  async publishWorkerConfig(content) {
    return this.#publishTemplate(buildWorkerConfigEventTemplate(content), "worker config");
  }

  /** Replaceable worker-presence event a viewer/dashboard could read without an RPC round trip. */
  async publishWorkerStatus(status) {
    return this.#publishTemplate(
      {
        kind: KIND_WORKER_STATUS,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["d", "status"]],
        content: JSON.stringify(status),
      },
      "worker status"
    );
  }

  /** Sends a NIP-44 encrypted event of `kind` to `toPubkeyHex`. `plaintextObj` is JSON-stringified before encryption. */
  async sendEncrypted(toPubkeyHex, kind, plaintextObj) {
    const NT = nostrTools();
    if (!NT.nip44) throw new Error("This nostr-tools build has no nip44 module - cannot send an encrypted message.");
    const conversationKey = NT.nip44.v2.utils.getConversationKey(this.#secretKey, toPubkeyHex);
    const ciphertext = NT.nip44.v2.encrypt(JSON.stringify(plaintextObj), conversationKey);
    return this.#publishTemplate(
      { kind, created_at: Math.floor(Date.now() / 1000), tags: [["p", toPubkeyHex]], content: ciphertext },
      `encrypted ${kind} -> ${toPubkeyHex.slice(0, 8)}…`
    );
  }

  /**
   * Subscribes to encrypted events of `kind` addressed to this worker (a `p`
   * tag matching our own pubkey). Calls
   * `onMessage({ fromPubkey, eventId, createdAt, data })` with the decoded
   * plaintext object once decrypted - a message that fails to decrypt
   * (wrong key, malformed) is logged and dropped, never thrown into the
   * caller. `createdAt` (unix seconds, straight from the event) lets a
   * consumer of an addressable kind ignore a stale/replayed copy older than
   * what it already has for that sender - the ephemeral RPC kinds don't
   * need this (they use eventId-based replay protection instead, see
   * transports/rpc.js), but an addressable kind's "latest wins" semantics
   * do.
   */
  subscribeEncrypted(kind, onMessage) {
    const NT = nostrTools();
    if (!this.identity) throw new Error("Worker identity not set.");
    const closer = this.#pool.subscribeMany(
      this.#relays,
      { kinds: [kind], "#p": [this.identity.hex] },
      {
        onevent: (event) => {
          this.#lastEventAt = Date.now();
          try {
            const conversationKey = NT.nip44.v2.utils.getConversationKey(this.#secretKey, event.pubkey);
            const plaintext = NT.nip44.v2.decrypt(event.content, conversationKey);
            onMessage({ fromPubkey: event.pubkey, eventId: event.id, createdAt: event.created_at, data: JSON.parse(plaintext) });
          } catch (err) {
            this.#logger?.warn("nostr", `dropped undecryptable/malformed event ${event.id.slice(0, 8)}: ${err.message}`);
          }
        },
        oneose: () => {
          this.#lastEventAt = Date.now();
        },
      }
    );
    // Remembered so the health-check reconnect loop (see connect() above)
    // can re-establish this subscription against a freshly recreated pool -
    // only one encrypted subscription (RPC) exists per worker today, so a
    // single remembered re-opener is enough.
    this.#reopenRpcSubscription = () => this.subscribeEncrypted(kind, onMessage);
    return closer;
  }
}
