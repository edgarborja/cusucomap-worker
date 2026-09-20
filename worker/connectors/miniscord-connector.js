// REST client for miniscord - replaces AHK typing + Tampermonkey/browser
// scraping, one call at a time. Covers POST /pokesearch, POST
// /questsearch, GET /gyms, GET /unread, and POST /http-relay - see
// miniscord's own docs (pokesearch-api.md, questsearch-api.md,
// gyms-api.md, unread-api.md, http-relay-api.md) for each endpoint's full
// request/response contract.
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
// Above /http-relay's own documented 15-20s server-side ceiling (see its
// docs) - a client-side safety net, same reasoning as REQUEST_TIMEOUT_MS.
const RELAY_REQUEST_TIMEOUT_MS = 25_000;

// /http-relay's own contract (see its docs) uses standard base64, not the
// base64url variant shared/stable-id.js-adjacent code elsewhere in this
// repo uses for URL-safe contexts - these are plain btoa/atob, matching
// what the endpoint actually expects.
function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToText(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

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
   * as miniscord expects) to POST /pokesearch and returns
   * `{ok:true, results:[...]}` or `{ok:false, error}` - never throws.
   * Exactly one attempt, paced onto the shared chain; callers own their
   * own retry policy.
   * @param {string} command
   * @returns {Promise<{ok:true, results:object[]} | {ok:false, error:string}>}
   */
  search(command) {
    return this.#enqueue("pokesearch", command);
  }

  /**
   * Same contract as search(), against POST /questsearch instead - a
   * separate endpoint, but sharing this connector's own #chain/MIN_GAP_MS
   * pacing with search() rather than its own independent one: both
   * ultimately hit the same Discord bot integration, and the whole point
   * of that pacing is not hammering Discord regardless of which endpoint
   * a given call happens to be for.
   * @param {string} command
   * @returns {Promise<{ok:true, results:object[]} | {ok:false, error:string}>}
   */
  searchQuest(command) {
    return this.#enqueue("questsearch", command);
  }

  #enqueue(endpoint, command) {
    const run = this.#chain.then(() => this.#doSearch(endpoint, command));
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

  /**
   * Relays an arbitrary HTTP request through miniscord's own generic
   * POST /http-relay (see its own docs) - the CORS-bypass mechanism behind
   * MiniscordPushTransport, replacing the retired Tampermonkey bridge.
   * Bypasses #chain/MIN_GAP_MS the same way getGyms()/getUnread() do -
   * this never touches Discord, and pacing an arbitrary relayed request
   * (a push send, an OAuth token exchange) behind the pokesearch cooldown
   * would be actively wrong. Never throws.
   * @param {{url: string, method?: string, headers?: Record<string,string>, body?: Uint8Array|string}} request
   * @returns {Promise<{ok: true, status: number, responseText: string} | {ok: false, error: string}>}
   */
  async relay({ url, method = "POST", headers = {}, body }) {
    const baseUrl = this.#getBaseUrl();
    if (!baseUrl) return { ok: false, error: "miniscord_not_configured" };

    const bodyBytes = body === undefined || body === null ? undefined : typeof body === "string" ? new TextEncoder().encode(body) : body;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/http-relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method, headers, ...(bodyBytes ? { bodyBase64: bytesToBase64(bodyBytes) } : {}) }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const error = data?.error ?? `http_${res.status}`;
        this.#logger.warn("miniscord", `http-relay to ${url} failed: ${error}`);
        return { ok: false, error };
      }
      const responseText = data.bodyBase64 ? base64ToText(data.bodyBase64) : "";
      return { ok: true, status: data.status, responseText };
    } catch (err) {
      const error = err.name === "AbortError" ? "client_timeout" : "network_error";
      this.#logger.warn("miniscord", `http-relay to ${url} failed: ${error} (${err.message})`);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  async #doSearch(endpoint, command) {
    const baseUrl = this.#getBaseUrl();
    if (!baseUrl) return { ok: false, error: "miniscord_not_configured" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const error = data?.error ?? `http_${res.status}`;
        this.#logger.warn("miniscord", `${endpoint} ${JSON.stringify(command)} failed: ${error}`);
        return { ok: false, error };
      }
      const results = data.results ?? [];
      this.#logger.info("miniscord", `${endpoint} ${JSON.stringify(command)} -> ${results.length} result(s)`);
      return { ok: true, results };
    } catch (err) {
      const error = err.name === "AbortError" ? "client_timeout" : "network_error";
      this.#logger.warn("miniscord", `${endpoint} ${JSON.stringify(command)} failed: ${error} (${err.message})`);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }
}
