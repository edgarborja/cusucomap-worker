// The "Validation -> Dedup -> Authoritative State" stages of the processing
// pipeline. Connectors (Source Feed, miniscord, future ones) only ever emit
// "*.observed" events with normalized-but-untrusted content; this service
// is the single gate deciding what actually becomes authoritative state -
// per the architecture brief, connectors must never publish directly.
import { validateSpawn, validateQuest, validateRaid } from "../../shared/schemas.js";

const SWEEP_INTERVAL_MS = 60_000;

// How long a "failed" pool, or a "pending" pool with no currently-live
// spawns (including a genuine zero-result scan), sticks around before
// #discardStalePendingScanPools deletes it - long enough for the caller to
// poll getScanResults and actually see that status at least once. Confirmed
// live: a zero-result area scan's pool went "collecting" -> "pending"
// correctly, but with an empty spawns array `pool.spawns.some(...)` is
// vacuously false, so without this grace period it was eligible for
// deletion on the very next 60s sweep tick - sometimes before the viewer's
// own poll ever saw "pending" at all, making the scan look like it never
// finished.
const SCAN_POOL_GRACE_MS = 60 * 60_000; // 1 hour

// How long past its own expiry an entity sticks around before actually
// being deleted (not just status-flipped - see sweepExpired vs
// pruneOlderThan in application-state.js) - keeps the local database from
// growing forever. Deliberately independent of any backup/export cadence:
// this data already did its real job the moment it was published live: the
// local copy past this point is only ever an audit trail, not the primary
// distribution path, so there's no need to gate deletion on a backup first
// existing.
const RETENTION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RETENTION_LAST_RUN_KEY = "retentionTrimLastRunDate";

