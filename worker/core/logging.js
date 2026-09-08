// Central activity log for the dashboard (a ring buffer, not IndexedDB - it
// resets on reload by design, since it's operational noise, not
// authoritative state) plus a redaction pass so a secret can never reach it
// even if a caller passes one in by mistake.

const MAX_ENTRIES = 300;
// Defense in depth against `logger.info("...", { nsec })`-style mistakes -
// scans stringified args for anything that looks like an nsec and masks it,
// on top of every call site being expected not to pass raw secrets at all.
const NSEC_RE = /nsec1[a-z0-9]{20,}/gi;

function sanitize(text) {
  return text.replace(NSEC_RE, (m) => `${m.slice(0, 10)}…[redacted]`);
}

/** @typedef {{ at: number, level: "info"|"warn"|"error", scope: string, message: string }} LogEntry */

export class Logger {
  /** @type {LogEntry[]} */
  entries = [];
  #bus;

  constructor(eventBus) {
    this.#bus = eventBus;
  }

  #push(level, scope, message) {
    const clean = sanitize(String(message));
    const entry = { at: Date.now(), level, scope, message: clean };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(`[${scope}]`, clean);
    this.#bus?.emit("log.entry", entry);
  }

  info(scope, message) {
    this.#push("info", scope, message);
  }
  warn(scope, message) {
    this.#push("warn", scope, message);
  }
  error(scope, message) {
    this.#push("error", scope, message);
  }
}
