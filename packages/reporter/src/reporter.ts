/**
 * A sink for human-facing progress messages emitted by operations.
 *
 * Operations in the capability packages take a `Reporter` so they can narrate
 * long-running work (rsync, clone, per-agent loops) without depending on the
 * CLI's logger. The CLI supplies a consola-backed implementation; tests supply
 * {@link collectingReporter}; anything headless supplies {@link silentReporter}.
 * The method names mirror the levels the CLI renders, so binding one to consola
 * is a direct pass-through.
 */
export interface Reporter {
  /** A step has begun (maps to consola's `start`). */
  start(message: string): void
  /** A step finished successfully. */
  success(message: string): void
  /** Neutral progress or a no-op outcome. */
  info(message: string): void
  /** A recoverable problem the user should see (a skip, a bounce). */
  warn(message: string): void
  /** A failure (a poll error, a port already in use). */
  error(message: string): void
}

/** One recorded call on a {@link collectingReporter}. */
export interface ReporterEvent {
  level: ReporterLevel
  message: string
}

export type ReporterLevel = keyof Reporter

/**
 * A `Reporter` that records every call instead of printing it, for assertions
 * in tests: `const { reporter, events } = collectingReporter()`.
 */
export function collectingReporter(): { reporter: Reporter; events: ReporterEvent[] } {
  const events: ReporterEvent[] = []
  const record =
    (level: ReporterLevel) =>
    (message: string): void => {
      events.push({ level, message })
    }
  return {
    events,
    reporter: {
      start: record('start'),
      success: record('success'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  }
}

/** A `Reporter` that discards every message — the default for headless callers. */
export const silentReporter: Reporter = {
  start: () => {},
  success: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
