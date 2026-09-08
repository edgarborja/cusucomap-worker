// The "Validation -> Dedup -> Authoritative State" stages of the processing
// pipeline. Connectors (Source Feed, AHK, future ones) only ever emit
// "*.observed" events with normalized-but-untrusted content; this service
// is the single gate deciding what actually becomes authoritative state -
// per the architecture brief, connectors must never publish directly.
import { validateSpawn, validateQuest, validateRaid } from "../../shared/schemas.js";

const SWEEP_INTERVAL_MS = 60_000;

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
    }, SWEEP_INTERVAL_MS);
  }

  async #ingest(label, entity, validate, store, expiryField) {
    const errors = validate(entity);
    if (errors.length > 0) {
      this.#logger.warn("pokemon-state", `rejected malformed ${label} (${errors.join("; ")}): ${JSON.stringify(entity).slice(0, 200)}`);
      await this.#state.workerMetadata.increment("validationErrors");
      return;
    }
    // The Source Feed bridge's initial full-channel scanExistingMessages() (and
    // its periodic rescan) can resurface a message whose own despawn/ends/
    // expires time - computed relative to when it was originally posted -
    // has already passed by the time it reaches the worker now, e.g. a
    // backlog /pokesearch reply saying "(in 5 minutes)" from an hour ago.
    // Storing that as "active" just to have the next sweepExpired() (or,
    // worse, a relay's own NIP-40 expiration check rejecting the publish
    // with "invalid: event expired") immediately discard it again serves
    // nobody - skip it here instead, before it ever becomes state.
    if (new Date(entity[expiryField]).getTime() <= Date.now()) {
      this.#logger.info("pokemon-state", `skipped already-expired ${label} (${expiryField} ${entity[expiryField]}): ${entity.species ?? entity.rewardName ?? entity.bossSpecies ?? "?"}`);
      return;
    }
    const outcome = await store.upsert(entity);
    if (outcome !== "unchanged") await this.#state.workerMetadata.increment("eventsProcessed");
  }
}
