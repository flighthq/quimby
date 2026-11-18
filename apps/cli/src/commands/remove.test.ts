import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))
const removeAgent = vi.hoisted(() => vi.fn(async () => {}))
const saveState = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('execa', () => ({ execa }))
// The sandbox sweep is tested in agentTeardown.test.ts; here only that it runs, and in order.
const teardownAgentSandbox = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
const resolveForTeardown = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock('../agentTeardown', () => ({ teardownAgentSandbox, resolveForTeardown }))
vi.mock('@quimbyhq/agent', () => ({ removeAgent }))

let resolved: {
  state: { id: string; agents: Record<string, unknown> }
  repoRoot: string
}

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
  loadState: vi.fn(async () => ({
    id: 'proj-id',
    agents: { researcher: {} },
  })),
  saveState,
}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents }, repoRoot: '/fake/root' }
}

describe('runRemoveCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./remove')
    await expect(cmd.run!({ args: { agent: 'ghost', force: false } } as never)).rejects.toThrow(
      'not found',
    )
  })

  it('warns and removes nothing without --force (destructive-action gate)', async () => {
    resolved = workspace({
      builder: { id: 'b1', name: 'builder', location: { type: 'local' }, tmux: true },
    })
    execa.mockClear()
    removeAgent.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'builder', force: false } } as never)
    expect(removeAgent).not.toHaveBeenCalled()
    expect(execa).not.toHaveBeenCalled()
  })

  it('kills the tmux session for a running local agent before removing it', async () => {
    resolved = workspace({
      builder: { id: 'b1', name: 'builder', location: { type: 'local' }, tmux: true },
    })
    execa.mockClear()
    removeAgent.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'builder', force: true } } as never)
    const argv = execa.mock.calls[0]?.[1] as string[]
    expect(argv).toContain('kill-session')
    expect(removeAgent).toHaveBeenCalledWith('/fake/root', 'builder', expect.anything())
  })

  it('does not attempt a tmux kill for a local agent that was never run', async () => {
    resolved = workspace({ plain: { id: 'p1', name: 'plain', location: { type: 'local' } } })
    execa.mockClear()
    removeAgent.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'plain', force: true } } as never)
    expect(execa).not.toHaveBeenCalled()
    expect(removeAgent).toHaveBeenCalledWith('/fake/root', 'plain', expect.anything())
  })

  it('tolerates an unreachable SSH host, removing local state anyway', async () => {
    resolved = workspace({
      researcher: { id: 'r1', name: 'researcher', location: { type: 'ssh', host: 'user@box' } },
    })
    removeAgent.mockRejectedValueOnce(new Error('ssh: connect timed out'))
    saveState.mockClear()
    const { default: cmd } = await import('./remove')
    // Does not throw — the remote failure is tolerated.
    await expect(
      cmd.run!({ args: { agent: 'researcher', force: true } } as never),
    ).resolves.toBeUndefined()
    expect(removeAgent).toHaveBeenCalledWith('/fake/root', 'researcher', expect.anything())
    expect(saveState).toHaveBeenCalled() // local state removed as the fallback
  })

  it('passes the RESOLVED location down, since state stores only the host alias', async () => {
    // The reported leak: an alias-backed agent had no host to connect to, so its session, sandbox
    // and remote directory all survived a "successful" remove.
    resolved = workspace({
      researcher: { id: 'r1', name: 'researcher', location: { type: 'ssh', alias: 'remote' } },
    })
    resolveForTeardown.mockImplementationOnce(async (_root, state, name) => {
      const s = state as { agents: Record<string, { location: unknown }> }
      s.agents[name as string].location = { type: 'ssh', alias: 'remote', host: 'me@box' }
      return true
    })
    removeAgent.mockClear()
    teardownAgentSandbox.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'researcher', force: true } } as never)
    expect(removeAgent).toHaveBeenCalledWith('/fake/root', 'researcher', {
      location: { type: 'ssh', alias: 'remote', host: 'me@box' },
    })
    expect(teardownAgentSandbox).toHaveBeenCalled()
  })

  it('still drops an agent whose alias cannot be resolved, without touching the host', async () => {
    resolved = workspace({
      researcher: { id: 'r1', name: 'researcher', location: { type: 'ssh', alias: 'remote' } },
    })
    resolveForTeardown.mockResolvedValueOnce(false)
    removeAgent.mockClear()
    teardownAgentSandbox.mockClear()
    saveState.mockClear()
    const { default: cmd } = await import('./remove')
    await cmd.run!({ args: { agent: 'researcher', force: true } } as never)
    expect(removeAgent).not.toHaveBeenCalled()
    expect(teardownAgentSandbox).not.toHaveBeenCalled()
    expect(saveState).toHaveBeenCalled()
  })
})
