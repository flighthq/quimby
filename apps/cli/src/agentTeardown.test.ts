import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { teardownAgentSandbox } from './agentTeardown'

const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))
vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))

const mockedGetSSH = vi.mocked(getSSHTransport)
const state = { id: 'proj-id' } as QuimbyState

function agent(over: Partial<AgentState>): AgentState {
  return { id: 'a1', name: 'builder', location: { type: 'local' }, ...over } as AgentState
}

beforeEach(() => {
  execa.mockReset()
  execa.mockResolvedValue({})
  mockedGetSSH.mockReset()
})

describe('teardownAgentSandbox', () => {
  it('removes a local sbx sandbox on the host', async () => {
    await teardownAgentSandbox({
      state,
      repoRoot: '/root',
      agent: agent({ defaults: { runtime: 'sbx' } }),
      name: 'builder',
    })
    expect(execa).toHaveBeenCalledWith('sbx', expect.arrayContaining(['rm']))
  })

  it('no-ops for a local runtime (no sandbox to remove)', async () => {
    await teardownAgentSandbox({
      state,
      repoRoot: '/root',
      agent: agent({ defaults: { runtime: 'local' } }),
      name: 'builder',
    })
    expect(execa).not.toHaveBeenCalled()
  })

  it('removes an SSH agent sandbox on the remote host over the transport', async () => {
    const calls: string[] = []
    mockedGetSSH.mockReturnValue({
      exec: vi.fn(async (cmd: string) => {
        calls.push(cmd)
        return ''
      }),
    } as unknown as SSHTransport)
    await teardownAgentSandbox({
      state,
      repoRoot: '/root',
      agent: agent({
        location: { type: 'ssh', alias: 'gpu', host: 'me@gpu' },
        defaults: { runtime: 'sbx' },
      }),
      name: 'builder',
    })
    // The rm runs on the remote (not the host) and targets the remote-path-hashed sandbox name.
    expect(calls[0]).toMatch(/^sbx /)
    expect(calls[0]).toContain('rm')
    expect(calls[0]).toContain('qb-a1')
    expect(execa).not.toHaveBeenCalled()
  })

  it('swallows an unreachable SSH host — teardown is advisory', async () => {
    mockedGetSSH.mockReturnValue({
      exec: vi.fn(async () => {
        throw new Error('ssh: connect timed out')
      }),
    } as unknown as SSHTransport)
    await expect(
      teardownAgentSandbox({
        state,
        repoRoot: '/root',
        agent: agent({
          location: { type: 'ssh', alias: 'gpu', host: 'me@gpu' },
          defaults: { runtime: 'sbx' },
        }),
        name: 'builder',
      }),
    ).resolves.toBeUndefined()
  })
})
