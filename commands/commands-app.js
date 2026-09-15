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
