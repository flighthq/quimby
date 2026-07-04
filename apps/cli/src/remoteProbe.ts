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

export async function* inCompletionOrder<T>(promises: Promise<T>[]): AsyncGenerator<T> {
  const pending = new Map(
    promises.map((promise, index) => [index, promise.then((value) => ({ index, value }))]),
  )
  while (pending.size > 0) {
    const { index, value } = await Promise.race(pending.values())
    pending.delete(index)
    yield value
  }
}
