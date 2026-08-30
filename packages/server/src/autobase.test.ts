import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const syncAgents = vi.hoisted(() => vi.fn())
const revParse = vi.hoisted(() => vi.fn())
vi.mock('@quimbyhq/agent', () => ({ syncAgents }))
vi.mock('@quimbyhq/git', () => ({ revParse }))

import { autoDeliverMovedBase, createBaseTipTracker, getWatchedSyncRefs } from './autobase'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('autoDeliverMovedBase', () => {
  it('delivers on a first sighting, so a tip that moved while the server was down is not missed', async () => {
    revParse.mockResolvedValueOnce('aaaaaaaabbbb')
    syncAgents.mockResolvedValueOnce([
      { name: 'builder', outcome: 'fast-forwarded', syncRef: 'main' },
    ])
    const { reporter, events } = collectingReporter()

    const moved = await autoDeliverMovedBase(
      '/repo',
      stateWith({ builder: 'main' }),
      createBaseTipTracker(),
      reporter,
    )

    expect(moved).toEqual(['main'])
    expect(events.some((e) => e.message.includes('(startup)'))).toBe(true)
  })

  it('never rewrites an agent: force and apply are pinned false', async () => {
    revParse.mockResolvedValueOnce('aaaaaaaabbbb')
    syncAgents.mockResolvedValueOnce([])

    await autoDeliverMovedBase(
      '/repo',
      stateWith({ builder: 'main' }),
      createBaseTipTracker(),
      collectingReporter().reporter,
    )

    expect(syncAgents).toHaveBeenCalledWith(
      expect.objectContaining({ all: true, force: false, apply: false, current: false }),
      expect.anything(),
    )
  })

  it('delivers once per move and stays silent while the tip holds still', async () => {
    const tracker = createBaseTipTracker()
    const state = stateWith({ builder: 'main' })
    revParse.mockResolvedValue('aaaaaaaabbbb')
    syncAgents.mockResolvedValue([])

    await autoDeliverMovedBase('/repo', state, tracker, collectingReporter().reporter)
    const { reporter, events } = collectingReporter()
    expect(await autoDeliverMovedBase('/repo', state, tracker, reporter)).toEqual([])

    expect(syncAgents).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)
  })

  it('names the agents that must apply the base themselves, and counts the rest', async () => {
    revParse.mockResolvedValueOnce('aaaaaaaabbbb')
    syncAgents.mockResolvedValueOnce([
      { name: 'builder', outcome: 'fast-forwarded', syncRef: 'main' },
      {
        name: 'integration',
        outcome: 'delivered',
        syncRef: 'main',
        baseCommit: 'ccccccccdddd',
        deferred: 'commits',
        commitsReplayed: 3,
      },
    ])
    const { reporter, events } = collectingReporter()

    await autoDeliverMovedBase(
      '/repo',
      stateWith({ builder: 'main', integration: 'main' }),
      createBaseTipTracker(),
      reporter,
    )

    const messages = events.map((e) => e.message)
    expect(messages.some((m) => m.includes('Base delivered to 2 agent(s)'))).toBe(true)
    expect(messages.some((m) => m.includes('[integration]') && m.includes('3 commit(s)'))).toBe(
      true,
    )
    // A fast-forwarded agent is a count, not a line — otherwise a current fleet prints one per move.
    expect(messages.some((m) => m.includes('[builder]'))).toBe(false)
  })

  it('names a skipped agent rather than folding it into the success count', async () => {
    revParse.mockResolvedValueOnce('aaaaaaaabbbb')
    syncAgents.mockResolvedValueOnce([
      { name: 'builder', outcome: 'skipped', syncRef: 'main', error: 'repo is mid-rebase' },
    ])
    const { reporter, events } = collectingReporter()

    await autoDeliverMovedBase(
      '/repo',
      stateWith({ builder: 'main' }),
      createBaseTipTracker(),
      reporter,
    )

    expect(events.some((e) => e.level === 'warn' && e.message.includes('repo is mid-rebase'))).toBe(
      true,
    )
  })

  it('warns once for a ref that stops resolving, and never syncs on it', async () => {
    const tracker = createBaseTipTracker()
    const state = stateWith({ builder: 'gone' })
    revParse.mockRejectedValue(new Error('unknown revision'))

    const first = collectingReporter()
    expect(await autoDeliverMovedBase('/repo', state, tracker, first.reporter)).toEqual([])
    const second = collectingReporter()
    expect(await autoDeliverMovedBase('/repo', state, tracker, second.reporter)).toEqual([])

    expect(syncAgents).not.toHaveBeenCalled()
    expect(first.events.some((e) => e.message.includes('no longer resolves'))).toBe(true)
    expect(second.events).toHaveLength(0)
  })

  it('leaves the tip unrecorded when delivery fails, so the next cycle retries', async () => {
    const tracker = createBaseTipTracker()
    const state = stateWith({ builder: 'main' })
    revParse.mockResolvedValue('aaaaaaaabbbb')
    syncAgents.mockRejectedValueOnce(new Error('workspace locked'))
    const { reporter, events } = collectingReporter()

    expect(await autoDeliverMovedBase('/repo', state, tracker, reporter)).toEqual([])
    expect(events.some((e) => e.level === 'error' && e.message.includes('workspace locked'))).toBe(
      true,
    )

    syncAgents.mockResolvedValueOnce([])
    expect(await autoDeliverMovedBase('/repo', state, tracker, reporter)).toEqual(['main'])
  })

  it('does nothing for a workspace with no agents', async () => {
    const { reporter, events } = collectingReporter()

    expect(
      await autoDeliverMovedBase('/repo', stateWith({}), createBaseTipTracker(), reporter),
    ).toEqual([])
    expect(revParse).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })

  it('forgets a ref nothing tracks any more', async () => {
    const tracker = createBaseTipTracker()
    tracker.tips.set('release', 'oldoldoldold')
    revParse.mockResolvedValueOnce('aaaaaaaabbbb')
    syncAgents.mockResolvedValueOnce([])

    await autoDeliverMovedBase(
      '/repo',
      stateWith({ builder: 'main' }),
      tracker,
      collectingReporter().reporter,
    )

    expect([...tracker.tips.keys()]).toEqual(['main'])
  })
})

describe('createBaseTipTracker', () => {
  it('starts with no remembered tips', () => {
    expect(createBaseTipTracker().tips.size).toBe(0)
  })
})

describe('getWatchedSyncRefs', () => {
  it('collects each distinct syncRef once, sorted', () => {
    expect(getWatchedSyncRefs(stateWith({ a: 'main', b: 'release', c: 'main' }))).toEqual([
      'main',
      'release',
    ])
  })

  it('falls back to the workspace sourceRef for an agent with no syncRef of its own', () => {
    const state = {
      id: 'proj',
      sourceRef: 'develop',
      agents: { a: { id: 'a' } },
    } as unknown as QuimbyState

    expect(getWatchedSyncRefs(state)).toEqual(['develop'])
  })
})

function stateWith(refs: Readonly<Record<string, string>>): QuimbyState {
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: Object.fromEntries(
      Object.entries(refs).map(([name, syncRef]) => [name, { id: name, name, syncRef }]),
    ),
  } as unknown as QuimbyState
}
