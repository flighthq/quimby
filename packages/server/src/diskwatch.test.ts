import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getRemoteDiskUsage = vi.hoisted(() => vi.fn())
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getRemoteDiskUsage,
}))

import { createDiskWatchTracker, watchRemoteDiskSpace } from './diskwatch'

const state = {
  id: 'p',
  agents: {
    a: { id: 'a', name: 'a', location: { type: 'ssh', host: 'u@box', alias: 'remote' } },
    b: { id: 'b', name: 'b', location: { type: 'ssh', host: 'u@box', alias: 'remote' } },
    c: { id: 'c', name: 'c' },
  },
} as unknown as QuimbyState

const full = { totalKb: 1000, usedKb: 990, availKb: 10, mount: '/' }
const roomy = { totalKb: 1000, usedKb: 100, availKb: 900, mount: '/' }

afterEach(() => vi.clearAllMocks())

describe('createDiskWatchTracker', () => {
  it('starts with no hosts seen', () => {
    expect(createDiskWatchTracker().hosts.size).toBe(0)
  })
})

describe('watchRemoteDiskSpace', () => {
  it('checks each host once, warns on going low, and stays quiet until it recovers', async () => {
    const tracker = createDiskWatchTracker()
    const { reporter, events } = collectingReporter()
    getRemoteDiskUsage.mockResolvedValue(full)

    await watchRemoteDiskSpace(state, {}, tracker, 0, reporter, 1000)
    // Two agents share one host: one df, one warning.
    expect(getRemoteDiskUsage).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.level === 'warn')).toHaveLength(1)

    // Inside the interval: no re-read at all.
    await watchRemoteDiskSpace(state, {}, tracker, 500, reporter, 1000)
    expect(getRemoteDiskUsage).toHaveBeenCalledTimes(1)

    // Still low after the interval: re-read, but no repeated warning.
    await watchRemoteDiskSpace(state, {}, tracker, 1500, reporter, 1000)
    expect(events.filter((e) => e.level === 'warn')).toHaveLength(1)

    getRemoteDiskUsage.mockResolvedValue(roomy)
    await watchRemoteDiskSpace(state, {}, tracker, 3000, reporter, 1000)
    expect(events.at(-1)?.message).toContain('back above storage.minFree')
  })

  it('treats an unreadable host as no news rather than as recovered', async () => {
    const tracker = createDiskWatchTracker()
    const { reporter, events } = collectingReporter()
    getRemoteDiskUsage.mockResolvedValueOnce(full)
    await watchRemoteDiskSpace(state, {}, tracker, 0, reporter, 1)
    getRemoteDiskUsage.mockRejectedValueOnce(new Error('unreachable'))
    await watchRemoteDiskSpace(state, {}, tracker, 10, reporter, 1)
    getRemoteDiskUsage.mockResolvedValueOnce(full)
    await watchRemoteDiskSpace(state, {}, tracker, 20, reporter, 1)
    expect(events.filter((e) => e.level === 'warn')).toHaveLength(1)
    expect(events.some((e) => e.message.includes('back above'))).toBe(false)
  })
})
