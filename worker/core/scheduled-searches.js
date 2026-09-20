// Persists the miniscord-driven scheduled search loop's own filter list
// (see worker-app.js's runMiniscordScheduledBatch) - what's left of
// AhkConnector's old getCommands/applyCommands once daily commands (the
// other half of that store) retired along with AHK itself. Keeps the same
// workerMetadata key an operator's already-configured list was stored
// under, so nothing is lost by this split - a stale dailyCommands field
// left over in that stored blob from before is simply never read again.
const STORAGE_KEY = "ahkCommandsConfig";

/** @returns {string | null} a human-readable problem, or null if valid. */
export function validateScheduledSearches(scheduledSearches) {
  if (!Array.isArray(scheduledSearches) || scheduledSearches.length === 0 || scheduledSearches.some((m) => typeof m !== "string" || m.trim() === "")) {
    return "scheduledSearches must be a non-empty array of non-empty strings.";
  }
  return null;
}

/** @param {string[]} fallback - used until anything's ever been explicitly set. */
export async function loadScheduledSearches(state, fallback) {
  const persisted = await state.workerMetadata.get(STORAGE_KEY, null);
  return persisted && Array.isArray(persisted.scheduledSearches) ? persisted.scheduledSearches : fallback;
}

export async function saveScheduledSearches(state, scheduledSearches) {
  await state.workerMetadata.set(STORAGE_KEY, { scheduledSearches });
}
