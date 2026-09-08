// PushTransport abstraction (architecture brief: "Initial implementation:
// TampermonkeyPushTransport. Future: BrowserExtensionPushTransport."). The
// worker builds the entire Web Push HTTP request itself (see
// services/push-sender.js) - this file's only job is getting that request
// actually sent, bypassing the CORS restriction plain page `fetch()` hits
// against push-service origins. Swap in a different transport later by
// implementing the same `send({url, headers, body}) -> {ok, status}` shape.
import { BRIDGE_EVENTS, bridgeChannel } from "./bridge-channel.js";

const RESPONSE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const CONNECTED_STALE_MS = 45_000; // a bit over one missed ping before we call it disconnected

export class TampermonkeyPushTransport {
  #pending = new Map();
  #lastPongAt = 0;

  constructor() {
    bridgeChannel.on(BRIDGE_EVENTS.PUSH_SEND_RESULT, (result) => {
      const pending = this.#pending.get(result.requestId);
      if (!pending) return;
      this.#pending.delete(result.requestId);
      clearTimeout(pending.timeout);
      pending.resolve(result);
    });
    bridgeChannel.on(BRIDGE_EVENTS.PUSH_BRIDGE_PONG, () => {
      this.#lastPongAt = Date.now();
    });
    const ping = () => bridgeChannel.send(BRIDGE_EVENTS.PUSH_BRIDGE_PING, {});
    ping();
    setInterval(ping, PING_INTERVAL_MS);
  }

  /** Best-effort liveness of the push-bridge Tampermonkey script - used by the dashboard, not a hard gate on sending. */
  isBridgeConnected() {
    return Date.now() - this.#lastPongAt < CONNECTED_STALE_MS;
  }

  /**
   * @param {{ url: string, headers: Record<string,string>, body: Uint8Array }} request
   * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
   */
  send(request) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ ok: false, error: "No response from push bridge (is the Tampermonkey push-bridge script installed and enabled on this tab?)" });
      }, RESPONSE_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, timeout });
      bridgeChannel.send(BRIDGE_EVENTS.PUSH_SEND_REQUEST, { requestId, ...request });
    });
  }
}
