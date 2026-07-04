import { ConflictError } from '@quimbyhq/errors'
import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApplyMode } from './apply'

vi.mock('@quimbyhq/git', () => ({
  isClean: vi.fn(async () => true),
}))
vi.mock('./stage', () => ({
  stageParcel: vi.fn(async () => ({ name: 'staged-parcel' })),
}))
vi.mock('./apply', () => ({
  applyHandoff: vi.fn(async (opts: { mode: ApplyMode }) => ({
    mode: opts.mode,
    tempBranch: 'quimby/merge-x',
    conflicts: [],
  })),
}))
vi.mock('./parcel', () => ({
  readHandoff: vi.fn(async () => ({ meta: { suggestedMessage: 'do the thing' } })),
  discardHandoff: vi.fn(async () => {}),
}))

import { isClean } from '@quimbyhq/git'

import { applyHandoff } from './apply'
import { mergeAgentWork } from './merge'
import { discardHandoff, readHandoff } from './parcel'
import { stageParcel } from './stage'

const mockedClean = vi.mocked(isClean)
const mockedApply = vi.mocked(applyHandoff)
const mockedStage = vi.mocked(stageParcel)
const mockedDiscard = vi.mocked(discardHandoff)

function stateWith(...names: string[]): QuimbyState {
  const agents: Record<string, unknown> = {}
  for (const name of names) agents[name] = { id: `${name}-id`, name, location: { type: 'local' } }
  return { id: 'proj', agents } as unknown as QuimbyState
}

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    state: stateWith('builder'),
    repoRoot: '/r',
    agent: 'builder',
    targetRepoPath: '/target',
    targetExplicit: false,
    commits: false,
    patch: false,
    ...overrides,
  } as Parameters<typeof mergeAgentWork>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedClean.mockResolvedValue(true)
})

describe('mergeAgentWork', () => {
  it('rejects --commits and --patch together', async () => {
    await expect(mergeAgentWork(baseOpts({ commits: true, patch: true }))).rejects.toThrow(
      /Cannot use --commits and --patch/,
    )
  })

  it('throws with the current-directory hint when the implicit target is dirty', async () => {
    mockedClean.mockResolvedValue(false)
    await expect(mergeAgentWork(baseOpts({ targetExplicit: false }))).rejects.toThrow(/use -t/)
  })

  it('throws without the hint when an explicit target is dirty', async () => {
    mockedClean.mockResolvedValue(false)
    await expect(mergeAgentWork(baseOpts({ targetExplicit: true }))).rejects.toThrow(
      /uncommitted changes/,
    )
    // the implicit-target hint must not appear for an explicit -t
    await expect(mergeAgentWork(baseOpts({ targetExplicit: true }))).rejects.not.toThrow(/use -t/)
  })

  it('defaults to squashed mode and stages an agent, discarding on success', async () => {
    const result = await mergeAgentWork(baseOpts())
    expect(mockedStage).toHaveBeenCalledOnce()
    expect(mockedApply).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'squashed', name: 'staged-parcel' }),
    )
    expect(mockedDiscard).toHaveBeenCalledWith('/r', 'staged-parcel')
    expect(result.name).toBe('staged-parcel')
    expect(result.mode).toBe('squashed')
  })

  it('resolves commits and patch modes from the flags', async () => {
    expect((await mergeAgentWork(baseOpts({ commits: true }))).mode).toBe('commits')
    expect((await mergeAgentWork(baseOpts({ patch: true }))).mode).toBe('patch')
  })

  it('treats an unknown name as a raw parcel and does not stage', async () => {
    const result = await mergeAgentWork(baseOpts({ agent: 'raw-parcel-name' }))
    expect(mockedStage).not.toHaveBeenCalled()
    expect(result.name).toBe('raw-parcel-name')
  })

  it('returns the suggested message for patch mode', async () => {
    const result = await mergeAgentWork(baseOpts({ patch: true }))
    expect(result.suggestedMessage).toBe('do the thing')
  })

  it('propagates a merge conflict and does not discard the parcel', async () => {
    mockedApply.mockRejectedValueOnce(new ConflictError('conflicts', ['a.ts'], 'staged-parcel'))
    await expect(mergeAgentWork(baseOpts())).rejects.toBeInstanceOf(ConflictError)
    expect(mockedDiscard).not.toHaveBeenCalled()
  })
})
