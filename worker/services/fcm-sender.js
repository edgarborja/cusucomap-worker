// Builds and sends FCM (Firebase Cloud Messaging) HTTP v1 API requests
// using a Firebase Admin SDK service-account credential - pure Web Crypto,
// no `firebase-admin`/Node dependency, matching push-sender.js's "no SDK,
// build the wire protocol from scratch" approach for Web Push. Unlike Web
// Push, FCM needs two network calls: a service-account JWT-bearer OAuth2
// token exchange (Google's own token endpoint), then the actual v1 send -
// both go through the same Tampermonkey bridge Web Push already uses (see
// transports/push-transport.js) to get around CORS, just to a different
// pair of allowlisted origins (see worker-bridge/
// cusuco-worker-companion.user.js's isAllowedPushRequest). That's why this
// file takes a `sendViaBridge` function rather than importing a transport
// directly - it needs to drive two sequential bridge calls itself, not
// just build one request object for the caller to send (push-sender.js's
// shape), but should stay just as decoupled from any specific transport.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
// Refresh a bit before the token's own expiry (Google's tokens are
// typically valid 3600s) rather than right at the edge, so a send that
// starts just before expiry doesn't get a token that dies mid-flight.
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes a PEM-encoded PKCS8 private key (a service account JSON's `private_key` field, as-is) to raw DER bytes. */
function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Keyed by client_email so a service-account change (operator pastes a
// different key) doesn't keep using a stale cached token for the old one.
let cachedToken = null; // { accessToken, forClientEmail, expiresAtMs }

/**
 * Signs a JWT-bearer assertion with the service account's own private key
 * and exchanges it for a short-lived OAuth2 access token scoped to FCM -
 * cached in memory until shortly before it expires, since a fresh exchange
 * costs a whole extra round trip this bridge doesn't need per-notification.
 * @param {{client_email: string, private_key: string}} serviceAccount
 * @param {(request: {url: string, headers: Record<string,string>, body: string}) => Promise<{ok: boolean, status?: number, responseText?: string, error?: string}>} sendViaBridge
 */
async function getAccessToken(serviceAccount, sendViaBridge) {
  if (cachedToken && cachedToken.forClientEmail === serviceAccount.client_email && Date.now() < cachedToken.expiresAtMs) {
    return cachedToken.accessToken;
  }

  const privateKey = await crypto.subtle.importKey("pkcs8", pemToDer(serviceAccount.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);

  const nowS = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: serviceAccount.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: nowS, exp: nowS + 3600 };
  const encoder = new TextEncoder();
  const signingInput = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(signingInput)));
  const assertion = `${signingInput}.${base64UrlEncode(signature)}`;

  const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`;
  const result = await sendViaBridge({ url: TOKEN_URL, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!result.ok) throw new Error(`FCM token exchange failed: ${result.error ?? `HTTP ${result.status}: ${result.responseText ?? ""}`}`);

  const parsed = JSON.parse(result.responseText);
  cachedToken = {
    accessToken: parsed.access_token,
    forClientEmail: serviceAccount.client_email,
    expiresAtMs: Date.now() + (parsed.expires_in ?? 3600) * 1000 - TOKEN_REFRESH_SKEW_MS,
  };
  return cachedToken.accessToken;
}

/**
 * Sends one FCM v1 message to a single registration token. Always includes
 * a `notification` block (not data-only) so Android shows a tray
 * notification by default when the app is backgrounded/killed - matching
 * how Web Push already behaves (see notifications.js's #sendWebPush). The
 * same content also goes into `data`, string-coerced (FCM's data payload
 * values must all be strings), for the app to read if it wants richer
 * in-app handling than the default tray notification.
 * @param {{project_id: string, client_email: string, private_key: string}} serviceAccount - the parsed Firebase Admin SDK service-account JSON.
 * @param {string} token - the device's FCM registration token.
 * @param {{ title: string, body: string, icon?: string|null, tag?: string, url?: string, entityType?: string, entityId?: unknown }} payload - same shape notifications.js already builds for Web Push.
 * @param {(request: {url: string, headers: Record<string,string>, body: string}) => Promise<{ok: boolean, status?: number, responseText?: string, error?: string}>} sendViaBridge
 * @returns {Promise<{ ok: boolean, status?: number, invalidToken?: boolean, error?: string }>}
 */
export async function sendFcmMessage(serviceAccount, token, payload, sendViaBridge) {
  const accessToken = await getAccessToken(serviceAccount, sendViaBridge);

  const message = {
    token,
    notification: {
      title: payload.title,
      body: payload.body,
      ...(payload.icon ? { image: payload.icon } : {}),
    },
    data: {
      ...(payload.url ? { url: String(payload.url) } : {}),
      ...(payload.entityType ? { entityType: String(payload.entityType) } : {}),
      ...(payload.entityId !== undefined ? { entityId: String(payload.entityId) } : {}),
    },
    // Mirrors Web Push's tag: replaces a prior notification for the same
    // entity instead of stacking a new one.
    ...(payload.tag ? { android: { notification: { tag: String(payload.tag) } } } : {}),
  };

  const result = await sendViaBridge({
    url: `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (result.ok) return { ok: true, status: result.status };
  // FCM v1's invalid-registration-token response is HTTP 404 (body status
  // "NOT_FOUND", errorCode "UNREGISTERED") - same HTTP code Web Push
  // endpoints use for the equivalent "this endpoint is gone" case (see
  // notifications.js's existing cleanup), checked the same simple way
  // (status only) rather than parsing the error body.
  return { ok: false, status: result.status, invalidToken: result.status === 404, error: result.error ?? result.responseText };
}
