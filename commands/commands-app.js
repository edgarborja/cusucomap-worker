// Talks to an already-running worker tab over the Nostr RPC channel (see
// worker/transports/rpc.js, and getAhkCommands/setAhkCommands in
// worker/worker-app.js) - reads/edits its scheduledSearches/dailyCommands
// lists. No build step, no bundler, same plain-DOM style as worker/
// worker-app.js. Values go into inputs via .value (never innerHTML string
// interpolation), which is what keeps arbitrary command text safe to
// display without any HTML-escaping of its own.
import { callRpc } from "../shared/rpc-client.js";

function nostrTools() {
  if (!window.NostrTools) throw new Error("NostrTools global not found - check the nostr.bundle.js <script> tag in index.html loaded before this file.");
  return window.NostrTools;
}

function parseLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Only ever written if the operator explicitly ticks "remember" below -
// same opt-in-only pattern as worker/core/config.js's SecretConfig (an
// NSEC is exactly as sensitive here as it is there). Reads are wrapped in
// try/catch (private-browsing/storage-disabled shouldn't break the page);
// writes aren't, matching that file's own convention.
const REMEMBER_KEY = "cusucomap-commands:remembered:v1";

function loadRemembered() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const remembered = loadRemembered();
if (remembered) {
  document.getElementById("field-nsec").value = remembered.nsec ?? "";
  document.getElementById("field-relays").value = remembered.relaysText ?? "";
  document.getElementById("field-remember").checked = true;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// Swaps `li` with whichever sibling sits in `direction` (-1 up, +1 down) -
// the only reordering UI this page needs.
function moveRow(li, direction) {
  const sibling = direction < 0 ? li.previousElementSibling : li.nextElementSibling;
  if (!sibling) return;
  if (direction < 0) li.parentElement.insertBefore(li, sibling);
  else li.parentElement.insertBefore(sibling, li);
}

function makeScheduledRow(message = "") {
  const li = document.createElement("li");
  li.className = "command-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "command-text";
  input.placeholder = "/pokesearch iv100";
  input.value = message;
  li.append(input, button("↑", () => moveRow(li, -1)), button("↓", () => moveRow(li, 1)), button("✕", () => li.remove()));
  return li;
}

function makeDailyRow({ message = "", hour = 0, minute = 0 } = {}) {
  const li = document.createElement("li");
  li.className = "command-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "command-text";
  input.placeholder = "/questset addchannel";
  input.value = message;
  const time = document.createElement("input");
  time.type = "time";
  time.className = "command-time";
  time.value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  li.append(input, time, button("✕", () => li.remove()));
  return li;
}

function renderScheduled(messages) {
  const list = document.getElementById("scheduled-list");
  list.innerHTML = "";
  for (const message of messages) list.append(makeScheduledRow(message));
}

function renderDaily(dailyCommands) {
  const list = document.getElementById("daily-list");
  list.innerHTML = "";
  for (const cmd of dailyCommands) list.append(makeDailyRow(cmd));
}

function readScheduled() {
  return [...document.querySelectorAll("#scheduled-list .command-text")].map((el) => el.value.trim()).filter(Boolean);
}

function readDaily() {
  return [...document.querySelectorAll("#daily-list .command-row")]
    .map((li) => {
      const message = li.querySelector(".command-text").value.trim();
      const [hourStr, minuteStr] = li.querySelector(".command-time").value.split(":");
      return { message, hour: Number(hourStr), minute: Number(minuteStr) };
    })
    .filter((cmd) => cmd.message && Number.isInteger(cmd.hour) && Number.isInteger(cmd.minute));
}

document.getElementById("add-scheduled").addEventListener("click", () => {
  document.getElementById("scheduled-list").append(makeScheduledRow());
});
document.getElementById("add-daily").addEventListener("click", () => {
  document.getElementById("daily-list").append(makeDailyRow());
});

// Set once Connect succeeds; reused by the Save button below.
let pool = null;
let relays = [];
let secretKey = null;
let pubkeyHex = null;

// Current page into the scan-subscribers list - see refreshScanSubscribers.
// Matches worker-app.js's own SCAN_SUBSCRIBERS_PAGE_SIZE; listScanSubscribers
// itself decides the actual page size, this is only used to step by one page.
const SCAN_SUBSCRIBERS_PAGE_SIZE = 20;
let scanSubscribersOffset = 0;

async function callSelf(method, params) {
  const response = await callRpc({ NT: nostrTools(), pool, relays, secretKey, pubkeyHex, method, params });
  if (!response.ok) throw new Error(response.error ?? `${method} failed`);
  return response;
}

document.getElementById("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById("connect-error");
  const statusEl = document.getElementById("connect-status");
  errorEl.hidden = true;

  const nsec = document.getElementById("field-nsec").value.trim();
  relays = parseLines(document.getElementById("field-relays").value);
  if (!nsec || relays.length === 0) {
    errorEl.textContent = "NSEC and at least one relay are required.";
    errorEl.hidden = false;
    return;
  }

  statusEl.textContent = "Connecting…";
  statusEl.hidden = false;
  try {
    const NT = nostrTools();
    const decoded = NT.nip19.decode(nsec);
    if (decoded.type !== "nsec") throw new Error("Not a valid nsec key.");
    secretKey = decoded.data;
    pubkeyHex = NT.getPublicKey(secretKey);
    pool = new NT.SimplePool({ enablePing: true, enableReconnect: true });

    const commands = await callSelf("getAhkCommands");

    if (document.getElementById("field-remember").checked) {
      localStorage.setItem(REMEMBER_KEY, JSON.stringify({ nsec, relaysText: document.getElementById("field-relays").value }));
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }

    document.getElementById("worker-npub").textContent = NT.nip19.npubEncode(pubkeyHex);
    document.getElementById("worker-npub").hidden = false;
    renderScheduled(commands.scheduledSearches);
    renderDaily(commands.dailyCommands);
    await refreshScanSubscribers(0);
    document.getElementById("connect-screen").hidden = true;
    document.getElementById("commands-screen").hidden = false;
  } catch (err) {
    errorEl.textContent = `Failed to connect: ${err.message}`;
    errorEl.hidden = false;
  } finally {
    statusEl.hidden = true;
  }
});

