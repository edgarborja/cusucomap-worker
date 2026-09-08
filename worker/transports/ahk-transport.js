// AhkTransport - hands a raw command string to the companion script's
// privileged GM_xmlhttpRequest (see worker-bridge/README.md for where that
// script actually lives), which POSTs it to the operator's local AHK HTTP listener
// (http://127.0.0.1:8765/send by default). A plain page fetch() would
// either get blocked by CORS preflight or return an unreadable opaque
// response, since that listener is a minimal custom AHK script with no
// reason to implement CORS response headers - same bypass-CORS-via-
// privileged-bridge shape as TampermonkeyPushTransport, simplified: no
// signed bytes/headers, just plain text, and no cross-tab GM storage hop
// needed since (unlike Source Feed scraping) sending to AHK isn't tied to any
// particular Source Feed tab being open - the bridge script's worker-tab half
// handles this directly.
import { BRIDGE_EVENTS, bridgeChannel } from "./bridge-channel.js";

const RESPONSE_TIMEOUT_MS = 10_000;

export class AhkTransport {
  #pending = new Map();

  constructor() {
    bridgeChannel.on(BRIDGE_EVENTS.AHK_SEND_RESULT, (result) => {
      const pending = this.#pending.get(result.requestId);
      if (!pending) return;
      this.#pending.delete(result.requestId);
      clearTimeout(pending.timeout);
      pending.resolve(result);
    });
  }

  /** @param {string} text @returns {Promise<{ ok: boolean, status?: number, error?: string }>} */
  send(text) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ ok: false, error: "No response from the companion script (is it installed/active, and is the AHK script listening on 127.0.0.1:8765?)" });
      }, RESPONSE_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, timeout });
      bridgeChannel.send(BRIDGE_EVENTS.AHK_SEND_COMMAND, { requestId, text });
    });
  }
}
