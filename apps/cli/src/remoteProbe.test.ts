import { describe, expect, it, vi } from 'vitest'

import { inInputOrder, remoteProbeTimeoutMs, withRemoteProbeTimeout } from './remoteProbe'

describe('remoteProbeTimeoutMs', () => {
  it('uses the default timeout when no override is set', () => {
    expect(remoteProbeTimeoutMs({})).toBe(5_000)
  })

  it('uses QUIMBY_REMOTE_PROBE_TIMEOUT_MS when set', () => {
    expect(remoteProbeTimeoutMs({ QUIMBY_REMOTE_PROBE_TIMEOUT_MS: '250' })).toBe(250)
  })

  it('keeps invalid overrides on the default', () => {
    expect(remoteProbeTimeoutMs({ QUIMBY_REMOTE_PROBE_TIMEOUT_MS: 'nope' })).toBe(5_000)
  })
})

describe('withRemoteProbeTimeout', () => {
  it('returns the probe value when it settles before the timeout', async () => {
    await expect(withRemoteProbeTimeout(Promise.resolve('ok'), 'fallback')).resolves.toEqual({
      value: 'ok',
      timedOut: false,
    })
  })

  it('returns the fallback when the probe exceeds the timeout', async () => {
    vi.useFakeTimers()
    const probe = new Promise<string>(() => {})
    const result = withRemoteProbeTimeout(probe, 'fallback', { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(result).resolves.toEqual({ value: 'fallback', timedOut: true })
    vi.useRealTimers()
  })

  it('can disable the timeout for callers that need the real result', async () => {
    await expect(
      withRemoteProbeTimeout(Promise.resolve('ok'), 'fallback', { timeoutMs: 0 }),
    ).resolves.toEqual({ value: 'ok', timedOut: false })
  })
})

describe('inInputOrder', () => {
  it('yields in the order given, not the order they resolve', async () => {
    vi.useFakeTimers()
    const values: string[] = []
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 50))
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('fast'), 10))
    const read = async () => {
      for await (const value of inInputOrder([slow, fast])) values.push(value)
    }
    const done = read()

    // `fast` has already resolved, but it is second in the roster and waits its turn — otherwise
    // the table reorders itself between runs on any fleet with remote agents.
    await vi.advanceTimersByTimeAsync(10)
    expect(values).toEqual([])
    await vi.advanceTimersByTimeAsync(40)
    await done
    expect(values).toEqual(['slow', 'fast'])
    vi.useRealTimers()
  })

  it('streams a settled prefix instead of waiting for the whole set', async () => {
    vi.useFakeTimers()
    const values: string[] = []
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('fast'), 10))
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 50))
    const read = async () => {
      for await (const value of inInputOrder([fast, slow])) values.push(value)
    }
    const done = read()

    await vi.advanceTimersByTimeAsync(10)
    expect(values).toEqual(['fast'])
    await vi.advanceTimersByTimeAsync(40)
    await done
    vi.useRealTimers()
  })

  it('never leaves a later rejection unobserved while an earlier probe is in flight', async () => {
    // Node terminates the process on an unhandled rejection, so an unreachable host could kill the
    // command before its own row was reached. The rejection must surface at ITS position instead.
    vi.useFakeTimers()
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 50))
    const failed = Promise.reject(new Error('unreachable'))
    const values: string[] = []
    const read = async () => {
      for await (const value of inInputOrder([slow, failed])) values.push(value)
    }
    const done = read()
    // Observe the rejection BEFORE advancing: `done` rejects while the timers run, and attaching
    // the assertion afterwards would leave that rejection unhandled for a tick — the very hazard
    // under test, reintroduced by the test itself.
    const rejects = expect(done).rejects.toThrow('unreachable')

    await vi.advanceTimersByTimeAsync(50)
    await rejects
    expect(values).toEqual(['slow'])
    vi.useRealTimers()
  })
})
