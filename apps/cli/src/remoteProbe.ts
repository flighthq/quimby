const DEFAULT_REMOTE_PROBE_TIMEOUT_MS = 5_000

export interface RemoteProbeResult<T> {
  value: T
  timedOut: boolean
}

export function remoteProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QUIMBY_REMOTE_PROBE_TIMEOUT_MS ?? env.QUIMBY_REMOTE_STATUS_TIMEOUT_MS
  if (!raw) return DEFAULT_REMOTE_PROBE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REMOTE_PROBE_TIMEOUT_MS
}

export async function withRemoteProbeTimeout<T>(
  probe: Promise<T>,
  fallback: T,
  opts: { timeoutMs?: number } = {},
): Promise<RemoteProbeResult<T>> {
  const timeoutMs = opts.timeoutMs ?? remoteProbeTimeoutMs()
  if (timeoutMs === 0) {
    return { value: await probe, timedOut: false }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe.then((value) => ({ value, timedOut: false })),
      new Promise<RemoteProbeResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Yield already-running probes **in the order they were given**, streaming each as soon as every
 * probe before it has settled.
 *
 * The promises are started by the caller, so concurrency is unaffected — this only decides emission
 * order. It replaces a completion-order generator, which raced the probes and printed whichever
 * finished first: for local agents that looked stable (they resolve in microseconds), but a fleet of
 * SSH agents has per-host latency, so the roster reordered itself on every run and two runs could
 * not be compared. A table's row order is an identity operators read positionally; it must come
 * from the roster, not from the network.
 *
 * The cost is that one slow probe delays the rows after it. That is the honest trade: rows arrive in
 * a fixed order or they arrive fastest-first, and only the first is readable. A probe that hangs is
 * already bounded by {@link withRemoteProbeTimeout}, so the delay has a ceiling.
 */
export function inInputOrder<T>(promises: Promise<T>[]): AsyncGenerator<T> {
  // Mark every rejection handled at CALL time, not on first iteration. Awaiting sequentially leaves
  // a later promise's rejection unobserved while an earlier one is still in flight, and Node's
  // default for an unhandled rejection is to terminate the process — so one unreachable host could
  // kill the command before its own row was reached. This is deliberately not inside the generator
  // body: that body does not run until the first `next()`, which is a tick too late (Node reports
  // it as `PromiseRejectionHandledWarning: handled asynchronously`). Each rejection still surfaces
  // at its own position below.
  for (const promise of promises) void promise.catch(() => undefined)
  return yieldSequentially(promises)
}

async function* yieldSequentially<T>(promises: Promise<T>[]): AsyncGenerator<T> {
  for (const promise of promises) yield await promise
}
