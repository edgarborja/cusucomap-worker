// Builds a standard Web Push HTTP request entirely with Web Crypto - no
// Node, no `web-push` npm package. VAPID keys are the standard P-256
// keypair format that package's own `web-push generate-vapid-keys` CLI (or
// any equivalent tool) produces; the actual encrypt-and-sign work here is a
// from-scratch port of RFC 8291 (message encryption, "aes128gcm") and
// RFC 8292 (VAPID).
//
// Verified so far (see /tmp scratchpad self-test run during development,
// not checked into the repo): the HKDF primitives match the RFC 5869 test
// vectors exactly, and a full encrypt round-trip - this file's
// createWebPushRequest() output, decrypted by an independently-written
// receiver-side implementation of the same RFC 8291 derivation - decodes
// back to the original JSON payload with a verified VAPID JWT signature.
// NOT yet exercised against a real push service (no network egress from
// where this was written) - treat the first real send against FCM/Mozilla/
// Apple's push endpoints as the remaining test. If that fails, the most
// likely culprit is a push-service-specific quirk (e.g. TTL/Topic header
// expectations) rather than the encryption math itself.

function base64UrlToBytes(b64url) {
  const padded = b64url + "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

/** RFC 5869 HKDF-Extract. */
function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

/** RFC 5869 HKDF-Expand, single- or multi-block as needed for `length` bytes. */
async function hkdfExpand(prk, info, length) {
  const hashLen = 32;
  const blocks = Math.ceil(length / hashLen);
  let previous = new Uint8Array(0);
  const chunks = [];
  for (let i = 1; i <= blocks; i++) {
    previous = await hmacSha256(prk, concatBytes(previous, info, new Uint8Array([i])));
    chunks.push(previous);
  }
  return concatBytes(...chunks).slice(0, length);
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, length);
}

function jwkFromRawP256(privateKeyBytes, publicKeyBytes) {
  // publicKeyBytes is the uncompressed point (0x04 || X(32) || Y(32)),
  // exactly the shape `web-push`'s generateVAPIDKeys() (or any equivalent
  // VAPID keypair generator) produces for VAPID_PUBLIC_KEY.
  return {
    kty: "EC",
    crv: "P-256",
    d: bytesToBase64Url(privateKeyBytes),
    x: bytesToBase64Url(publicKeyBytes.slice(1, 33)),
    y: bytesToBase64Url(publicKeyBytes.slice(33, 65)),
    ext: true,
  };
}

/** Builds and signs the VAPID JWT (RFC 8292) for a push request to `endpoint`. */
async function buildVapidHeader({ endpoint, vapidPublicKey, vapidPrivateKey, contact }) {
  const publicKeyBytes = base64UrlToBytes(vapidPublicKey);
  const privateKeyBytes = base64UrlToBytes(vapidPrivateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwkFromRawP256(privateKeyBytes, publicKeyBytes),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // spec max is 24h; 12h leaves headroom
    sub: contact,
  };
  const encoder = new TextEncoder();
  const signingInput = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(encoder.encode(JSON.stringify(payload)))}`;
  // Web Crypto's ECDSA signature output is already raw (r || s), which is
  // exactly what a JWS ES256 signature needs - unlike e.g. Node's `crypto`
  // module, which defaults to DER and would need re-encoding here.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(signingInput))
  );
  const jwt = `${signingInput}.${bytesToBase64Url(signature)}`;
  return { Authorization: `vapid t=${jwt}, k=${vapidPublicKey}` };
}

/** RFC 8291 message encryption ("aes128gcm" content encoding, RFC 8188). */
async function encryptAes128gcm({ payloadBytes, p256dhBase64, authBase64 }) {
  const uaPublicKeyBytes = base64UrlToBytes(p256dhBase64);
  const authSecret = base64UrlToBytes(authBase64);

  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));
  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicKeyBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256)
  );

  const encoder = new TextEncoder();
  // RFC 8291 section 3.3/3.4: combine the ECDH secret with the subscriber's
  // authentication secret, bound to both public keys, into a single IKM;
  // then run the standard RFC 8188 aes128gcm key derivation against a fresh
  // random salt on top of that.
  const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), uaPublicKeyBytes, asPublicKeyBytes);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, encoder.encode("Content-Encoding: nonce\0"), 12);

  // Single-record message: delimiter 0x02 marks it as the (only) last
  // record. No further padding - payloads here are small JSON notification
  // bodies, not something where traffic-analysis padding matters.
  const record = concatBytes(payloadBytes, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  const recordSize = ciphertext.length; // one record; rs just needs to cover it
  const header = concatBytes(
    salt,
    new Uint8Array([(recordSize >>> 24) & 0xff, (recordSize >>> 16) & 0xff, (recordSize >>> 8) & 0xff, recordSize & 0xff]),
    new Uint8Array([asPublicKeyBytes.length]),
    asPublicKeyBytes
  );
  return concatBytes(header, ciphertext);
}

/**
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {{ title: string, body: string, [k: string]: unknown }} payload
 * @param {{ vapidPublicKey: string, vapidPrivateKey: string, contact: string, ttlSeconds?: number }} vapid
 * @returns {Promise<{ url: string, headers: Record<string,string>, body: Uint8Array }>}
 */
export async function createWebPushRequest(subscription, payload, vapid) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const body = await encryptAes128gcm({ payloadBytes, p256dhBase64: subscription.keys.p256dh, authBase64: subscription.keys.auth });
  const vapidHeaders = await buildVapidHeader({ endpoint: subscription.endpoint, ...vapid });
  return {
    url: subscription.endpoint,
    headers: {
      ...vapidHeaders,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(vapid.ttlSeconds ?? 60 * 60 * 12),
    },
    body,
  };
}
