// REST client for miniscord's POST /pokesearch endpoint - replaces AHK
// typing + Tampermonkey/browser scraping for pokesearch, one call at a
// time. See miniscord's own docs (pokesearch-api.md) for the full
// request/response contract this implements.
//
// Synchronous request/response, unlike the old scrape-and-later-detect
// model: the HTTP response IS the complete answer to this exact call, so
// there is no "which async message belongs to which search" attribution
// problem left to solve the way the old dedicated-second-tab/activeScanId
// design needed extensive machinery for (see the
// "project_scan_feature_v1_hexlattice" memory for that history).
//
// miniscord makes exactly one attempt per call and never retries
// internally (confirmed in its own docs) - retry policy is entirely the
// caller's concern here, same as it already was for the old AHK-based path.

// A bit over the 5s floor the operator asked for ("I would like to leave a
// cooldown of at least 5 seconds between calls, since we're hitting
// Discord on each call") - applies between the END of one call and the
// START of the next, regardless of which caller queued it, via the shared
// #chain below. Real observed latency per call is ~3s.
const MIN_GAP_MS = 5_500;
// Comfortably above miniscord's own internal ~5s ceiling (see its docs'
// Timing section) - this is a client-side safety net, not the primary
// timeout.
const REQUEST_TIMEOUT_MS = 12_000;

export class MiniscordConnector {
  #getBaseUrl;
  #logger;
  // Serializes every call through this connector - the scheduled loop, a
  // bulk area scan's many circles, a subscriber's own scan - so they're
  // naturally paced MIN_GAP_MS apart rather than fired concurrently or
  // back-to-back. Mirrors AhkConnector's own #sendChain pattern.
  #chain = Promise.resolve();

  /** @param {() => string} getBaseUrl - e.g. "http://127.0.0.1:8770"; falsy disables pokesearch-via-miniscord entirely. */
  constructor({ getBaseUrl, logger }) {
    this.#getBaseUrl = getBaseUrl;
    this.#logger = logger;
  }

  isConfigured() {
    return Boolean(this.#getBaseUrl());
  }

  /**
   * Submits `command` (verbatim slash-command text, already shaped/quoted
   * as miniscord expects) and returns `{ok:true, results:[...]}` or
   * `{ok:false, error}` - never throws. Exactly one attempt, paced onto
   * the shared chain; callers own their own retry policy.
   * @param {string} command
   * @returns {Promise<{ok:true, results:object[]} | {ok:false, error:string}>}
   */
  search(command) {
    const run = this.#chain.then(() => this.#doSearch(command));
    // Always pace the next call MIN_GAP_MS after this one settles,
    // regardless of outcome - #doSearch never throws, but this still
    // guards against a failed call skipping the cooldown.
    this.#chain = run.then(() => new Promise((resolve) => setTimeout(resolve, MIN_GAP_MS)));
    return run;
  }

  /**
   * Fetches miniscord's currently-cached gym/raid snapshot. Unlike
   * search(), this deliberately bypasses #chain and MIN_GAP_MS entirely -
   * GET /gyms never talks to Discord (confirmed live: ~2ms response time,
   * a pure in-memory cache read on miniscord's side), so pacing it behind
   * the pokesearch cooldown would only slow down polling for no reason.
   * Never throws.
   * @param {{includeName?: boolean}} [opts] - `includeName: true` sends
   *   `?include_name=true`. Per miniscord's own docs this is NOT a
   *   per-request flag - it permanently flips a service-wide switch
   *   (never back off) telling the background poller to also ask Niantic
   *   for each gym's name from then on, deviating from Niantic's normal
   *   client query shape. Callers should set this at most once (see
   *   worker-app.js's runMiniscordGymPoll), not on every poll.
   * @returns {Promise<{ok:true, cachedAt:number, results:object[]} | {ok:false, error:string}>}
   */
  async getGyms({ includeName = false } = {}) {
    const baseUrl = this.#getBaseUrl();
    if (!baseUrl) return { ok: false, error: "miniscord_not_configured" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/gyms${includeName ? "?include_name=true" : ""}`, { signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const error = data?.error ?? `http_${res.status}`;
        this.#logger.warn("miniscord", `gyms fetch failed: ${error}`);
        return { ok: false, error };
      }
      return { ok: true, cachedAt: data.cachedAt, results: data.results ?? [] };
    } catch (err) {
      const error = err.name === "AbortError" ? "client_timeout" : "network_error";
      this.#logger.warn("miniscord", `gyms fetch failed: ${error} (${err.message})`);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetches the watched channel's unread state - see
   * worker/connectors/watch-channel-connector.js for how the result is
   * used. Bypasses #chain/MIN_GAP_MS the same way getGyms() does, since
   * this is meant to be polled every ~15s (or piggybacked on other
   * miniscord calls), which the pokesearch cooldown was never designed
   * for. Never throws.
   * @param {string} idOrName - channel id or name, as miniscord's own
   *   GET /unread/{idOrName} expects.
   * @returns {Promise<{ok:true, unread:boolean, lastMessageId:string|null} | {ok:false, error:string}>}
   */
  async getUnread(idOrName) {
    const baseUrl = this.#getBaseUrl();
    if (!baseUrl) return { ok: false, error: "miniscord_not_configured" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/unread/${encodeURIComponent(idOrName)}`, { signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const error = data?.error ?? `http_${res.status}`;
        this.#logger.warn("miniscord", `unread check for ${JSON.stringify(idOrName)} failed: ${error}`);
        return { ok: false, error };
      }
      return { ok: true, unread: Boolean(data.unread), lastMessageId: data.lastMessageId ?? null };
    } catch (err) {
      const error = err.name === "AbortError" ? "client_timeout" : "network_error";
      this.#logger.warn("miniscord", `unread check for ${JSON.stringify(idOrName)} failed: ${error} (${err.message})`);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  async #doSearch(command) {
    const baseUrl = this.#getBaseUrl();
    if (!baseUrl) return { ok: false, error: "miniscord_not_configured" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/pokesearch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const error = data?.error ?? `http_${res.status}`;
        this.#logger.warn("miniscord", `pokesearch ${JSON.stringify(command)} failed: ${error}`);
        return { ok: false, error };
      }
      const results = data.results ?? [];
      this.#logger.info("miniscord", `pokesearch ${JSON.stringify(command)} -> ${results.length} result(s)`);
      return { ok: true, results };
    } catch (err) {
      const error = err.name === "AbortError" ? "client_timeout" : "network_error";
      this.#logger.warn("miniscord", `pokesearch ${JSON.stringify(command)} failed: ${error} (${err.message})`);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }
}
