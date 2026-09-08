// Small synchronous pub/sub bus so connectors, ApplicationState, the
// notification engine, and the Nostr publisher don't call each other
// directly. Naming convention: "<noun>.<verb>" - connectors emit
// "*.observed" (raw-ish, not yet authoritative), services that own
// authoritative state emit "*.created"/"*.updated"/"*.expired" once they've
// decided something actually changed. See worker/services/pokemon-state.js
// for the concrete example.
export class EventBus {
  #listeners = new Map();

  /** @returns {() => void} unsubscribe function */
  on(topic, handler) {
    if (!this.#listeners.has(topic)) this.#listeners.set(topic, new Set());
    this.#listeners.get(topic).add(handler);
    return () => this.#listeners.get(topic)?.delete(handler);
  }

  emit(topic, payload) {
    const handlers = this.#listeners.get(topic);
    if (!handlers) return;
    // Copy before iterating: a handler unsubscribing itself (or another
    // handler of the same topic) mid-emit must not skip/crash on a mutated
    // Set being iterated.
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[event-bus] handler for "${topic}" threw:`, err);
      }
    }
  }
}
