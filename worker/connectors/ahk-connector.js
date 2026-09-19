// AutoHotKey output adapter - owns daily-command scheduling
// (#checkDailyCommands) and the bulk-scan priority mutex (used by
// quest-scan/raid-scan) worker-side, so the Source Feed bridge only has to
// relay a plain HTTP POST, never decide when. Sending itself is delegated
// to an injected AhkTransport (see transports/ahk-transport.js). Pokesearch
// scheduling now lives in worker-app.js, sent through miniscord instead -
// see that file's own miniscord-driven scheduled loop.
//
// A queued command is either typed text (default) or, if the string starts
// with HOTKEY_PREFIX, a hotkey to press - see worker-bridge/http_send.ahk's PumpQueue for
// the AHK-side half of that convention. Kept as a plain string prefix, not a
// second endpoint/JSON wrapper, so it still rides the same single FIFO queue
// as typed text: that's what guarantees the Enter half of #sendDoubleEnter
// can't jump ahead of the command it belongs to.
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

// The gap between typing a double-Enter command (see #sendDoubleEnter) and
// pressing the Enter that confirms it - just long enough for Discord's own
// UI to register the typed command, not a full inter-command settle pause.
const CONFIRM_ENTER_GAP = { minS: 1, maxS: 2 };

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
  #dailyCheckTimer = null;
  // start()/stop() only arm/disarm the *outer* timer - a daily check
  // already mid-loop (sleeping between queued sends) has no other way to
  // notice it was disabled, so #checkDailyCommands re-checks this flag
  // before each send/continuation rather than relying on the timer alone.
  #running = false;
  // Serializes every AHK send across every caller - daily commands, the
  // dashboard's manual "send now", and quest-scan/raid-scan's own
  // runBulkScan all funnel through #sendSerialized below, which chains
  // onto this. Each send is followed by
  // its own settle pause before the chain moves on - not just AHK's own
  // one-at-a-time queue (see http_send.ahk's PumpQueue), which only
  // guarantees ordering, not that Discord's UI had time to settle in
  // between (see the incident #sendDoubleEnter's own comment describes for
  // why that distinction matters).
  #sendChain = Promise.resolve();
  // Lazily loaded from workerMetadata (falling back to getConfig()'s
  // hardcoded defaults if nothing's ever been persisted) - see
  // #loadCommandsIfNeeded. Cached here once loaded so repeated calls (every
  // #checkDailyCommands cycle, or worker-app.js's own miniscord-driven
  // scheduled loop reading scheduledSearches) don't re-hit IndexedDB.
  #activeCommands = null;
  // Bulk-scan precedence gate (see runBulkScan) - resolved when no scan is
  // running, pending for the scan's entire duration. #checkDailyCommands
  // awaits this before sending anything, which is what actually gives a
  // bulk scan priority over daily commands: not by racing for the next
  // #sendChain slot (the same race that corrupted compose boxes earlier in
  // this file's history), but by nobody else even attempting to enqueue
  // while it's pending. The scan's own sends don't wait on it - only
  // everyone else does.
  #bulkScanGate = Promise.resolve();
  #bulkScanActive = false;
  #bulkScanCancelRequested = false;
  // #checkDailyCommands can now block for as long as a bulk scan takes
  // (potentially much longer than its own 60s tick interval) - without
  // this, a second/third tick could stack up waiting on the same gate and
  // all fire the same daily command once it clears.
  #dailyCheckRunning = false;

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
    this.#dailyCheckTimer = setInterval(() => this.#checkDailyCommands().catch((err) => this.#logger.error("ahk", err.message)), 60_000);
  }

  stop() {
    this.#running = false;
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
   * setAhkCommands RPC handler. Both lists just get persisted here;
   * scheduledSearches is read fresh at the start of each pass by
   * worker-app.js's own miniscord-driven scheduled loop (no restart to
   * trigger from this side any more - a change takes effect within that
   * loop's own next pass, a few minutes out at most, same as
   * dailyCommands already worked). Returns a plain {ok, ...} result rather
   * than throwing - rpc.js's #dispatch collapses any thrown error into a
   * generic "Internal error" message, which would hide a validation
   * error's actual reason from the caller.
   */
  async applyCommands({ scheduledSearches, dailyCommands }) {
    const error = validateCommandsPayload({ scheduledSearches, dailyCommands });
    if (error) return { ok: false, error };

    const current = await this.#loadCommandsIfNeeded();
    const searchesChanged = JSON.stringify(scheduledSearches) !== JSON.stringify(current.scheduledSearches);
    const dailyChanged = JSON.stringify(dailyCommands) !== JSON.stringify(current.dailyCommands);

    this.#activeCommands = { scheduledSearches, dailyCommands };
    await this.#state.workerMetadata.set(COMMANDS_METADATA_KEY, this.#activeCommands);

    if (searchesChanged) this.#logger.info("ahk", `scheduled searches updated (${scheduledSearches.length} commands) - takes effect on the next pass`);
    if (dailyChanged) this.#logger.info("ahk", `daily commands updated (${dailyCommands.length} commands) - takes effect on the next check`);
    if (!searchesChanged && !dailyChanged) this.#logger.info("ahk", "commands saved - no actual change from what was already active");

    return { ok: true, scheduledSearches, dailyCommands };
  }

  // Every AHK send funnels through here (daily commands, the dashboard's
  // manual "send now", and quest-scan/raid-scan) - logging both outcomes
  // here, not just failures, is what makes the dashboard's activity log
  // (see core/logging.js) a full audit trail of what was actually sent,
  // not only what went wrong.
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
   * it: an earlier version let a queued call's last message through with no
   * pause on the theory that the caller's own next step would supply one -
   * but the chain is shared with whatever unrelated
   * caller (a daily command, quest-scan/raid-scan) happens to be queued
   * right behind it, which has no "own next step" to rely on, so that
   * message fired with no settle time at all.
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
   * Sends `message` and a separate {Enter} hotkey press back-to-back - some
   * real Discord slash commands need Enter pressed twice (the first only
   * accepts the autocomplete/subcommand selection, it doesn't submit). Both
   * #sendSerialized calls MUST be issued here with no `await` between them:
   * otherwise some other queued sender (another daily command,
   * quest-scan/raid-scan) could grab the chain slot between the command and
   * its second Enter - see #sendChain's own comment for the incident that
   * first surfaced this.
   *
   * The two sends get *different* pauses, not `pause` twice: the first only
   * needs to be long enough for Discord's own UI to register the typed
   * command (autocomplete, etc.) before the Enter keypress, not a full
   * randomized inter-command settle pause - that only needs to happen once,
   * after the Enter actually submits something, which is what `pause`
   * itself is for. Using `pause` for both (an earlier version of this did)
   * cost every double-Enter command an extra several-second delay for no
   * real benefit - confirmed live: the command still worked either way,
   * this only affects how long the whole thing takes.
   */
  #sendDoubleEnter(message, pause) {
    const commandSend = this.#sendSerialized(message, CONFIRM_ENTER_GAP);
    const enterSend = this.#sendSerialized(`${HOTKEY_PREFIX}{Enter}`, pause);
    return Promise.all([commandSend, enterSend]);
  }

  async #checkDailyCommands() {
    if (this.#dailyCheckRunning) return;
    this.#dailyCheckRunning = true;
    try {
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
          await this.#bulkScanGate;
          if (!this.#running) return; // re-check - a scan may have run for a while
          // Same pause as a scheduled search, not zero - see #sendChain's
          // comment for the incident this fixes (a daily command and the next
          // scheduled search racing into the same compose box).
          const pause = { minS: config.searchPauseMinS, maxS: config.searchPauseMaxS };
          // Every daily command is a real Discord slash command, which needs
          // Enter pressed twice - see #sendDoubleEnter's own comment.
          await this.#sendDoubleEnter(cmd.message, pause);
          await this.#state.workerMetadata.set(sentKey, true);
          this.#logger.info("ahk", `sent daily command "${label}"`);
        }
      }
    } finally {
      this.#dailyCheckRunning = false;
    }
  }

  /** No-op if no scan is currently running. Checked between commands, not mid-send - see runBulkScan. */
  cancelBulkScan() {
    if (this.#bulkScanActive) this.#bulkScanCancelRequested = true;
  }

  /**
   * Runs a bulk scan: for each location in `locations`, sends
   * `buildRowCommands(location)` in sequence with the normal search pause -
   * used for the dashboard's quest-scan/raid-scan sections (see
   * worker/core/scan-groups.js and worker-app.js). Takes exclusive priority
   * over daily commands for its entire duration (see #bulkScanGate); only
   * one bulk scan, of either kind, can run at a time.
   * @param {object[]} locations
   * @param {(location: object) => string[]} buildRowCommands
   * @param {(sent: number, total: number) => void} [onProgress]
   * @param {{ beforeCommand?: string, afterCommand?: string }} [wrap] - only
   *   the area scan uses these (see worker-app.js's runAreaScan): a command
   *   to send (double Enter - see #sendDoubleEnter) before the location loop
   *   starts, and one to send (single Enter) after it ends, whether it ran
   *   to completion or was cancelled - both still inside the priority gate,
   *   so neither can be interleaved with the scheduled loop resuming. The
   *   "after" send is best-effort (logged, not thrown) so a failure here
   *   can't mask whatever error the main loop itself hit.
   * @returns {Promise<{sent: number, total: number, cancelled: boolean}>}
   */
  async runBulkScan(locations, buildRowCommands, onProgress, { beforeCommand, afterCommand } = {}) {
    if (this.#bulkScanActive) throw new Error("A scan is already running.");
    this.#bulkScanActive = true;
    this.#bulkScanCancelRequested = false;
    let releaseGate;
    this.#bulkScanGate = new Promise((resolve) => {
      releaseGate = resolve;
    });

    const { searchPauseMinS, searchPauseMaxS } = this.#getConfig();
    const pause = { minS: searchPauseMinS, maxS: searchPauseMaxS };
    const total = locations.reduce((sum, location) => sum + buildRowCommands(location).length, 0);
    let sent = 0;
    let cancelled = false;
    try {
      if (beforeCommand) await this.#sendDoubleEnter(beforeCommand, pause);
      scanLoop: for (const location of locations) {
        for (const message of buildRowCommands(location)) {
          if (!this.#running || this.#bulkScanCancelRequested) {
            cancelled = true;
            break scanLoop;
          }
          await this.#sendSerialized(message, pause);
          sent++;
          onProgress?.(sent, total);
        }
      }
    } finally {
      if (afterCommand) {
        try {
          await this.#sendSerialized(afterCommand, pause);
        } catch (err) {
          this.#logger.error("ahk", `bulk scan cleanup command failed: ${err.message}`);
        }
      }
      this.#bulkScanActive = false;
      this.#bulkScanCancelRequested = false;
      releaseGate();
      this.#bulkScanGate = Promise.resolve();
    }
    return { sent, total, cancelled };
  }
}
