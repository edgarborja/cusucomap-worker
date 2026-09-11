// Reacts to the watched channel's unread badge (detected bridge-side by the
// companion script's Source Feed-tab half - see its isWatchChannelUnread/
// pollWatchChannelUnread) by pressing the clear-unread hotkey and running a
// short priority search scan through AhkConnector, in that order - see
// AhkConnector#sendSequence/#sendHotkey and worker-bridge/http_send.ahk's
// HOTKEY_PREFIX handling for the AHK-side half of that.
//
// Detection lives entirely in the Source Feed tab, which has no visibility
// into AhkConnector's own scheduling state - but no coordination is needed
// here either: sendSequence/sendHotkey both go through AhkConnector's own
// #sendChain, so this naturally queues behind whatever scheduled search or
// daily command (if any) is already mid-send. It does still have to issue
// both calls back-to-back with no `await` in between, though - see
// #handleAlert's own comment for why.
import { BRIDGE_EVENTS, bridgeChannel } from "../transports/bridge-channel.js";

export class WatchChannelConnector {
  #bus;
  #logger;
  #getWatchChannelName;
  #getPriorityScanConfig;
  #getClearUnreadHotkey;
  #ahkConnector;
  #isAhkEnabled;
  #lastSeenSeq = 0;
  #busy = false;

  /**
   * @param {() => string} getWatchChannelName - sidebar dnd-name to watch, pushed to the bridge on start().
   * @param {() => {messages: string[], pause: {minS: number, maxS: number}}} getPriorityScanConfig
   * @param {() => string} getClearUnreadHotkey - AHK Send-command key notation, e.g. "+{Escape}".
   * @param {() => boolean} isAhkEnabled - the dashboard's "Enable AHK" toggle (see worker-app.js's wireAhkControls) - same guard the manual "send now" form already respects; this connector must not send anything while it's off.
   */
  constructor({ bus, logger, getWatchChannelName, getPriorityScanConfig, getClearUnreadHotkey, ahkConnector, isAhkEnabled }) {
    this.#bus = bus;
    this.#logger = logger;
    this.#getWatchChannelName = getWatchChannelName;
    this.#getPriorityScanConfig = getPriorityScanConfig;
    this.#getClearUnreadHotkey = getClearUnreadHotkey;
    this.#ahkConnector = ahkConnector;
    this.#isAhkEnabled = isAhkEnabled;
  }

  start() {
    bridgeChannel.send(BRIDGE_EVENTS.SET_WATCH_CHANNEL_NAME, { name: this.#getWatchChannelName() });
    bridgeChannel.on(BRIDGE_EVENTS.WATCH_CHANNEL_ALERT, (alert) => this.#handleAlert(alert).catch((err) => this.#logger.error("watch-channel", err.message)));
  }

  async #handleAlert(alert) {
    if (alert.seq <= this.#lastSeenSeq) return; // stale/duplicate GM value replay
    this.#lastSeenSeq = alert.seq;

    if (!this.#isAhkEnabled()) {
      this.#logger.warn("watch-channel", "unread badge detected but AHK is disabled - not scanning/clearing.");
      return;
    }
    if (this.#busy) {
      this.#logger.warn("watch-channel", "alert arrived while already handling a previous one - dropping (the badge will reappear if this one wasn't actually cleared).");
      return;
    }

    this.#busy = true;
    try {
      const { messages, pause } = this.#getPriorityScanConfig();
      this.#logger.info("watch-channel", `unread badge detected - clearing it, then sending priority scan (${messages.length} searches)`);

      // Clear first, scan second: clearing the badge sooner (rather than
      // after the scan) is what re-arms the companion script's own debounce
      // (see isWatchChannelUnread/pollWatchChannelUnread) as fast as
      // possible, so a second hundo landing shortly after this one still
      // gets its own alert instead of being masked by a badge that's still
      // sitting unread from the first.
      //
      // Both sends below MUST be issued here with no `await` between them.
      // AhkConnector#sendSerialized appends to its shared chain the instant
      // it's called (synchronously) - awaiting the first call before making
      // the second used to leave exactly one open slot in that chain, and
      // an unrelated scheduled search (running on its own independent
      // timer) reliably won the race to fill it, landing between the scan
      // and the clear every time this was observed live. Firing both calls
      // back-to-back with no intervening `await` closes that gap: nothing
      // else can get a turn in the single JS tick between them.
      const hotkeySend = this.#ahkConnector.sendHotkey(this.#getClearUnreadHotkey());
      const scanSend = this.#ahkConnector.sendSequence(messages, pause);
      await Promise.all([hotkeySend, scanSend]);

      this.#bus.emit("watch-channel.cycle-complete", { at: Date.now() });
    } finally {
      this.#busy = false;
    }
  }
}
