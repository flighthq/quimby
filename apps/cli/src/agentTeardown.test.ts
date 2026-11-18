import type { SSHTransport } from '@quimbyhq/transport'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const localRun = vi.hoisted(() => vi.fn(async (_script: string, _input?: string) => ''))
vi.mock('@quimbyhq/runtimes', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  localSandboxShellRunner: () => localRun,
}))
vi.mock('@quimbyhq/transport', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getSSHTransport: vi.fn(),
}))

import { teardownAgentSandbox } from './agentTeardown'

const mockedGetSSH = vi.mocked(getSSHTransport)
const ID = 'a1b2c3d4-0000-0000-0000-000000000000'
const MINE = 'qb-a1b2c3d4-0123456789ab'
const MINE_OTHER_CMD = 'qb-a1b2c3d4-ba9876543210'
const THEIRS = 'qb-ffffffff-0123456789ab'

function agent(over: Partial<AgentState> = {}): AgentState {
  return { id: ID, name: 'builder', location: { type: 'local' }, ...over } as AgentState
}

// A fake shell that answers the sweep's two scripts: the listing, then the removal (which reads
// the names to remove on stdin and reports each).
function fakeShell(listing: string[], refuse: string[] = []) {
  return async (script: string, input?: string) => {
    if (input === undefined) {
      return `QBSBXCLI\tsbx\n${listing.map((n) => `QBSBX\tsbx\t${n}`).join('\n')}\n`
    }
    return input
      .trim()
      .split('\n')
      .map((line) => {
        const [cli, name] = line.split('\t')
        return `QBSBXRM\t${cli}\t${name}\t${refuse.includes(name) ? 'fail' : 'ok'}`
      })
      .join('\n')
  }
}

beforeEach(() => {
  localRun.mockReset()
  mockedGetSSH.mockReset()
  vi.restoreAllMocks()
})

describe('teardownAgentSandbox', () => {
  it("removes every one of a local agent's sandboxes — one per command it ever ran", async () => {
    localRun.mockImplementation(fakeShell([MINE, MINE_OTHER_CMD, THEIRS]))
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    await teardownAgentSandbox({ agent: agent(), name: 'builder' })

    const removal = localRun.mock.calls.find(([, input]) => input !== undefined)
    expect(removal?.[1]).toBe(`sbx\t${MINE}\nsbx\t${MINE_OTHER_CMD}\n`)
    expect(info).toHaveBeenCalledWith(expect.stringContaining(MINE))
  })

  it('does not depend on a recorded runtime — a role-backed agent has none', async () => {
    // The old teardown read `defaults.runtime`, found nothing, treated it as local, and skipped.
    localRun.mockImplementation(fakeShell([MINE]))
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    await teardownAgentSandbox({ agent: agent({ role: 'builder' }), name: 'builder' })
    expect(localRun.mock.calls.some(([, input]) => input?.includes(MINE))).toBe(true)
  })

  it('runs on the SSH host for a remote agent, never on this machine', async () => {
    const exec = vi.fn(fakeShell([MINE]))
    mockedGetSSH.mockReturnValue({
      exec: (cmd: string, opts?: { input?: string }) => exec(cmd, opts?.input),
    } as unknown as SSHTransport)
    vi.spyOn(logger, 'info').mockImplementation(() => {})

    await teardownAgentSandbox({
      agent: agent({ location: { type: 'ssh', alias: 'gpu', host: 'me@gpu' } }),
      name: 'builder',
    })

    expect(exec).toHaveBeenCalledTimes(2)
    expect(localRun).not.toHaveBeenCalled()
  })

  it('names a sandbox the CLI refused to remove, with the command to do it by hand', async () => {
    localRun.mockImplementation(fakeShell([MINE], [MINE]))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await teardownAgentSandbox({ agent: agent(), name: 'builder' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`sbx rm ${MINE}`))
  })

  it('reports an unreachable host instead of throwing — teardown never blocks removal', async () => {
    mockedGetSSH.mockReturnValue({
      exec: vi.fn(async () => {
        throw new Error('ssh: connect timed out')
      }),
    } as unknown as SSHTransport)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(
      teardownAgentSandbox({
        agent: agent({ location: { type: 'ssh', alias: 'gpu', host: 'me@gpu' } }),
        name: 'builder',
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connect timed out'))
  })

  it('warns rather than guessing when the host alias is unbound', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await teardownAgentSandbox({
      agent: agent({ location: { type: 'ssh', alias: 'gpu' } }),
      name: 'builder',
    })
    expect(mockedGetSSH).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unbound'))
  })
})
