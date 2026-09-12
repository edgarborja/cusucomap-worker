// Generic caller for the worker's Nostr RPC channel (see PROTOCOL.md's RPC
// section, kinds 29500/29501) - the half that, per that document, "isn't
// implemented yet." Only the worker's own *receiving* side (worker/
// transports/rpc.js) existed before this file.
//
// Deliberately runtime-agnostic: takes an already-constructed `NT`
// (nostr-tools' exports) and `pool` (a SimplePool instance) rather than
// importing nostr-tools itself, so the exact same logic works from a
// browser page loading the pinned CDN bundle (window.NostrTools, see
// worker/index.html) and from a plain Node script using the npm package
// (see tools/set-ahk-commands.mjs) - the two environments load the library
// completely differently, but its exported shape is identical either way.
//
// Built specifically for *self*-RPC: a caller who holds the worker's own
// nsec, calling a method the worker only accepts from itself (see
// worker-app.js's getAhkCommands/setAhkCommands handlers) - `pubkeyHex` is
// used both as the encryption recipient and as the "#p" filter for the
// response, since for this use case sender and recipient are the same
// identity. Not meant as a general viewer-facing RPC client.
import { KIND_RPC_REQUEST, KIND_RPC_RESPONSE, encodeRpcRequest } from "./nostr-protocol.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {object} args
 * @param {object} args.NT - nostr-tools' exports (window.NostrTools in the browser, `import * as NT from "nostr-tools"` in Node).
 * @param {object} args.pool - a NT.SimplePool instance, already open.
 * @param {string[]} args.relays
 * @param {Uint8Array} args.secretKey - decoded nsec bytes (NT.nip19.decode(nsec).data).
 * @param {string} args.pubkeyHex - the worker's own pubkey hex (both sender and recipient - see header comment).
 * @param {string} args.method
 * @param {unknown} [args.params]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<unknown>} the RPC result on success; throws on an error response or timeout.
 */
export function callRpc({ NT, pool, relays, secretKey, pubkeyHex, method, params, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const conversationKey = NT.nip44.v2.utils.getConversationKey(secretKey, pubkeyHex);

    let settled = false;
    let closer = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      closer?.close();
      reject(new Error(`RPC "${method}" timed out after ${timeoutMs}ms - is the worker tab open and connected?`));
    }, timeoutMs);

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closer?.close();
      fn();
    }

    closer = pool.subscribeMany(
      relays,
      { kinds: [KIND_RPC_RESPONSE], "#p": [pubkeyHex] },
      {
        onevent: (event) => {
          let envelope;
          try {
            const plaintext = NT.nip44.v2.decrypt(event.content, conversationKey);
            envelope = JSON.parse(plaintext);
          } catch {
            return; // not decryptable with our key, or malformed - not our response
          }
          if (envelope.id !== id) return; // some other in-flight call's response
          finish(() => (envelope.ok ? resolve(envelope.result) : reject(new Error(envelope.error ?? "RPC call failed"))));
        },
      }
    );

    const requestEnvelope = encodeRpcRequest(id, method, params);
    const ciphertext = NT.nip44.v2.encrypt(JSON.stringify(requestEnvelope), conversationKey);
    const event = NT.finalizeEvent({ kind: KIND_RPC_REQUEST, created_at: Math.floor(Date.now() / 1000), tags: [["p", pubkeyHex]], content: ciphertext }, secretKey);
    Promise.allSettled(pool.publish(relays, event)).then((settledPublishes) => {
      const ok = settledPublishes.some((r) => r.status === "fulfilled");
      if (!ok) finish(() => reject(new Error(`Failed to publish RPC request "${method}" to any relay.`)));
    });
  });
}
