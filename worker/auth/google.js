// Verifies a Google ID token entirely worker-side with Web Crypto - no
// google-auth-library (that's a Node package), no trusting the viewer's own
// parse of the JWT payload. A viewer sending its raw ID token over the RPC
// channel (see services/accounts.js's "linkGoogleAccount" handler) is
// necessary but not sufficient; this is what actually establishes trust.
//
// Checks performed, per Google's own token-verification requirements
// (https://developers.google.com/identity/sign-in/web/backend-auth -
// referenced from memory, not fetched - verify against Google's current
// docs before relying on this in production): signature (RS256, against
// Google's published JWKS), issuer, audience, expiry, and issued-at sanity.
// The stable `sub` claim - never `email` - is what accounts.js uses as the
// external identity key.

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;

let cachedJwks = null;
let cachedJwksExpiresAt = 0;

function base64UrlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

function base64UrlToBytes(str) {
  return Uint8Array.from(base64UrlDecode(str), (c) => c.charCodeAt(0));
}

async function fetchJwks() {
  if (cachedJwks && Date.now() < cachedJwksExpiresAt) return cachedJwks;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google JWKS: HTTP ${res.status}`);
  const body = await res.json();
  // Google sends a Cache-Control max-age; honor it but clamp so a
  // misconfigured/huge value can't pin a revoked key forever.
  const cacheControl = res.headers.get("cache-control") ?? "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Math.min(Number(maxAgeMatch[1]) * 1000, 24 * 60 * 60 * 1000) : 60 * 60 * 1000;
  cachedJwks = body.keys;
  cachedJwksExpiresAt = Date.now() + maxAgeMs;
  return cachedJwks;
}

/**
 * @param {string} idToken - raw Google ID token (JWT) from Google Identity Services.
 * @param {string} expectedClientId - the operator's configured OAuth client id (aud).
 * @returns {Promise<{ sub: string, email: string|null, emailVerified: boolean, name: string|null }>}
 * @throws if the token is malformed, unsigned by a known Google key, expired, or has the wrong issuer/audience.
 */
export async function verifyGoogleIdToken(idToken, expectedClientId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token (expected 3 JWT segments).");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));
  if (header.alg !== "RS256") throw new Error(`Unexpected JWT alg "${header.alg}" (expected RS256).`);

  const jwks = await fetchJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`No matching Google JWKS key for kid "${header.kid}" (keys may have rotated - retry).`);

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, base64UrlToBytes(signatureB64), signedData);
  if (!valid) throw new Error("ID token signature verification failed.");

  const now = Math.floor(Date.now() / 1000);
  if (!VALID_ISSUERS.has(payload.iss)) throw new Error(`Unexpected issuer "${payload.iss}".`);
  if (payload.aud !== expectedClientId) throw new Error("Token audience does not match configured Google client id.");
  if (typeof payload.exp !== "number" || now > payload.exp + CLOCK_SKEW_SECONDS) throw new Error("Token is expired.");
  if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS) throw new Error("Token issued-at is in the future.");
  if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("Token has no subject (sub) claim.");

  return {
    sub: payload.sub,
    email: payload.email ?? null,
    emailVerified: Boolean(payload.email_verified),
    name: payload.name ?? null,
  };
}
