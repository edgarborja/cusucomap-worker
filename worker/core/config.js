// Operator configuration, split hard into two objects so it's structurally
// impossible to accidentally log/export secrets alongside public settings.
//
//   PublicConfig  - safe to print, screenshot, or paste into a bug report.
//   SecretConfig  - NSEC, VAPID private key. Never displayed once entered
//                   (see core/logging.js's redaction pass) and persisted to
//                   localStorage only if the operator explicitly ticks
//                   "remember secrets on this machine" on the start screen -
//                   the default is memory-only (cleared on reload, re-enter
//                   each time).
//
// This is a deliberate, visible choice per the operator, not a blanket
// policy - see worker/index.html's start screen for the checkbox and its
// warning copy.

const PUBLIC_KEY = "cusucomap-worker:public-config:v1";
const SECRET_KEY = "cusucomap-worker:secret-config:v1"; // only ever written if rememberSecrets is true

/**
 * @typedef {object} PublicConfig
 * @property {string[]} relays
 * @property {string[]} trackedChannelIds - Source Feed channel ids the bridge should scrape; pushed to the bridge over GM storage so one script install can watch any number of channels (see worker/connectors/source-feed-connector.js's #pushTrackedChannels).
 * @property {string} googleClientId - OAuth client id (Google's own docs: this is not secret, it's the audience).
 * @property {string} vapidPublicKey
 * @property {string} vapidContact - "mailto:you@example.com", required by the Web Push VAPID spec.
 * @property {boolean} rememberSecrets
 * @property {{lat:number, lon:number}} geofilterAnchor - disambiguation center for a quest/raid name shared by two POIs with no exact coordinates on hand.
 * @property {string} watchChannelName - channel id or name whose unread state (via miniscord's own GET /unread/{idOrName}) signals a hundo may have posted elsewhere (see worker/connectors/watch-channel-connector.js) - leave blank to disable.
 * @property {string} miniscordUrl - base URL of a running miniscord instance (e.g. "http://127.0.0.1:8770"), used for a subscriber's own "cusuco" area/species scan (see worker/connectors/miniscord-connector.js) - a direct REST call to miniscord's own POST /pokesearch, not a browser/AHK/Tampermonkey round trip. Empty means "not configured" - subscriber scans are rejected until this is set.
 */

/** @returns {PublicConfig} */
export function defaultPublicConfig() {
  return {
    relays: [],
    trackedChannelIds: [],
    googleClientId: "",
    vapidPublicKey: "",
    vapidContact: "mailto:example@example.com",
    rememberSecrets: false,
    watchChannelName: "",
    miniscordUrl: "",
    // Matches cusucomap-viewer's src/nostr-config.ts's DEFAULT_CENTER - the
    // tracked channel's own /geofilter setting at the time this default was
    // captured.
    geofilterAnchor: { lat: 13.675873, lon: -89.281163 },
  };
}

/**
 * Search scheduling config for worker-app.js's own miniscord-driven
 * scheduled loop and scan features - a REST call, no browser/AHK involved
 * (AHK itself has been fully retired). Deliberately NOT part of
 * PublicConfig/persisted to localStorage - there's no setup-screen field
 * that ever lets the operator edit this, so routing it through saved
 * config only meant a stale copy could silently outlive a code update
 * (the operator would have to redo the setup form, which happens to
 * regenerate this fresh, for a fix to actually take effect). Called
 * directly wherever needed instead, so it's just page code - a plain
 * reload always picks up the current value, no persistence layer involved.
 */
