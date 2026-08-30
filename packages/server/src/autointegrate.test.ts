import { ConflictError, HandoffError, SyncConflictError } from '@quimbyhq/errors'
import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAgentWorkSummary = vi.hoisted(() => vi.fn())
const rebaseAgentOntoBase = vi.hoisted(() => vi.fn())
const syncAgent = vi.hoisted(() => vi.fn())
const applyHandoff = vi.hoisted(() => vi.fn())
const discardHandoff = vi.hoisted(() => vi.fn())
const getWorkingParcelName = vi.hoisted(() => vi.fn())
const healAbandonedStaging = vi.hoisted(() => vi.fn())
const stageParcel = vi.hoisted(() => vi.fn())
const nudgeAgentSession = vi.hoisted(() => vi.fn())
const isClean = vi.hoisted(() => vi.fn())
const isMergeInProgress = vi.hoisted(() => vi.fn())
const mergeAbort = vi.hoisted(() => vi.fn())
const revParse = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/agent', () => ({ getAgentWorkSummary, rebaseAgentOntoBase, syncAgent }))
vi.mock('@quimbyhq/git', () => ({ isClean, isMergeInProgress, mergeAbort, revParse }))
vi.mock('@quimbyhq/handoff', () => ({
  applyHandoff,
  discardHandoff,
  getWorkingParcelName,
  healAbandonedStaging,
  stageParcel,
}))
vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession }))

import { autoIntegrateWork, createIntegrateTracker } from './autointegrate'

beforeEach(() => {
  vi.resetAllMocks()
  // The happy path: an integrator with commits, a clean host repo sitting on the tracked tip.
  getAgentWorkSummary.mockResolvedValue({ commits: 2, files: 3, insertions: 9, deletions: 1 })
  getWorkingParcelName.mockResolvedValue('integration-aaaa1111')
  isClean.mockResolvedValue(true)
  isMergeInProgress.mockResolvedValue(false)
  mergeAbort.mockResolvedValue(undefined)
  revParse.mockResolvedValue('tip')
  rebaseAgentOntoBase.mockResolvedValue(undefined)
  stageParcel.mockResolvedValue({ name: 'integration-aaaa1111' })
  healAbandonedStaging.mockResolvedValue(undefined)
  discardHandoff.mockResolvedValue(undefined)
  syncAgent.mockResolvedValue({ newSeed: 'ffffffff0000' })
  nudgeAgentSession.mockResolvedValue('sent')
  applyHandoff.mockResolvedValue({
    mode: 'commits',
    tempBranch: 't',
    conflicts: [],
    leftUncommitted: false,
    alreadyApplied: false,
    unpulledRemainderFiles: 0,
    landedCommits: 2,
  })
})

