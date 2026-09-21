// Watches a channel for a genuinely new message via miniscord's own
// GET /unread/{idOrName}, and runs a fixed "special" pokesearch (see
// worker-app.js's own runSpecialSearch callback) the moment one shows up -
// this repo's automated response to a 100% IV Pokémon posted elsewhere in
// the server.
//
// Supersedes the earlier Source Feed-tab bridge (WATCH_CHANNEL_ALERT/
// SET_WATCH_CHANNEL_NAME - see git history) + AHK clear-unread-hotkey
// design: GET /unread's own `unread` flag is confirmed (per miniscord's
// own docs) to never reset itself once true, so it can't be used to detect
// a *new* message on its own - only a change in `lastMessageId` can. That
// also removes the entire reason the old design had to press a hotkey at
// all: that existed purely to re-arm the bridge script's own DOM-badge
// debounce so a second hundo landing soon after the first still got its
// own alert - lastMessageId tracking has no such debounce to re-arm.
const POLL_INTERVAL_MS = 15_000;

export class WatchChannelConnector {
  #logger;
  #getWatchChannelName;
  #miniscordConnector;
  #runSpecialSearch;
  #lastSeenMessageIdCache;
  #lastSeenMessageId = null;
  #lastCheckedAt = 0;
  #checking = false;

  /**
   * @param {() => string} getWatchChannelName - channel id/name to pass as GET /unread/{idOrName}'s path segment - leave blank to disable.
   * @param {import("./miniscord-connector.js").MiniscordConnector} miniscordConnector
   * @param {() => Promise<{ok:boolean, error?:string}>} runSpecialSearch - runs the fixed iv100 pokesearch and publishes whatever it finds; owns its own retry policy internally (see worker-app.js's own implementation) and only resolves once it's given up on retrying, same as this class's own single-attempt-per-check contract expects.
   * @param {{get: () => Promise<string|null>, set: (id: string) => Promise<void>}} lastSeenMessageIdCache - persisted (not just in-memory) so a restart doesn't mistake a message that was already unread before the restart for a brand new one.
   */
  constructor({ logger, getWatchChannelName, miniscordConnector, runSpecialSearch, lastSeenMessageIdCache }) {
    this.#logger = logger;
    this.#getWatchChannelName = getWatchChannelName;
    this.#miniscordConnector = miniscordConnector;
    this.#runSpecialSearch = runSpecialSearch;
    this.#lastSeenMessageIdCache = lastSeenMessageIdCache;
  }

  async start() {
    this.#lastSeenMessageId = await this.#lastSeenMessageIdCache.get();
    setInterval(() => this.#checkIfDue(), POLL_INTERVAL_MS);
    this.#checkIfDue();
  }

  /**
   * Safe to call after any other miniscord round trip completes (search,
   * gym poll) - a no-op unless POLL_INTERVAL_MS has actually elapsed since
   * the last real check, so an opportunistic caller never causes more than
   * one genuine GET /unread call per interval. This is what lets a new
   * message get noticed sooner than the next scheduled poll tick without
   * the connector needing to know anything about what triggered it.
   */
  notifyMiniscordActivity() {
    this.#checkIfDue();
  }

  #checkIfDue() {
    if (Date.now() - this.#lastCheckedAt < POLL_INTERVAL_MS) return;
    this.#check().catch((err) => this.#logger.error("watch-channel", err.message));
  }

  async #check() {
    const channelName = this.#getWatchChannelName();
    if (!channelName || !this.#miniscordConnector.isConfigured() || this.#checking) return;

    this.#checking = true;
    this.#lastCheckedAt = Date.now();
    try {
      const result = await this.#miniscordConnector.getUnread(channelName);
      if (!result.ok) {
        this.#logger.warn("watch-channel", `unread check failed: ${result.error}`);
        return;
      }
      if (!result.lastMessageId || result.lastMessageId === this.#lastSeenMessageId) return;

      this.#lastSeenMessageId = result.lastMessageId;
      await this.#lastSeenMessageIdCache.set(result.lastMessageId);
      this.#logger.info("watch-channel", "new message on the watched channel - running the special pokesearch");
      const searchResult = await this.#runSpecialSearch();
      if (!searchResult.ok) this.#logger.warn("watch-channel", `special pokesearch failed: ${searchResult.error}`);
    } finally {
      this.#checking = false;
    }
  }
}
