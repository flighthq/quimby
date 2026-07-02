import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./assemble', () => ({
  HOST_SENDER: 'host',
  assembleHostHandoff: vi.fn(async () => ({ name: 'host-xyz789' })),
}))
vi.mock('./stage', () => ({
  stageParcel: vi.fn(async () => ({ name: 'builder-abc123' })),
}))
vi.mock('./parcel', () => ({
  deliverHandoff: vi.fn(async () => {}),
  discardHandoff: vi.fn(async () => {}),
}))

import { assembleHostHandoff } from './assemble'
import { handoffWork } from './carry'
import { deliverHandoff, discardHandoff } from './parcel'
import { stageParcel } from './stage'

const mockedHost = vi.mocked(assembleHostHandoff)
const mockedStage = vi.mocked(stageParcel)
const mockedDeliver = vi.mocked(deliverHandoff)
const mockedDiscard = vi.mocked(discardHandoff)

function stateWith(...names: string[]): QuimbyState {
  const agents: Record<string, unknown> = {}
  for (const name of names) {
    agents[name] = { id: `${name}-id`, name, seedCommit: 'seed', location: { type: 'local' } }
  }
  return { id: 'proj', agents, subscriptions: {} } as unknown as QuimbyState
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handoffWork', () => {
  it('throws when the recipient is unknown', async () => {
    await expect(
      handoffWork({ state: stateWith('builder'), repoRoot: '/r', from: 'ghost' }),
    ).rejects.toThrow('not found')
  })

  it('carries host → recipient when only one agent is named', async () => {
    const result = await handoffWork({
      state: stateWith('builder'),
      repoRoot: '/r',
      from: 'builder',
      message: 'look at my tweak',
    })

    expect(mockedHost).toHaveBeenCalledOnce()
    expect(mockedStage).not.toHaveBeenCalled()
    expect(result.from).toBe('host')
    expect(result.to).toBe('builder')
    expect(result.parcelName).toBe('host-xyz789')
    expect(mockedDeliver).toHaveBeenCalledOnce()
    expect(mockedDiscard).toHaveBeenCalledOnce()
  })

  it('carries source → recipient when both are named', async () => {
    const result = await handoffWork({
      state: stateWith('builder', 'review'),
      repoRoot: '/r',
      from: 'builder',
      to: 'review',
    })

    expect(mockedStage).toHaveBeenCalledOnce()
    expect(mockedHost).not.toHaveBeenCalled()
    expect(result.from).toBe('builder')
    expect(result.to).toBe('review')
    expect(result.parcelName).toBe('builder-abc123')
  })

  it('nudges by default only when the parcel carries a note', async () => {
    const withNote = await handoffWork({
      state: stateWith('b', 'r'),
      repoRoot: '/r',
      from: 'b',
      to: 'r',
      message: 'please review',
    })
    expect(withNote.nudgeText).toBe('Please review: @inbox/builder-abc123/\n\nplease review')

    const noNote = await handoffWork({
      state: stateWith('b', 'r'),
      repoRoot: '/r',
      from: 'b',
      to: 'r',
    })
    expect(noNote.nudgeText).toBeNull()
  })

  it('honors an explicit --nudge / --no-nudge over the note heuristic', async () => {
    const forcedOn = await handoffWork({
      state: stateWith('b', 'r'),
      repoRoot: '/r',
      from: 'b',
      to: 'r',
      nudge: true,
    })
    expect(forcedOn.nudgeText).not.toBeNull()

    const forcedOff = await handoffWork({
      state: stateWith('b', 'r'),
      repoRoot: '/r',
      from: 'b',
      to: 'r',
      message: 'note present',
      nudge: false,
    })
    expect(forcedOff.nudgeText).toBeNull()
  })

  it('throws when a named source agent does not exist', async () => {
    await expect(
      handoffWork({ state: stateWith('review'), repoRoot: '/r', from: 'ghost', to: 'review' }),
    ).rejects.toThrow('not found')
  })
})