describe('autoIntegrateWork', () => {
  it('lands the integrator commits and advances its seed softly', async () => {
    const { reporter, events } = collectingReporter()

    const landed = await autoIntegrateWork(
      '/repo',
      state(),
      { from: 'integration' },
      createIntegrateTracker(),
      reporter,
    )

    expect(landed).toBe(2)
    // Pinned to commits mode, into the host repo itself.
    expect(applyHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'commits', targetRepoPath: '/repo', branch: undefined }),
    )
    // Soft, work-preserving advance — never a hard reset, which would drop the loose remainder.
    expect(syncAgent).toHaveBeenCalledWith('/repo', 'integration', { force: false, apply: true })
    expect(events.some((e) => e.message.includes('Integrated "integration"'))).toBe(true)
  })

  it('attempts one tree once, however many cycles pass', async () => {
    const tracker = createIntegrateTracker()
    await autoIntegrateWork('/repo', state(), { from: 'integration' }, tracker, silent())
    applyHandoff.mockClear()

    expect(
      await autoIntegrateWork('/repo', state(), { from: 'integration' }, tracker, silent()),
    ).toBe(0)
    expect(applyHandoff).not.toHaveBeenCalled()

    // A new tree is new work, and is carried.
    getWorkingParcelName.mockResolvedValue('integration-bbbb2222')
    expect(
      await autoIntegrateWork('/repo', state(), { from: 'integration' }, tracker, silent()),
    ).toBe(2)
    expect(applyHandoff).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the integrator has no committed work', async () => {
    getAgentWorkSummary.mockResolvedValue({ commits: 0, files: 4, insertions: 0, deletions: 0 })
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(0)
    expect(stageParcel).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })

  it('aborts the tentative merge and routes a conflict back to the agent', async () => {
    applyHandoff.mockRejectedValue(new ConflictError('overlaps', ['src/a.ts']))
    isMergeInProgress.mockResolvedValue(true)
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(0)

    // The user's repo is put back exactly as it was — no MERGE_HEAD, nothing staged.
    expect(mergeAbort).toHaveBeenCalledWith('/repo')
    expect(discardHandoff).toHaveBeenCalled()
    expect(syncAgent).not.toHaveBeenCalled()
    // The conflict nudge is forced: it is the only thing telling the agent what blocks the fleet.
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, courier: expect.stringContaining('origin/main') }),
    )
    expect(events.some((e) => e.message.includes('src/a.ts'))).toBe(true)
  })

  it('falls back to the boundary merge when the pre-sync rolls back cleanly', async () => {
    rebaseAgentOntoBase.mockRejectedValue(conflict(true))
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(2)
    expect(applyHandoff).toHaveBeenCalled()
    // The seed is left put, since the agent was never actually brought onto the base.
    expect(syncAgent).not.toHaveBeenCalled()
    expect(events.some((e) => e.message.includes('Seed left unchanged'))).toBe(true)
  })

  it('stops without merging when the agent repo is wedged', async () => {
    rebaseAgentOntoBase.mockRejectedValue(conflict(false))
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(0)
    expect(stageParcel).not.toHaveBeenCalled()
    expect(applyHandoff).not.toHaveBeenCalled()
    expect(nudgeAgentSession).toHaveBeenCalled()
    expect(events.some((e) => e.message.includes('wedged'))).toBe(true)
  })

  it('waits, without touching it, while the host repo is dirty', async () => {
    isClean.mockResolvedValue(false)
    const tracker = createIntegrateTracker()
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork('/repo', state(), { from: 'integration' }, tracker, reporter),
    ).toBe(0)
    expect(stageParcel).not.toHaveBeenCalled()
    expect(events.filter((e) => e.message.includes('uncommitted changes'))).toHaveLength(1)

    // Said once, not every cycle.
    await autoIntegrateWork('/repo', state(), { from: 'integration' }, tracker, reporter)
    expect(events.filter((e) => e.message.includes('uncommitted changes'))).toHaveLength(1)

    // …and it lands once the user commits.
    isClean.mockResolvedValue(true)
    expect(
      await autoIntegrateWork('/repo', state(), { from: 'integration' }, tracker, reporter),
    ).toBe(2)
  })

  it('leaves the seed alone when landing on a branch', async () => {
    const { reporter, events } = collectingReporter()

    await autoIntegrateWork(
      '/repo',
      state(),
      { from: 'integration', branch: 'quimby/landed' },
      createIntegrateTracker(),
      reporter,
    )

    expect(applyHandoff).toHaveBeenCalledWith(expect.objectContaining({ branch: 'quimby/landed' }))
    expect(syncAgent).not.toHaveBeenCalled()
    expect(events.some((e) => e.message.includes('landed on quimby/landed'))).toBe(true)
  })

  it('reports a no-op landing rather than claiming work crossed', async () => {
    applyHandoff.mockResolvedValue({
      mode: 'commits',
      tempBranch: 't',
      conflicts: [],
      leftUncommitted: false,
      alreadyApplied: true,
      unpulledRemainderFiles: 0,
      landedCommits: 0,
    })
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(0)
    expect(events.some((e) => e.message.includes('nothing landed'))).toBe(true)
    expect(events.some((e) => e.message.includes('Integrated'))).toBe(false)
  })

  it('names an unknown from: agent once and integrates nothing', async () => {
    const tracker = createIntegrateTracker()
    const { reporter, events } = collectingReporter()

    expect(await autoIntegrateWork('/repo', state(), { from: 'ghost' }, tracker, reporter)).toBe(0)
    await autoIntegrateWork('/repo', state(), { from: 'ghost' }, tracker, reporter)

    expect(events.filter((e) => e.message.includes('no agent named "ghost"'))).toHaveLength(1)
    expect(getAgentWorkSummary).not.toHaveBeenCalled()
  })

  it('keeps the landing when the seed advance fails', async () => {
    syncAgent.mockRejectedValue(new Error('stash pop conflicted'))
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(2)
    expect(events.some((e) => e.message.includes("couldn't advance"))).toBe(true)
  })

  it('treats an already-integrated agent as a clean no-op', async () => {
    stageParcel.mockRejectedValue(new HandoffError('nothing to carry'))
    const { reporter, events } = collectingReporter()

    expect(
      await autoIntegrateWork(
        '/repo',
        state(),
        { from: 'integration' },
        createIntegrateTracker(),
        reporter,
      ),
    ).toBe(0)
    expect(events.some((e) => e.level === 'warn' || e.level === 'error')).toBe(false)
  })
})

describe('createIntegrateTracker', () => {
  it('starts with nothing attempted', () => {
    expect(createIntegrateTracker().lastAttempt).toBeNull()
  })
})

function conflict(agentClean: boolean): SyncConflictError {
  return new SyncConflictError('rebase conflicted', agentClean)
}

function silent() {
  return collectingReporter().reporter
}

function state(): QuimbyState {
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: { integration: { id: 'int-id', name: 'integration', syncRef: 'main' } },
  } as unknown as QuimbyState
}
