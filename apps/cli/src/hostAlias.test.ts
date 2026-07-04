import type { QuimbyState } from '@quimbyhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadQuimbyConfig = vi.hoisted(() =>
  vi.fn(async () => ({
    hosts: {
      remote: { type: 'ssh', host: 'remote' }, // unbound placeholder
      gpu: { type: 'ssh', host: 'me@gpu', port: 2222 }, // bound
    },
  })),
)

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  loadQuimbyConfig,
}))

import { ensureAgentConnections, resolveSSHLocationInteractive } from './hostAlias'

const originalTTY = process.stdout.isTTY

afterEach(() => {
  process.stdout.isTTY = originalTTY
})

describe('ensureAgentConnections', () => {
  it('resolves a bound alias to a concrete host in place and leaves local agents alone', async () => {
    const state = {
      agents: {
        builder: { id: 'b', name: 'builder', location: { type: 'ssh', alias: 'gpu' } },
        local: { id: 'l', name: 'local', location: { type: 'local' } },
      },
    } as unknown as QuimbyState

    await ensureAgentConnections('/repo', state, ['builder', 'local'])

    expect(state.agents.builder.location).toEqual({
      type: 'ssh',
      host: 'me@gpu',
      alias: 'gpu',
      port: 2222,
    })
    expect(state.agents.local.location).toEqual({ type: 'local' })
  })

  it('throws for an unbound alias when there is no TTY', async () => {
    process.stdout.isTTY = false
    const state = {
      agents: { review: { id: 'r', name: 'review', location: { type: 'ssh', alias: 'remote' } } },
    } as unknown as QuimbyState

    await expect(ensureAgentConnections('/repo', state, ['review'])).rejects.toThrow(
      /quimby host remote --set/,
    )
  })
})

describe('resolveSSHLocationInteractive', () => {
  it('passes a bound alias straight through without prompting', async () => {
    const config = { hosts: { gpu: { type: 'ssh' as const, host: 'me@gpu' } } }
    expect(
      await resolveSSHLocationInteractive('/repo', config, { type: 'ssh', alias: 'gpu' }),
    ).toEqual({ type: 'ssh', host: 'me@gpu', alias: 'gpu' })
  })

  it('throws a bind hint for an unbound alias without a TTY', async () => {
    process.stdout.isTTY = false
    const config = { hosts: { remote: { type: 'ssh' as const, host: 'remote' } } }
    await expect(
      resolveSSHLocationInteractive('/repo', config, { type: 'ssh', alias: 'remote' }),
    ).rejects.toThrow(/quimby host remote --set/)
  })
})
