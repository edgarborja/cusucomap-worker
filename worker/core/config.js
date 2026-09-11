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
 * @property {string} watchChannelName - sidebar dnd-name of the channel whose unread badge signals a hundo may have posted elsewhere (see worker/connectors/watch-channel-connector.js); pushed to the bridge the same way trackedChannelIds is.
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
    // Matches cusucomap-viewer's src/nostr-config.ts's DEFAULT_CENTER - the
    // tracked channel's own /geofilter setting at the time this default was
    // captured.
    geofilterAnchor: { lat: 13.675873, lon: -89.281163 },
  };
}

/**
 * AutoHotKey connector scheduling config. Deliberately NOT part of
 * PublicConfig/persisted to localStorage - there's no setup-screen field
 * that ever lets the operator edit this, so routing it through saved
 * config only meant a stale copy could silently outlive a code update
 * (the operator would have to redo the setup form, which happens to
 * regenerate this fresh, for a fix to actually take effect). Called
 * directly wherever needed instead, so it's just page code - a plain
 * reload always picks up the current value, no persistence layer involved.
 */
export function defaultAhkConfig() {
  return {
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
    searchPauseMinS: 8,
    searchPauseMaxS: 15,
    batchRestMinMin: 2,
    batchRestMaxMin: 3,
    dailyCommands: [
      { label: "questset addchannel", targetHour: 23, jitterMinutes: 15, message: "/questset addchannel" },
      { label: "raidset addchannel", targetHour: 4, jitterMinutes: 15, message: "/raidset addchannel" },
    ],
    // Sent immediately (not on the usual schedule) when the watch channel's
    // unread badge fires, before the scheduledSearches rotation above
    // resumes on its own - just the one hundo search, not the full 11-item
    // rotation, so the clear-unread hotkey below doesn't sit behind several
    // unrelated searches before it can fire.
    priorityScanMessages: ["/pokesearch iv100"],
    priorityScanPauseMinS: 3,
    priorityScanPauseMaxS: 6,
    // AHK key notation (see worker-bridge/http_send.ahk's Send call) for whatever combo
    // marks every channel read - sent as one queued item via the "#HOTKEY# "
    // sentinel, after the priority scan above finishes.
    clearUnreadHotkey: "+{Escape}",
  };
}

/**
 * @typedef {object} SecretConfig
 * @property {string} nsec
 * @property {string} vapidPrivateKey
 */

export function defaultSecretConfig() {
  return { nsec: "", vapidPrivateKey: "" };
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
