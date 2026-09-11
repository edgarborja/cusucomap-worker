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
    const config = this.#getConfig();
    for (const message of config.scheduledSearches) {
      if (!this.#running) return;
      await this.#sendSerialized(message, { minS: config.searchPauseMinS, maxS: config.searchPauseMaxS });
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
        // Same pause as a scheduled search, not zero - see #sendChain's
        // comment for the incident this fixes (a daily command and the next
        // scheduled search racing into the same compose box).
        const pause = { minS: config.searchPauseMinS, maxS: config.searchPauseMaxS };
        if (cmd.doubleEnter) {
          // A real Discord slash command like "/questset addchannel" needs
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
        } else {
          await this.#sendSerialized(cmd.message, pause);
        }
        await this.#state.workerMetadata.set(sentKey, true);
        this.#logger.info("ahk", `sent daily command "${cmd.label}"`);
      }
    }
  }
}
