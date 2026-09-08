// Generic request/response RPC over NostrTransport's encrypted channel -
// the "api.handle(method, fn)" abstraction from the architecture brief.
// Nothing above this file (accounts.js, notifications.js, pokemon-state.js)
// should ever construct a Nostr event or touch encryption directly.
//
// Wire shape (see shared/nostr-protocol.js): a caller NIP-44-encrypts
// {v, id, method, params} to the worker's pubkey as a KIND_RPC_REQUEST
// event; the worker decrypts, dispatches, and NIP-44-encrypts
// {v, id, ok, result|error} back to the caller's pubkey as a
// KIND_RPC_RESPONSE event. Both kinds are in the NIP-01 ephemeral range, so
// relays don't retain them - a lost response just means the caller's
// api.call() times out and it can retry, same as any other RPC.
//
// The *viewer*-side counterpart (`await api.call("getCurrentSpawns", ...)`)
// isn't implemented yet - see worker/README.md for the exact wire shape a
// future viewer-side client would need to speak.
import { KIND_RPC_REQUEST, KIND_RPC_RESPONSE, encodeRpcResult, encodeRpcError } from "../../shared/nostr-protocol.js";

const REPLAY_WINDOW_MS = 10 * 60_000; // how long a request id is remembered for duplicate-delivery protection

export class Rpc {
  #transport;
  #state;
  #logger;
  /** @type {Map<string, (params: unknown, ctx: { fromPubkey: string }) => unknown | Promise<unknown>>} */
  #handlers = new Map();

  constructor({ transport, state, logger }) {
    this.#transport = transport;
    this.#state = state;
    this.#logger = logger;
  }

  handle(method, fn) {
    if (this.#handlers.has(method)) throw new Error(`RPC method "${method}" already registered.`);
    this.#handlers.set(method, fn);
  }

  start() {
    this.#transport.subscribeEncrypted(KIND_RPC_REQUEST, ({ fromPubkey, eventId, data }) => this.#dispatch(fromPubkey, eventId, data));
    setInterval(() => this.#state.processedEvents.prune(REPLAY_WINDOW_MS), 60_000);
  }

  async #dispatch(fromPubkey, eventId, envelope) {
    if (!envelope || typeof envelope.id !== "string" || typeof envelope.method !== "string") {
      this.#logger.warn("rpc", `malformed request from ${fromPubkey.slice(0, 8)}… (missing id/method)`);
      return;
    }
    if (await this.#state.processedEvents.has(eventId)) {
      this.#logger.warn("rpc", `dropped replayed event ${eventId.slice(0, 8)}… (method "${envelope.method}")`);
      return;
    }
    await this.#state.processedEvents.mark(eventId);

    const handler = this.#handlers.get(envelope.method);
    if (!handler) {
      await this.#reply(fromPubkey, encodeRpcError(envelope.id, `Unknown method "${envelope.method}"`));
      return;
    }
    try {
      const result = await handler(envelope.params, { fromPubkey });
      await this.#reply(fromPubkey, encodeRpcResult(envelope.id, result));
    } catch (err) {
      this.#logger.error("rpc", `handler for "${envelope.method}" threw: ${err.message}`);
      await this.#reply(fromPubkey, encodeRpcError(envelope.id, "Internal error handling request."));
    }
  }

  async #reply(toPubkey, envelope) {
    await this.#transport.sendEncrypted(toPubkey, KIND_RPC_RESPONSE, envelope);
  }
}
