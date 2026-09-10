// AutoHotKey output adapter - owns scheduling (runScheduledBatch/
// checkDailyCommands) worker-side, so the Source Feed bridge only has to
// relay a plain HTTP POST, never decide when. Sending itself is delegated
// to an injected AhkTransport (see transports/ahk-transport.js).

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Inclusive on both ends.
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
// Local calendar date, NOT toISOString().slice(0,10) - see the ported
// original's own comment on why UTC conversion would break the
// once-per-local-day dedupe key this feeds.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class AhkConnector {
  #bus;
  #logger;
  #state;
  #getConfig;
  #ahkTransport;
  #batchTimer = null;
  #dailyCheckTimer = null;
  // start()/stop() only arm/disarm the *outer* timers - a batch or daily
  // check already mid-loop (sleeping between queued sends) has no other way
  // to notice it was disabled, so every loop below re-checks this flag
  // before each send/continuation rather than relying on the timers alone.
  #running = false;

  /**
   * @param {() => import("../core/config.js").PublicConfig["ahk"]} getConfig - lazy accessor, so an operator config edit takes effect on the next cycle without a restart.
   * @param {import("../transports/ahk-transport.js").AhkTransport} ahkTransport
   */
  constructor({ bus, logger, state, getConfig, ahkTransport }) {
    this.#bus = bus;
    this.#logger = logger;
    this.#state = state;
    this.#getConfig = getConfig;
    this.#ahkTransport = ahkTransport;
  }

  start() {
    this.#running = true;
    this.#runScheduledBatch();
    this.#dailyCheckTimer = setInterval(() => this.#checkDailyCommands().catch((err) => this.#logger.error("ahk", err.message)), 60_000);
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#batchTimer);
    clearInterval(this.#dailyCheckTimer);
  }

  async #send(message) {
    const result = await this.#ahkTransport.send(message);
    if (!result.ok) this.#logger.error("ahk", `send failed for "${message}": ${result.error ?? `HTTP ${result.status}`}`);
    this.#bus.emit("ahk.command-sent", { message, at: Date.now(), ok: result.ok });
  }

  /** Exposed for the dashboard "send now" form - outside the normal schedule. */
  async sendCustomCommand(message) {
    await this.#send(message);
  }

  async #runScheduledBatch() {
    const config = this.#getConfig();
    for (const message of config.scheduledSearches) {
      if (!this.#running) return;
      await this.#send(message);
      if (!this.#running) return;
      await sleep(randomInt(config.searchPauseMinS, config.searchPauseMaxS) * 1000);
    }
    if (!this.#running) return;
    const restMs = randomInt(config.batchRestMinMin, config.batchRestMaxMin) * 60_000;
    this.#batchTimer = setTimeout(() => this.#runScheduledBatch(), restMs);
  }

  async #checkDailyCommands() {
    const config = this.#getConfig();
    const today = todayKey();
    const now = Date.now();
    for (const cmd of config.dailyCommands) {
      if (!this.#running) return;
      const sentKey = `ahkDailyCommandSent:${cmd.label}:${today}`;
      if (await this.#state.workerMetadata.get(sentKey, false)) continue;

      const instantKey = `ahkDailyCommandInstant:${cmd.label}:${today}`;
      let targetMs = await this.#state.workerMetadata.get(instantKey, null);
      if (targetMs === null) {
        const target = new Date();
        target.setHours(cmd.targetHour, 0, 0, 0);
        target.setMinutes(target.getMinutes() + randomInt(-cmd.jitterMinutes, cmd.jitterMinutes));
        targetMs = target.getTime();
        await this.#state.workerMetadata.set(instantKey, targetMs);
      }

      if (now >= targetMs) {
        if (!this.#running) return;
        await this.#send(cmd.message);
        await this.#state.workerMetadata.set(sentKey, true);
        this.#logger.info("ahk", `sent daily command "${cmd.label}"`);
      }
    }
  }
}
