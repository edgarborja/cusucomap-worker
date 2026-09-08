// Canonical Nostr wire contract for the CusucoMap ApplicationWorker.
//
// The entity kinds/tag shape below are DELIBERATELY identical to
// cusucomap-viewer's src/nostr-contract.ts + cusucomap-viewer's src/nostr-config.ts (which this
// file does not import, since those are .ts and the worker has no build
// step) - the existing, unmodified CusucoMap viewer must keep working
// against events published by the new worker with zero viewer changes.
// If you change KIND_SPAWN/KIND_QUEST/KIND_RAID or the d/expiration tag
// shape here, the viewer breaks until it's updated too.

/** @typedef {31500|31501|31502} EntityKind */
export const KIND_SPAWN = 31500;
export const KIND_QUEST = 31501;
export const KIND_RAID = 31502;

// New kinds this worker introduces. Picked away from KIND_SPAWN/QUEST/RAID
// and from NIP-assigned ranges. RPC request/response use the "ephemeral"
// range (20000-29999, NIP-01) - relays are told not to store these, which is
// correct for a request/response call that's meaningless after it's
// answered (unlike spawns/quests/raids, which are addressable/replaceable
// because the *latest* one IS the current state).
export const KIND_RPC_REQUEST = 29500;
export const KIND_RPC_RESPONSE = 29501;

// Addressable (NIP-33) - one per (kind, pubkey, d) triple, latest wins.
// Worker metadata/presence, published periodically so a viewer can show
// "worker last seen Ns ago" without needing a request/response round trip.
export const KIND_WORKER_STATUS = 31503;

export const PROTOCOL_VERSION = 1;

/**
 * wss:// relay URLs. Mirrors cusucomap-viewer's src/nostr-config.ts's RELAYS - keep in
 * sync by hand (no shared build step between the worker and the frontend).
 */
export const RELAYS = ["wss://relay.snort.social", "wss://nos.lol", "wss://relay.k1.sv"];

/**
 * Hex pubkey(s) the *viewer* currently trusts (cusucomap-viewer's src/nostr-config.ts's
 * PUBKEYS_HEX). The worker's own NSEC (entered at Start Worker time, never
 * hardcoded here) should derive to one of these for the existing viewer to
 * accept its spawn/quest/raid events - the dashboard warns if it doesn't.
 */
export const TRUSTED_VIEWER_PUBKEYS_HEX = ["c721cc68a699b5a7bde08cf5e5407692079bf4292a525a3f552219fb7cc82225"];

function expirationSeconds(expiresAtIso) {
  return Math.floor(new Date(expiresAtIso).getTime() / 1000);
}

/**
 * Builds the addressable/replaceable event template for an entity (spawn,
 * quest, or raid). Identical shape to nostr-contract.ts's buildEventTemplate.
 * @param {EntityKind} kind
 * @param {string|number} id - becomes the `d` tag (entity identity).
 * @param {string} expiresAtIso
 * @param {unknown} entity - JSON-serializable content.
 */
export function buildEntityEventTemplate(kind, id, expiresAtIso, entity, createdAt = Math.floor(Date.now() / 1000)) {
  return {
    kind,
    created_at: createdAt,
    tags: [
      ["d", String(id)],
      ["expiration", String(expirationSeconds(expiresAtIso))],
    ],
    content: JSON.stringify(entity),
  };
}

export function dTag(event) {
  return event.tags.find((tag) => tag[0] === "d")?.[1] ?? null;
}

/**
 * RPC request/response envelope, JSON-encoded then NIP-44 encrypted (see
 * worker/transports/rpc.js). `v` lets a future protocol change be detected
 * instead of silently misinterpreted.
 * Request:  { v, id, method, params }
 * Response: { v, id, ok, result } | { v, id, ok: false, error }
 */
export function encodeRpcRequest(id, method, params) {
  return { v: PROTOCOL_VERSION, id, method, params };
}

export function encodeRpcResult(id, result) {
  return { v: PROTOCOL_VERSION, id, ok: true, result };
}

export function encodeRpcError(id, message) {
  return { v: PROTOCOL_VERSION, id, ok: false, error: message };
}
