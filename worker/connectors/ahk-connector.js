// AutoHotKey output adapter - owns scheduling (runScheduledBatch/
// checkDailyCommands) worker-side, so the Source Feed bridge only has to
// relay a plain HTTP POST, never decide when. Sending itself is delegated
// to an injected AhkTransport (see transports/ahk-transport.js).
//
// A queued command is either typed text (default) or, if the string starts
// with HOTKEY_PREFIX, a hotkey to press - see worker-bridge/http_send.ahk's PumpQueue for
// the AHK-side half of that convention. Kept as a plain string prefix, not a
// second endpoint/JSON wrapper, so it still rides the same single FIFO queue
// as typed text: that's what guarantees a hotkey sent after some searches
// (see sendHotkey/watch-channel-connector.js) can't jump ahead of one still
// mid-type.
const HOTKEY_PREFIX = "#HOTKEY# ";

// Where scheduledSearches/dailyCommands are persisted once set via the
// setAhkCommands RPC method (see worker-app.js and commands/commands-app.js)
// - workerMetadata is IndexedDB-backed and already used for this connector's
// own daily-command dedup bookkeeping below, so it's the natural place for
// this too rather than a separate storage mechanism.
const COMMANDS_METADATA_KEY = "ahkCommandsConfig";

// Every daily command gets the same fixed jitter window, not a per-command
// value - matches both of today's real entries (which both used 15) and
// keeps the commands page simple (a timepicker, not a jitter-amount field
// too - see the plan discussion this came out of).
const DAILY_COMMAND_JITTER_MINUTES = 15;

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

