import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { killAgentSession } from './killSession'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))

const mockedGetSSH = vi.mocked(getSSHTransport)

const localTmux = {
  id: 'a1',
  name: 'builder',
  location: { type: 'local' },
  tmux: true,
} as AgentState
const localNoTmux = { id: 'a1', name: 'builder', location: { type: 'local' } } as AgentState
const remote = {
  id: 'r1',
  name: 'researcher',
  location: { type: 'ssh', alias: 'gpu', host: 'me@gpu' },
} as AgentState

beforeEach(() => {
  execa.mockReset()
  execa.mockResolvedValue({ stdout: '' })
  mockedGetSSH.mockReset()
})

describe('killAgentSession', () => {
  it('kills a local agent that has a tmux session via the quimby socket', async () => {
    await killAgentSession(localTmux)
    expect(execa).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['-L', 'quimby', 'kill-session', '-t', 'qb-a1']),
    )
  })

  it('no-ops for a local agent that was never enrolled in tmux', async () => {
    await killAgentSession(localNoTmux)
    expect(execa).not.toHaveBeenCalled()
  })

  it('kills a remote agent over the SSH transport', async () => {
    const calls: string[] = []
    mockedGetSSH.mockReturnValue({
      exec: vi.fn(async (cmd: string) => {
        calls.push(cmd)
        return ''
      }),
    } as unknown as SSHTransport)
    await killAgentSession(remote)
    expect(calls[0]).toContain('kill-session')
    expect(calls[0]).toContain('qb-r1')
    expect(execa).not.toHaveBeenCalled()
  })

  it('swallows a missing session so a stopped agent tears down cleanly', async () => {
    execa.mockRejectedValueOnce(new Error("can't find session"))
    await expect(killAgentSession(localTmux)).resolves.toBeUndefined()
  })
})