// Mirrors worker/core/area-scan.js's countAreaScanCircles - inlined here
// rather than imported since it's a one-line closed form (1 center + 6k
// points per ring, k=1..rings) and this page has no other reason to
// depend on that module (the actual lattice is computed worker-side, over
// runAreaScan - see worker-app.js).
function areaScanCircleCount(rings) {
  return 1 + 3 * rings * (rings + 1);
}

function updateAreaScanPreview() {
  const rings = Number(document.getElementById("area-scan-rings").value);
  const preview = document.getElementById("area-scan-preview");
  preview.textContent = Number.isInteger(rings) && rings >= 1 && rings <= 5 ? `${areaScanCircleCount(rings)} commands.` : "";
}
document.getElementById("area-scan-rings").addEventListener("input", updateAreaScanPreview);
updateAreaScanPreview();

document.getElementById("area-scan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById("area-scan-error");
  const statusEl = document.getElementById("area-scan-status");
  errorEl.hidden = true;

  const [latText, lonText] = document.getElementById("area-scan-center").value.trim().split(",").map((s) => s.trim());
  const centerLat = Number(latText);
  const centerLon = Number(lonText);
  const radiusKmText = document.getElementById("area-scan-radius").value.trim();
  const radiusKm = Number(radiusKmText);
  const rings = Number(document.getElementById("area-scan-rings").value);

  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    errorEl.textContent = 'Center point must be "lat,lon".';
    errorEl.hidden = false;
    return;
  }
  if (!radiusKmText || !Number.isFinite(radiusKm) || radiusKm <= 0) {
    errorEl.textContent = "Scan radius must be a positive number.";
    errorEl.hidden = false;
    return;
  }
  if (!Number.isInteger(rings) || rings < 1 || rings > 5) {
    errorEl.textContent = "Rings must be an integer from 1 to 5.";
    errorEl.hidden = false;
    return;
  }

  const total = areaScanCircleCount(rings);
  if (!confirm(`Start an area scan of ${total} commands? This takes priority over the worker's normal schedule until it finishes.`)) return;

  statusEl.textContent = "Starting…";
  statusEl.hidden = false;
  try {
    const result = await callSelf("runAreaScan", { centerLat, centerLon, radiusKmText, rings });
    statusEl.textContent = `Started - ${result.total} commands queued. Watch the worker's own activity log for progress.`;
  } catch (err) {
    statusEl.hidden = true;
    errorEl.textContent = `Failed to start: ${err.message}`;
    errorEl.hidden = false;
  }
});