export function defaultSearchConfig() {
  return {
    // Each entry is a filter (no location of its own) - run through
    // miniscord with defaultSearchCenterLat/Lon/RadiusKmText below appended,
    // one at a time, resting batchRestMinMin/MaxMin between full passes.
    // Storage/editing goes through core/scheduled-searches.js (see
    // commands/commands-app.js) - this is just the fallback a worker that's
    // never had a list explicitly set yet falls back to, and what the seed
    // script publishes on first run.
    scheduledSearches: [
      "/pokesearch iv100",
      "/pokesearch iv95",
      "/pokesearch 0/0/0",
      "/pokesearch cp2500",
      "/pokesearch xxl",
      "/pokesearch unown",
      "/pokesearch audino",
      "/pokesearch azelf",
      "/pokesearch ditto",
      "/pokesearch lvl35",
      "/pokesearch lvl31 iv65",
    ],
    // Rest between full passes of scheduledSearches.
    batchRestMinMin: 2,
    batchRestMaxMin: 3,
    // How many area/species scans a single "cusuco" scan subscriber (see
    // worker-app.js's runAreaScan and the commands page's "Scan subscribers"
    // panel) can run per calendar day - shared across scan types, not one
    // allowance per type. Has no effect on the operator's own (self-pubkey)
    // scans, which are unlimited as today.
    scanDailyLimitPerSubscriber: 1,
    // The radius for a subscriber-requested area scan's one point - fixed
    // server-side, never something the caller supplies (see
    // worker-app.js's runAreaScan and area-scan.js's
    // buildSubscriberAreaScanCommand). A string, not a number: embedded
    // verbatim into the generated command text. Has no effect on the
    // operator's own (self-pubkey) scans, which still use the full
    // hex-lattice/rings design with their own radius as today.
    subscriberScanRadiusKmText: "0.1",
    // Fixed center/radius used wherever a pokesearch command submitted
    // through miniscord needs an explicit area but has no location of its
    // own to search around: every species scan (see species-scan.js's
    // buildSpeciesScanCommand, self and subscriber alike) and every
    // scheduled/priority-scan filter search (see worker-app.js) -
    // miniscord's own channel carries no ambient geofilter, unlike the
    // operator's tab, so without this those searches would cover the whole
    // world instead of just this map. Matches the tracked channel's own
    // former default /pokeset geofilter setting.
    defaultSearchCenterLat: 13.67744,
    defaultSearchCenterLon: -89.283353,
    defaultSearchRadiusKmText: "10",
  };
}

/**
 * @typedef {object} SecretConfig
 * @property {string} nsec
 * @property {string} vapidPrivateKey
 * @property {string} fcmServiceAccountJson - the full contents of a Firebase Admin SDK service-account JSON key file (as text, pasted as-is) - used to send push notifications to the Android wrapper app via FCM's HTTP v1 API. Same never-logged, memory-unless-remembered treatment as nsec/vapidPrivateKey (see worker/index.html's setup screen). Parsed lazily where needed (see worker-app.js's getFcmConfig) rather than here, so a paste error just fails that parse instead of this module.
 */

export function defaultSecretConfig() {
  return { nsec: "", vapidPrivateKey: "", fcmServiceAccountJson: "" };
}

export function loadPublicConfig() {
  try {
    const raw = localStorage.getItem(PUBLIC_KEY);
    return raw ? { ...defaultPublicConfig(), ...JSON.parse(raw) } : defaultPublicConfig();
  } catch {
    return defaultPublicConfig();
  }
}

export function savePublicConfig(config) {
  localStorage.setItem(PUBLIC_KEY, JSON.stringify(config));
}

/** Secrets are only ever read from localStorage if a previous session opted in. */
export function loadSecretConfig() {
  try {
    const raw = localStorage.getItem(SECRET_KEY);
    return raw ? { ...defaultSecretConfig(), ...JSON.parse(raw) } : defaultSecretConfig();
  } catch {
    return defaultSecretConfig();
  }
}

/** Only call this when the operator has explicitly opted into on-disk persistence. */
export function saveSecretConfig(secrets) {
  localStorage.setItem(SECRET_KEY, JSON.stringify(secrets));
}

export function clearPersistedSecrets() {
  localStorage.removeItem(SECRET_KEY);
}
