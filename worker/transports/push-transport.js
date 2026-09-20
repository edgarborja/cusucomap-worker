// PushTransport abstraction (architecture brief: "Initial implementation:
// TampermonkeyPushTransport. Future: BrowserExtensionPushTransport."). The
// worker builds the entire Web Push HTTP request itself (see
// services/push-sender.js) - this file's only job is getting that request
// actually sent, bypassing the CORS restriction plain page `fetch()` hits
// against push-service origins. What actually shipped instead of a browser
// extension is miniscord's own generic POST /http-relay (see its docs) -
// the same CORS-bypass-via-a-trusted-local-service pattern the rest of
// this migration already uses, rather than a privileged browser context.
// Swap in a different transport later by implementing the same
// `send({url, headers, body}) -> {ok, status, responseText}` shape.
export class MiniscordPushTransport {
  #miniscordConnector;

  /** @param {import("../connectors/miniscord-connector.js").MiniscordConnector} miniscordConnector */
  constructor({ miniscordConnector }) {
    this.#miniscordConnector = miniscordConnector;
  }

  /** For the dashboard's health row - there's no persistent bridge connection to actually check any more, so this is just "can a send even be attempted right now." */
  isBridgeConnected() {
    return this.#miniscordConnector.isConfigured();
  }

  /**
   * @param {{ url: string, headers: Record<string,string>, body: Uint8Array|string }} request
   * @returns {Promise<{ ok: boolean, status?: number, responseText?: string, error?: string }>}
   */
  send(request) {
    return this.#miniscordConnector.relay({ url: request.url, headers: request.headers, body: request.body });
  }
}