// scansUsedToday/scansUsedDate are computed client-side against "today" for
// display only - the worker itself is the actual source of truth for
// whether a given request is still within quota (see worker-app.js's
// authorizeScanRequest), this is just so the operator doesn't have to
// mentally recompute a stale-looking count.
function scanSubscriberUsageText(sub) {
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = sub.scansUsedDate === today ? (sub.scansUsedToday ?? 0) : 0;
  const seenCount = sub.seenCount ?? 1;
  const limitText = sub.dailyLimit ? String(sub.dailyLimit) : "default";
  return `used today: ${usedToday}/${limitText} · seen ${seenCount}x`;
}

// A row's mere existence doesn't mean anything was ever granted - see
// worker/storage/indexeddb.js's own comment on checkScanSubscription's
// auto-discovery. Distinguishing the three states here (rather than just
// showing the raw date) is what makes "all known npubs" actually readable
// as a list to grant access from, per the original ask.
function scanSubscriberStatusLabel(sub) {
  if (!sub.activeUntil) return "not granted";
  return new Date(sub.activeUntil).getTime() >= Date.now() ? "active" : "expired";
}

function makeScanSubscriberRow(sub) {
  const li = document.createElement("li");
  li.className = "command-row";
  const npub = nostrTools().nip19.npubEncode(sub.pubkeyHex);

  const npubEl = document.createElement("span");
  npubEl.className = "command-text";
  npubEl.textContent = `${npub.slice(0, 16)}…`;
  npubEl.title = npub;

  const statusEl = document.createElement("span");
  statusEl.className = "hint";
  statusEl.textContent = scanSubscriberStatusLabel(sub);

  const untilEl = document.createElement("input");
  untilEl.type = "date";
  untilEl.value = (sub.activeUntil || "").slice(0, 10);
  untilEl.addEventListener("input", () => {
    statusEl.textContent = scanSubscriberStatusLabel({ activeUntil: untilEl.value });
  });

  const limitEl = document.createElement("input");
  limitEl.type = "number";
  limitEl.min = "1";
  limitEl.step = "1";
  limitEl.placeholder = "daily limit (default)";
  limitEl.value = sub.dailyLimit ?? "";

  const noteEl = document.createElement("input");
  noteEl.type = "text";
  noteEl.placeholder = "public tag (blank = anonymous code)";
  noteEl.value = sub.note || "";

  const usedEl = document.createElement("span");
  usedEl.className = "hint";
  usedEl.textContent = scanSubscriberUsageText(sub);

  function reportError(err) {
    const errorEl = document.getElementById("scan-subscribers-error");
    errorEl.textContent = `Failed: ${err.message}`;
    errorEl.hidden = false;
  }
  function reportSaved() {
    const statusEl = document.getElementById("scan-subscribers-status");
    statusEl.textContent = "Saved.";
    statusEl.hidden = false;
    setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  }

  const saveBtn = button("Save", async () => {
    document.getElementById("scan-subscribers-error").hidden = true;
    try {
      // limitEl.value is "" when the operator left/cleared it - that's
      // sent through as-is, which setScanSubscriber treats as "reset to
      // the fleet-wide default", not an error.
      await callSelf("setScanSubscriber", { npub, activeUntil: untilEl.value, note: noteEl.value, dailyLimit: limitEl.value });
      reportSaved();
    } catch (err) {
      reportError(err);
    }
  });
  const removeBtn = button("✕", async () => {
    document.getElementById("scan-subscribers-error").hidden = true;
    try {
      await callSelf("removeScanSubscriber", { npub });
      // Refreshes the current page rather than just li.remove() - removing
      // a row shifts the page's own total/boundaries (the next page's
      // first row now belongs on this one), which a purely local DOM
      // removal would leave the pager's own count/label stale about.
      await refreshScanSubscribers();
    } catch (err) {
      reportError(err);
    }
  });

  li.append(npubEl, statusEl, untilEl, limitEl, noteEl, usedEl, saveBtn, removeBtn);
  return li;
}