// Local calendar date, matching worker-app.js's own todayKey() (not
// duplicated as a shared helper - it's three lines, and this file has no
// other reason to depend on that one).
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class PokemonStateService {
  #state;
  #bus;
  #logger;

  constructor({ state, bus, logger }) {
    this.#state = state;
    this.#bus = bus;
    this.#logger = logger;
  }

  start() {
    this.#bus.on("spawn.observed", (spawn) => this.#ingest("spawn", spawn, validateSpawn, this.#state.spawns, "despawnAt"));
    this.#bus.on("quest.observed", (quest) => this.#ingest("quest", quest, validateQuest, this.#state.fieldResearch, "expiresAt"));
    this.#bus.on("raid.observed", (raid) => this.#ingest("raid", raid, validateRaid, this.#state.raids, "endsAt"));

    setInterval(async () => {
      const expired = (await this.#state.spawns.sweepExpired()) + (await this.#state.raids.sweepExpired()) + (await this.#state.fieldResearch.sweepExpired());
      if (expired > 0) this.#logger.info("pokemon-state", `expired ${expired} entities`);
      await this.#runRetentionTrimIfDue();
      await this.#discardStalePendingScanPools();
    }, SWEEP_INTERVAL_MS);
  }

  /**
   * Discards a still-unapproved, *finished* scan pool (see worker-app.js's
   * runAreaScan/getScanResults/approveScanResults) once every spawn it
   * holds has despawned - at that point it's no more useful than an empty
   * one. Checked on this same 60s tick rather than the once-daily retention
   * trim, since a pool's own relevance window is minutes, not a day.
   * Deliberately skips "collecting": that pool is still owned by an
   * in-flight runAreaScan/runSpeciesScan call (an empty spawns array there
   * would otherwise look "all despawned" and get deleted out from under a
   * scan that's still running), and skips "broadcast": that pool is kept as
   * a record, same as an approved scan's spawns already are in
   * state.spawns itself.
   *
   * A "failed" pool (see runSubscriberScan) never holds any spawns at all,
   * and a "pending" pool from a genuine zero-result scan starts out the
   * same way - "every spawn has despawned" is vacuously immediate for
   * both, so both are instead held to SCAN_POOL_GRACE_MS from creation
   * first, regardless of their spawns, before "no still-live spawns" is
   * even considered.
   */
  async #discardStalePendingScanPools() {
    const pools = await this.#state.pendingScanPools.all();
    const now = Date.now();
    let discarded = 0;
    for (const pool of pools) {
      if (pool.status !== "failed" && pool.status !== "pending") continue;
      if (now - pool.createdAt < SCAN_POOL_GRACE_MS) continue;
      if (pool.status === "pending") {
        const stillLive = pool.spawns.some((s) => new Date(s.despawnAt).getTime() > now);
        if (stillLive) continue;
      }
      await this.#state.pendingScanPools.delete(pool.scanId);
      discarded++;
    }
    if (discarded > 0) this.#logger.info("pokemon-state", `discarded ${discarded} stale pending scan pool(s)`);
  }

  /**
   * Once per calendar day (checked on this same 60s tick, not a separate
   * timer - a missed midnight tick just means it runs on the next one),
   * actually deletes spawns/raids/field research whose expiry passed more
   * than RETENTION_MAX_AGE_MS ago. Never touches scanSubscribers,
   * pushSubscriptions, workerMetadata, or pendingScanPools - those aren't
   * despawning entities and have their own separate lifecycle rules.
   */
  async #runRetentionTrimIfDue() {
    const today = todayKey();
    if ((await this.#state.workerMetadata.get(RETENTION_LAST_RUN_KEY, null)) === today) return;
    await this.#state.workerMetadata.set(RETENTION_LAST_RUN_KEY, today);
    const removed =
      (await this.#state.spawns.pruneOlderThan(RETENTION_MAX_AGE_MS)) +
      (await this.#state.raids.pruneOlderThan(RETENTION_MAX_AGE_MS)) +
      (await this.#state.fieldResearch.pruneOlderThan(RETENTION_MAX_AGE_MS));
    if (removed > 0) this.#logger.info("pokemon-state", `daily retention trim: removed ${removed} entities expired 2h+ ago`);
  }

  /**
   * Force-expires every currently active field research (quest) entity -
   * exposed via the dashboard's "Expire all field research" button, for the
   * operator to clear out the previous day's quests before scanning fresh
   * ones. Not a local-only status flip: sweepExpired() alone wouldn't make
   * anything disappear for viewers, since visibility is governed by the
   * *published* event's own content.status and expiration tag (see
   * PROTOCOL.md), not by anything the worker decides afterward - this
   * republishes each quest instead, which is what wireNostrPublishing's
   * fieldResearch.updated listener (worker-app.js) actually reacts to.
   *
   * expiresAt is set a short buffer into the future, not to "now" exactly -
   * PROTOCOL.md's expiration tag follows NIP-40, and a relay may reject a
   * publish whose expiration has *already* passed by the time it's
   * received (see #ingest's own comment on the same risk). status is set
   * to "expired" immediately regardless, which is what actually makes a
   * viewer stop showing it right away rather than waiting out that buffer.
   * @returns {number} how many were expired
   */
  async expireAllFieldResearchNow() {
    const EXPIRY_BUFFER_MS = 30_000;
    const active = await this.#state.fieldResearch.active();
    const expiresAt = new Date(Date.now() + EXPIRY_BUFFER_MS).toISOString();
    for (const quest of active) {
      await this.#state.fieldResearch.upsert({ ...quest, status: "expired", expiresAt });
    }
    if (active.length > 0) this.#logger.info("pokemon-state", `force-expired ${active.length} field research entities`);
    return active.length;
  }

  async #ingest(label, entity, validate, store, expiryField) {
    const errors = validate(entity);
    if (errors.length > 0) {
      this.#logger.warn("pokemon-state", `rejected malformed ${label} (${errors.join("; ")}): ${JSON.stringify(entity).slice(0, 200)}`);
      await this.#state.workerMetadata.increment("validationErrors");
      return;
    }
    // A connector can hand over an entity whose own despawn/ends/expires
    // time has already passed by the time it reaches the worker (a slow
    // reply, a backlog rescan, clock drift). Storing that as "active" just
    // to have the next sweepExpired() (or, worse, a relay's own NIP-40
    // expiration check rejecting the publish with "invalid: event
    // expired") immediately discard it again serves nobody - skip it here
    // instead, before it ever becomes state.
    if (new Date(entity[expiryField]).getTime() <= Date.now()) {
      this.#logger.info("pokemon-state", `skipped already-expired ${label} (${expiryField} ${entity[expiryField]}): ${entity.species ?? entity.rewardName ?? entity.bossSpecies ?? "?"}`);
      return;
    }
    const outcome = await store.upsert(entity);
    if (outcome !== "unchanged") await this.#state.workerMetadata.increment("eventsProcessed");
  }
}