// The dedup/jitter bookkeeping below needs a stable-ish key per daily
// command; rather than store a separate label field (one more thing to
// edit on the commands page), it's just derived from the message text
// itself - editing a command's text resets its "already sent today"/jitter
// state for that slot, which is an acceptable edge case for something this
// low-stakes.
function deriveDailyCommandLabel(message) {
  return message.trim().replace(/^\//, "");
}

/** @returns {string | null} a human-readable problem, or null if valid. */
function validateCommandsPayload({ scheduledSearches, dailyCommands }) {
  if (!Array.isArray(scheduledSearches) || scheduledSearches.length === 0 || scheduledSearches.some((m) => typeof m !== "string" || m.trim() === "")) {
    return "scheduledSearches must be a non-empty array of non-empty strings.";
  }
  if (!Array.isArray(dailyCommands)) return "dailyCommands must be an array.";
  for (const cmd of dailyCommands) {
    if (!cmd || typeof cmd.message !== "string" || cmd.message.trim() === "") return "each daily command needs a non-empty message.";
    if (!Number.isInteger(cmd.hour) || cmd.hour < 0 || cmd.hour > 23) return "each daily command's hour must be an integer 0-23.";
    if (!Number.isInteger(cmd.minute) || cmd.minute < 0 || cmd.minute > 59) return "each daily command's minute must be an integer 0-59.";
  }
  return null;
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
  // Serializes every AHK send across every caller - scheduled searches,
  // daily commands, the dashboard's manual "send now", and the
  // watch-channel priority scan/hotkey all funnel through #sendSerialized
  // below, which chains onto this. #runScheduledBatch and #checkDailyCommands
  // are two independent timers with no other coordination between them - a
  // daily command's target time landing mid-batch used to mean both could
  // queue into AHK around the same moment, and if a daily command (a real
  // slash-command interaction, unlike a plain "/pokesearch ..." reply) needed
  // longer than the batch's own inter-search pause to actually finish
  // submitting, the next scheduled search would start typing into a compose
  // box the daily command hadn't fully cleared yet. Routing every send
  // through one chain, each followed by its own settle pause before the
  // chain moves on, is what actually prevents that - not just AHK's own
  // one-at-a-time queue (see http_send.ahk's PumpQueue), which only
  // guarantees ordering, not that Discord's UI had time to settle in between.
  #sendChain = Promise.resolve();
  // Lazily loaded from workerMetadata (falling back to getConfig()'s
  // hardcoded defaults if nothing's ever been persisted) - see
  // #loadCommandsIfNeeded. Cached here once loaded so repeated calls (every
  // #runScheduledBatch/#checkDailyCommands cycle) don't re-hit IndexedDB.
  #activeCommands = null;
  // Bumped by #restartScheduledBatch whenever scheduledSearches actually
  // changes - #runScheduledBatch checks this each iteration (same shape as
  // the #running check) so an in-flight batch running the *old* list stops
  // queuing further old items the moment a newer one starts, without
  // disturbing whatever AHK send is already physically in flight.
  #scheduledSearchesGeneration = 0;

  /**
   * @param {typeof import("../core/config.js").defaultAhkConfig} getConfig - lazy accessor (not a captured value), so a code change to defaultAhkConfig() takes effect on the next cycle without a restart - see that function's own comment for why this isn't part of PublicConfig.
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

  async #loadCommandsIfNeeded() {
    if (this.#activeCommands) return this.#activeCommands;
    const persisted = await this.#state.workerMetadata.get(COMMANDS_METADATA_KEY, null);
    if (persisted && Array.isArray(persisted.scheduledSearches) && Array.isArray(persisted.dailyCommands)) {
      this.#activeCommands = { scheduledSearches: persisted.scheduledSearches, dailyCommands: persisted.dailyCommands };
    } else {
      const config = this.#getConfig();
      this.#activeCommands = { scheduledSearches: config.scheduledSearches, dailyCommands: config.dailyCommands };
    }
    return this.#activeCommands;
  }

  /** For the getAhkCommands RPC handler (see worker-app.js). */
  async getCommands() {
    return this.#loadCommandsIfNeeded();
  }

  /**
   * Applies a new scheduledSearches/dailyCommands pair - called from the
   * setAhkCommands RPC handler. Restarts the scheduled batch loop
   * immediately, but only if scheduledSearches actually differs from what's
   * currently active; a dailyCommands-only change is just persisted and
   * picked up by #checkDailyCommands' own next 60s tick, no restart needed.
   * Returns a plain {ok, ...} result rather than throwing - rpc.js's
   * #dispatch collapses any thrown error into a generic "Internal error"
   * message, which would hide a validation error's actual reason from the
   * caller.
   */
  async applyCommands({ scheduledSearches, dailyCommands }) {
    const error = validateCommandsPayload({ scheduledSearches, dailyCommands });
    if (error) return { ok: false, error };

    const current = await this.#loadCommandsIfNeeded();
    const searchesChanged = JSON.stringify(scheduledSearches) !== JSON.stringify(current.scheduledSearches);
    const dailyChanged = JSON.stringify(dailyCommands) !== JSON.stringify(current.dailyCommands);

    this.#activeCommands = { scheduledSearches, dailyCommands };
    await this.#state.workerMetadata.set(COMMANDS_METADATA_KEY, this.#activeCommands);

    if (searchesChanged) {
      this.#logger.info("ahk", `scheduled searches updated (${scheduledSearches.length} commands) - restarting the loop now`);
      this.#restartScheduledBatch();
    }
    if (dailyChanged) this.#logger.info("ahk", `daily commands updated (${dailyCommands.length} commands) - takes effect on the next check`);
    if (!searchesChanged && !dailyChanged) this.#logger.info("ahk", "commands saved - no actual change from what was already active");

    return { ok: true, scheduledSearches, dailyCommands };
  }

  #restartScheduledBatch() {
    this.#scheduledSearchesGeneration++;
    clearTimeout(this.#batchTimer);
    if (this.#running) this.#runScheduledBatch();
  }

  // Every AHK send funnels through here (scheduled searches, daily
  // commands, the dashboard's manual "send now", the watch-channel priority
  // scan, and the clear-unread hotkey) - logging both outcomes here, not
  // just failures, is what makes the dashboard's activity log (see
  // core/logging.js) a full audit trail of what was actually sent, not only
  // what went wrong.
  async #send(message) {
    const result = await this.#ahkTransport.send(message);
    const isHotkey = message.startsWith(HOTKEY_PREFIX);
    const label = isHotkey ? `hotkey "${message.slice(HOTKEY_PREFIX.length)}"` : `"${message}"`;
    if (result.ok) this.#logger.info("ahk", `sent ${label}`);
    else this.#logger.error("ahk", `send failed for ${label}: ${result.error ?? `HTTP ${result.status}`}`);
    this.#bus.emit("ahk.command-sent", { message, at: Date.now(), ok: result.ok });
  }

  /**
   * Chains message onto #sendChain so it can't run concurrently with (or
   * immediately alongside) any other caller's send, then unconditionally
   * pauses `pause` seconds before letting the chain move on - that pause is
   * what gives Discord's UI time to actually finish submitting/settling
   * before anything else touches the compose box. There is no way to skip
   * it: an earlier version let the last message of a sendSequence call
   * through with no pause on the theory that the caller's own next step
   * (e.g. sendHotkey) would supply one - but the chain is shared with
   * whatever unrelated caller (a scheduled search, a daily command) happens
   * to be queued right behind it, which has no "own next step" to rely on,
   * so that message fired with no settle time at all.
   * @param {string} message
   * @param {{minS: number, maxS: number}} pause
   */
  #sendSerialized(message, pause) {
    const run = this.#sendChain.then(async () => {
      await this.#send(message);
      await sleep(randomInt(pause.minS, pause.maxS) * 1000);
    });
    this.#sendChain = run.catch(() => {}); // one failed send must not wedge the chain forever
    return run;
  }

  /** Exposed for the dashboard "send now" form - outside the normal schedule. */
  async sendCustomCommand(message) {
    const { searchPauseMinS, searchPauseMaxS } = this.#getConfig();
    await this.#sendSerialized(message, { minS: searchPauseMinS, maxS: searchPauseMaxS });
  }

  /**
   * Sends a list of messages back-to-back, pacing between them - used for
   * the watch-channel connector's out-of-schedule "scan now" (see
   * watch-channel-connector.js). Everything here still goes through the
   * same #sendChain as scheduled searches/daily commands, so it naturally
   * waits its turn behind whichever of those (if any) is already mid-send,
   * rather than needing its own separate "is something else busy" check -
   * which is also why the *last* message here still gets the pause, not
   * just the ones in between: skipping it once let a scheduled search that
   * happened to be queued right behind this call fire immediately after,
   * with no settle time, the same bug this chain exists to prevent (just
   * moved to a different pair of messages - see #sendChain's own comment).
   * @param {string[]} messages
   * @param {{minS: number, maxS: number}} pause
   */
  async sendSequence(messages, pause) {
    for (const message of messages) {
      if (!this.#running) return;
      await this.#sendSerialized(message, pause);
    }
  }

  /**
   * Presses a hotkey rather than typing text - see HOTKEY_PREFIX above and
   * worker-bridge/http_send.ahk's PumpQueue. `spec` is AHK Send-command key
   * notation, e.g. "+{Escape}" for Shift+Esc.
   */
  async sendHotkey(spec) {
    const { priorityScanPauseMinS, priorityScanPauseMaxS } = this.#getConfig();
    await this.#sendSerialized(`${HOTKEY_PREFIX}${spec}`, { minS: priorityScanPauseMinS, maxS: priorityScanPauseMaxS });
  }

  async #runScheduledBatch() {
    const generation = this.#scheduledSearchesGeneration;
    const config = this.#getConfig();
    const { scheduledSearches } = await this.#loadCommandsIfNeeded();
    for (const message of scheduledSearches) {
      if (!this.#running || generation !== this.#scheduledSearchesGeneration) return;
      await this.#sendSerialized(message, { minS: config.searchPauseMinS, maxS: config.searchPauseMaxS });
    }
    if (!this.#running || generation !== this.#scheduledSearchesGeneration) return;
    const restMs = randomInt(config.batchRestMinMin, config.batchRestMaxMin) * 60_000;
    this.#batchTimer = setTimeout(() => this.#runScheduledBatch(), restMs);
  }

  async #checkDailyCommands() {
    const config = this.#getConfig();
    const { dailyCommands } = await this.#loadCommandsIfNeeded();
    const today = todayKey();
    const now = Date.now();
    for (const cmd of dailyCommands) {
      if (!this.#running) return;
      const label = deriveDailyCommandLabel(cmd.message);
      const sentKey = `ahkDailyCommandSent:${label}:${today}`;
      if (await this.#state.workerMetadata.get(sentKey, false)) continue;

      const instantKey = `ahkDailyCommandInstant:${label}:${today}`;
      let targetMs = await this.#state.workerMetadata.get(instantKey, null);
      if (targetMs === null) {
        const target = new Date();
        target.setHours(cmd.hour, cmd.minute, 0, 0);
        target.setMinutes(target.getMinutes() + randomInt(-DAILY_COMMAND_JITTER_MINUTES, DAILY_COMMAND_JITTER_MINUTES));
        targetMs = target.getTime();
        await this.#state.workerMetadata.set(instantKey, targetMs);
      }

      if (now >= targetMs) {
        if (!this.#running) return;
        // Same pause as a scheduled search, not zero - see #sendChain's
        // comment for the incident this fixes (a daily command and the next
        // scheduled search racing into the same compose box).
        const pause = { minS: config.searchPauseMinS, maxS: config.searchPauseMaxS };
        // Every daily command is a real Discord slash command, which needs
        // Enter pressed twice - the first only accepts the autocomplete/
        // subcommand selection, it doesn't submit. Reuses the existing
        // hotkey path rather than teaching AHK a new command type: queue
        // the command, then queue a plain "{Enter}" hotkey right after it.
        // Both #sendSerialized calls MUST be issued here with no `await`
        // between them, same reasoning as watch-channel-connector.js's
        // #handleAlert - otherwise a scheduled search could grab the chain
        // slot between the command and its second Enter.
        const commandSend = this.#sendSerialized(cmd.message, pause);
        const enterSend = this.#sendSerialized(`${HOTKEY_PREFIX}{Enter}`, pause);
        await Promise.all([commandSend, enterSend]);
        await this.#state.workerMetadata.set(sentKey, true);
        this.#logger.info("ahk", `sent daily command "${label}"`);
      }
    }
  }
}