function renderScanSubscribers(subscribers) {
  const list = document.getElementById("scan-subscribers-list");
  list.innerHTML = "";
  for (const sub of subscribers) list.append(makeScanSubscriberRow(sub));
}

// Re-fetches and re-renders one page of the scan-subscribers list, and
// updates the pager's own label/button state - the single place every
// caller (initial connect, after add/save, Prev/Next) goes through, so
// scanSubscribersOffset and what's on screen can never drift apart.
async function refreshScanSubscribers(offset = scanSubscribersOffset) {
  scanSubscribersOffset = Math.max(0, offset);
  const result = await callSelf("listScanSubscribers", { offset: scanSubscribersOffset });
  renderScanSubscribers(result.subscribers);
  const total = result.total ?? result.subscribers.length;
  const from = total === 0 ? 0 : scanSubscribersOffset + 1;
  const to = scanSubscribersOffset + result.subscribers.length;
  document.getElementById("scan-subscribers-page-info").textContent = `${from}–${to} of ${total}`;
  document.getElementById("scan-subscribers-prev").disabled = scanSubscribersOffset === 0;
  document.getElementById("scan-subscribers-next").disabled = !result.hasMore;
}

document.getElementById("scan-subscribers-prev").addEventListener("click", () => {
  refreshScanSubscribers(scanSubscribersOffset - SCAN_SUBSCRIBERS_PAGE_SIZE);
});
document.getElementById("scan-subscribers-next").addEventListener("click", () => {
  refreshScanSubscribers(scanSubscribersOffset + SCAN_SUBSCRIBERS_PAGE_SIZE);
});

document.getElementById("add-scan-subscriber-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById("scan-subscribers-error");
  errorEl.hidden = true;

  const npubInput = document.getElementById("new-scan-subscriber-npub");
  const untilInput = document.getElementById("new-scan-subscriber-until");
  const limitInput = document.getElementById("new-scan-subscriber-limit");
  const noteInput = document.getElementById("new-scan-subscriber-note");
  const npub = npubInput.value.trim();
  const activeUntil = untilInput.value;
  const dailyLimit = limitInput.value;
  const note = noteInput.value.trim();
  if (!npub || !activeUntil) {
    errorEl.textContent = "npub and active-until date are required.";
    errorEl.hidden = false;
    return;
  }

  try {
    await callSelf("setScanSubscriber", { npub, activeUntil, dailyLimit, note });
    // Re-render the current page from the worker's own confirmed list, not
    // just this one addition - catches both a genuinely new row and an
    // update to an existing one (same npub) without needing to tell those
    // apart here. Stays on whatever page the operator was already viewing
    // rather than jumping back to the first one - the new/updated row may
    // not even land on this page, depending on where it now sorts.
    await refreshScanSubscribers();
    npubInput.value = "";
    untilInput.value = "";
    limitInput.value = "";
    noteInput.value = "";
    const statusEl = document.getElementById("scan-subscribers-status");
    statusEl.textContent = "Saved.";
    statusEl.hidden = false;
    setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  } catch (err) {
    errorEl.textContent = `Failed: ${err.message}`;
    errorEl.hidden = false;
  }
});

document.getElementById("save-button").addEventListener("click", async () => {
  const errorEl = document.getElementById("save-error");
  const statusEl = document.getElementById("save-status");
  errorEl.hidden = true;
  statusEl.textContent = "Saving…";
  statusEl.hidden = false;

  try {
    const result = await callSelf("setAhkCommands", { scheduledSearches: readScheduled(), dailyCommands: readDaily() });
    // Re-render from the worker's own confirmed state, not just what was
    // sent - it's the actual source of truth for what's now running.
    renderScheduled(result.scheduledSearches);
    renderDaily(result.dailyCommands);
    statusEl.textContent = "Saved.";
    setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  } catch (err) {
    statusEl.hidden = true;
    errorEl.textContent = `Failed to save: ${err.message}`;
    errorEl.hidden = false;
  }
});
