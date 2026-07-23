import { beforeEach, describe, expect, it, vi } from 'vitest'

const nudgeAgentSession = vi.hoisted(() => vi.fn(async (_opts: { text: string }) => {}))
const hasAgentSession = vi.hoisted(() => vi.fn(async () => true))
const assignAgentTask = vi.hoisted(() =>
  vi.fn(async (): Promise<{ behind: number; syncFailed: boolean; nudgeText: string | null }> => ({
    behind: 0,
    syncFailed: false,
    nudgeText: 'assignment updated',
  })),
)

vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession, hasAgentSession }))
vi.mock('@quimbyhq/agent', () => ({ assignAgentTask }))

let resolved = { state: { id: 'proj-id', agents: {} }, repoRoot: '/fake/root' }

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

describe('runNudgeCommand', () => {
  beforeEach(() => {
    resolved = { state: { id: 'proj-id', agents: {} }, repoRoot: '/fake/root' }
    nudgeAgentSession.mockClear()
    hasAgentSession.mockClear()
    assignAgentTask.mockClear()
    assignAgentTask.mockResolvedValue({
      behind: 0,
      syncFailed: false,
      nudgeText: 'assignment updated',
    })
  })

  it('is a function', async () => {
    const { default: cmd } = await import('./nudge')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the agent does not exist', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(cmd.run!({ args: { agent: 'ghost', all: false } } as never)).rejects.toThrow(
      'not found',
    )
  })

  it('throws when neither an agent nor --all is given', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(cmd.run!({ args: { all: false } } as never)).rejects.toThrow('--all')
  })

  it('with --all and no agents, reports nothing to do instead of throwing', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(cmd.run!({ args: { all: true } } as never)).resolves.toBeUndefined()
  })

  it('-m durably assigns with normal sync before sending an assignment courier nudge', async () => {
    const builder = {
      id: 'b1',
      name: 'builder',
      tmux: true,
      check: 'npm run ci',
      verifyByDefault: true,
    }
    resolved = {
      state: { id: 'proj-id', agents: { builder } },
      repoRoot: '/fake/root',
    } as never
    const { default: cmd } = await import('./nudge')

    await cmd.run!({
      args: {
        agent: 'builder',
        message: 'implement the API',
        raw: false,
        all: false,
        clear: true,
      },
    } as never)

    expect(assignAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        state: resolved.state,
        repoRoot: '/fake/root',
        name: 'builder',
        message: 'implement the API',
        sync: true,
        nudge: true,
        verify: true,
      }),
      expect.anything(),
    )
    expect(nudgeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: builder,
        clear: true,
        displayName: 'builder',
        courier: 'assignment updated',
      }),
    )
  })

  it('does not wake a task-bearing nudge when assignment sync fails', async () => {
    resolved = {
      state: {
        id: 'proj-id',
        agents: { builder: { id: 'b1', name: 'builder', tmux: true } },
      },
      repoRoot: '/fake/root',
    } as never
    assignAgentTask.mockResolvedValueOnce({
      behind: 1,
      syncFailed: true,
      nudgeText: null,
    })
    const { default: cmd } = await import('./nudge')

    await cmd.run!({
      args: { agent: 'builder', message: 'implement the API', raw: false, all: false },
    } as never)

    expect(assignAgentTask).toHaveBeenCalledOnce()
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('--raw -m types ephemeral text without changing the assignment', async () => {
    resolved = {
      state: {
        id: 'proj-id',
        agents: { builder: { id: 'b1', name: 'builder', tmux: true } },
      },
      repoRoot: '/fake/root',
    } as never
    const { default: cmd } = await import('./nudge')

    await cmd.run!({
      args: {
        agent: 'builder',
        message: '/model opus',
        raw: true,
        all: false,
        clear: false,
      },
    } as never)

    expect(assignAgentTask).not.toHaveBeenCalled()
    expect(nudgeAgentSession).toHaveBeenCalledWith(expect.objectContaining({ text: '/model opus' }))
  })

  it('rejects --raw without -m', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(
      cmd.run!({ args: { agent: 'builder', raw: true, all: false } } as never),
    ).rejects.toThrow('--raw')
  })

  it('rejects ambiguous mass assignment through --all -m', async () => {
    const { default: cmd } = await import('./nudge')
    await expect(
      cmd.run!({ args: { all: true, message: 'new task', raw: false } } as never),
    ).rejects.toThrow('Refusing to replace every agent assignment')
    expect(assignAgentTask).not.toHaveBeenCalled()
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })

  it('--verify types the canned self-verify request naming the agent check', async () => {
    resolved = {
      state: {
        id: 'proj-id',
        agents: { builder: { id: 'b1', name: 'builder', tmux: true, check: 'npm run ci' } },
      },
      repoRoot: '/fake/root',
    } as never
    const { default: cmd } = await import('./nudge')
    await cmd.run!({ args: { agent: 'builder', all: false, verify: true } } as never)
    const { text } = nudgeAgentSession.mock.calls[0][0]
    expect(text).toContain('npm run ci')
    expect(text).toContain('./agent.sh attest')
  })
})
