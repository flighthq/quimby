import { logger } from '@quimbyhq/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getPoolInventory = vi.hoisted(() => vi.fn())
const getPoolCapacity = vi.hoisted(() => vi.fn())
const poolCapacityWarning = vi.hoisted(() => vi.fn())
vi.mock('@quimbyhq/pool', () => ({ getPoolInventory, getPoolCapacity, poolCapacityWarning }))

import { warnIfPoolAtCapacity } from './poolWarning'

afterEach(() => vi.clearAllMocks())

describe('warnIfPoolAtCapacity', () => {
  it('does nothing (and never probes) when no ceiling is configured', async () => {
    await warnIfPoolAtCapacity({}, undefined)
    expect(getPoolInventory).not.toHaveBeenCalled()
  })

  it('warns when a launch would push past the ceiling', async () => {
    getPoolInventory.mockResolvedValueOnce({ projects: [], orphans: [], totals: {} })
    getPoolCapacity.mockReturnValueOnce({ live: 4, maxLive: 3, idlest: [] })
    poolCapacityWarning.mockReturnValueOnce('4 agent sessions are live (pool.maxLive: 3).')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await warnIfPoolAtCapacity({ pool: { maxLive: 3 } })

    expect(warn).toHaveBeenCalledWith('4 agent sessions are live (pool.maxLive: 3).')
  })

  it('stays silent when there is room', async () => {
    getPoolInventory.mockResolvedValueOnce({ projects: [], orphans: [], totals: {} })
    poolCapacityWarning.mockReturnValueOnce(null)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await warnIfPoolAtCapacity({ pool: { maxLive: 9 } })

    expect(warn).not.toHaveBeenCalled()
  })

  it('never lets a probe failure block a launch', async () => {
    getPoolInventory.mockRejectedValueOnce(new Error('tmux exploded'))
    await expect(warnIfPoolAtCapacity({ pool: { maxLive: 3 } })).resolves.toBeUndefined()
  })
})
