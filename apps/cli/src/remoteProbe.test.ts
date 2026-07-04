import { describe, expect, it, vi } from 'vitest'

import { inCompletionOrder, remoteProbeTimeoutMs, withRemoteProbeTimeout } from './remoteProbe'

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

describe('inCompletionOrder', () => {
  it('yields promise values in resolution order', async () => {
    vi.useFakeTimers()
    const values: string[] = []
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 50))
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('fast'), 10))
    const read = async () => {
      for await (const value of inCompletionOrder([slow, fast])) values.push(value)
    }
    const done = read()

    await vi.advanceTimersByTimeAsync(10)
    expect(values).toEqual(['fast'])
    await vi.advanceTimersByTimeAsync(40)
    await done
    expect(values).toEqual(['fast', 'slow'])
    vi.useRealTimers()
  })
})
