// Page-side half of the Tampermonkey bridge protocol. A Tampermonkey
// userscript's content-script world is isolated from this page's own
// scripts, so the only way for a bridge script to hand data to worker-app.js
// (or vice versa) *within the same tab* is a same-document CustomEvent -
// this module is just a small typed wrapper around that.
//
// Getting data *into* this tab from the separate source-feed tab is a
// second, unrelated hop (Tampermonkey's GM_setValue storage, shared across
// every domain a script @matches, used as a cross-tab queue) that happens
// entirely inside a single companion .user.js script before it ever reaches
// this module - see worker-bridge/README.md for why that script isn't
// committed in this repo (it's the one piece that has to name the real
// scraped platform via its own @match/DOM selectors); ask the operator for
// its current Gist URL.
//
// Event names are a manually-kept-in-sync contract with that script (no
// shared import is possible - Tampermonkey scripts have no bundler, same
// reasoning as userscript/parser.js's mirrored-by-hand convention elsewhere
// in this repo). Change a name here AND there.
export const BRIDGE_EVENTS = {
  // Bridge -> page: a raw Source Feed message was scraped.
  SOURCE_FEED_MESSAGE: "cusuco-worker-bridge:v1:source-feed-message",
  // Bridge -> page: connectivity/status of the Source Feed-tab half of the bridge.
  SOURCE_FEED_BRIDGE_STATUS: "cusuco-worker-bridge:v1:source-feed-bridge-status",
  // Page -> bridge: the full list of Source Feed channel ids to scrape - the
  // bridge script itself has no hardcoded channel, so any Source Feed tab
  // matching this script decides whether it's "on" a tracked channel purely
  // from whatever list it last received here (persisted bridge-side via GM
  // storage, so a Source Feed tab opened before the worker ever sent this still
  // picks up the last-known list instead of starting with none).
  SET_TRACKED_CHANNEL_IDS: "cusuco-worker-bridge:v1:set-tracked-channel-ids",
};
// Retired, worker-side unused as of this comment (each superseded by a
// miniscord-based replacement - watch-channel polling, the generic
// /http-relay push transport, and AHK's own full retirement): the
// companion script may still emit/handle SET_WATCH_CHANNEL_NAME,
// WATCH_CHANNEL_ALERT, AHK_SEND_COMMAND, AHK_SEND_RESULT,
// PUSH_SEND_REQUEST, PUSH_SEND_RESULT, PUSH_BRIDGE_PING, and
// PUSH_BRIDGE_PONG on its own side, but nothing here listens for or sends
// them any more - worth pruning there too next time that script gets
// touched.

/**
 * Thin CustomEvent pub/sub, scoped to `window` so it works regardless of
 * which DOM node the bridge script happens to dispatch/listen on.
 */
export const bridgeChannel = {
  send(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  },
  /** @returns {() => void} unsubscribe function */
  on(type, handler) {
    const listener = (event) => handler(event.detail);
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
  },
};
