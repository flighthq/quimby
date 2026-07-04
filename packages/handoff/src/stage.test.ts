import type { QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./assemble', () => ({
  HOST_SENDER: 'host',
  assembleHandoff: vi.fn(async () => ({ name: 'review-abc123' })),
  assembleRemoteHandoff: vi.fn(async () => ({ name: 'review-remote1' })),
}))

import { assembleHandoff, assembleRemoteHandoff } from './assemble'
import { stageParcel } from './stage'

const mockedAssemble = vi.mocked(assembleHandoff)
const mockedRemote = vi.mocked(assembleRemoteHandoff)

function stateWith(agents: Record<string, unknown>): QuimbyState {
  return { id: 'proj-id', agents } as unknown as QuimbyState
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('stageParcel', () => {
  it('throws when the source agent does not exist', async () => {
    await expect(
      stageParcel({ state: stateWith({}), repoRoot: '/fake/root', from: 'ghost' }),
    ).rejects.toThrow('not found')
  })

  it('throws when the attach code source does not exist', async () => {
    await expect(
      stageParcel({
        state: stateWith({ review: { location: undefined } }),
        repoRoot: '/fake/root',
        from: 'review',
        attach: 'ghost',
      }),
    ).rejects.toThrow('not found')
  })

  it('assembles a local parcel from the source agent by default', async () => {
    const meta = await stageParcel({
      state: stateWith({ review: { id: 'review-id', location: { type: 'local' } } }),
      repoRoot: '/root',
      from: 'review',
    })
    expect(meta.name).toBe('review-abc123')
    expect(mockedAssemble).toHaveBeenCalledOnce()
    expect(mockedRemote).not.toHaveBeenCalled()
  })

  it('routes to the remote assembler when the code source is an SSH agent', async () => {
    await stageParcel({
      state: stateWith({ r: { id: 'r-id', location: { type: 'ssh', host: 'h', base: '~' } } }),
      repoRoot: '/root',
      from: 'r',
    })
    expect(mockedRemote).toHaveBeenCalledOnce()
    expect(mockedAssemble).not.toHaveBeenCalled()
  })

  it('runs beforeStage against the resolved code source before assembling', async () => {
    const calls: string[] = []
    await stageParcel({
      state: stateWith({
        review: { id: 'review-id', location: { type: 'local' } },
        builder: { id: 'builder-id', location: { type: 'local' } },
      }),
      repoRoot: '/root',
      from: 'review',
      attach: 'builder',
      beforeStage: async (name) => {
        calls.push(name)
      },
    })
    // attach wins: the diff (and the pre-stage rebase) comes from builder, not review.
    expect(calls).toEqual(['builder'])
  })
})
