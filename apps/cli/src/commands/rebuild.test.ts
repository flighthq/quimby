import { describe, expect, it, vi } from 'vitest'

const execa = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})))
const rebuildAgent = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('execa', () => ({ execa }))
vi.mock('@quimbyhq/agent', () => ({ rebuildAgent }))

let agents: Record<string, unknown>

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents },
    repoRoot: '/fake/root',
  })),
  loadState: vi.fn(async () => ({
    id: 'proj-id',
    agents: { builder: { id: 'b1', name: 'builder', seedCommit: 'abcdef1234567890' } },
  })),
}))

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./rebuild')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws when the agent does not exist', async () => {
    agents = {}
    const { default: cmd } = await import('./rebuild')
    await expect(cmd.run!({ args: { agent: 'ghost', force: true } } as never)).rejects.toThrow(
      'not found',
    )
  })

  it('rejects --all with a message naming the flag, not a missing-positional error', async () => {
    agents = {}
    const { default: cmd } = await import('./rebuild')
    await expect(cmd.run!({ args: { all: true, force: true } } as never)).rejects.toThrow(
      /rebuild does not support --all/,
    )
  })

  it('asks for an agent when none is given', async () => {
    agents = {}
    const { default: cmd } = await import('./rebuild')
    await expect(cmd.run!({ args: { force: true } } as never)).rejects.toThrow('Specify an agent')
  })

  it('warns and rebuilds nothing without --force', async () => {
    agents = { builder: { id: 'b1', name: 'builder', location: { type: 'local' } } }
    rebuildAgent.mockClear()
    const { default: cmd } = await import('./rebuild')
    await cmd.run!({ args: { agent: 'builder', force: false } } as never)
    expect(rebuildAgent).not.toHaveBeenCalled()
  })

  it('stops the live session and tears down the sandbox before rebuilding', async () => {
    agents = {
      builder: {
        id: 'b1',
        name: 'builder',
        location: { type: 'local' },
        tmux: true,
        defaults: { runtime: 'sbx' },
      },
    }
    execa.mockClear()
    rebuildAgent.mockClear()
    const { default: cmd } = await import('./rebuild')
    await cmd.run!({ args: { agent: 'builder', force: true } } as never)

    // The session is killed and the sbx sandbox removed, both before the re-clone.
    const bins = execa.mock.calls.map((c) => c[0])
    const killed = execa.mock.calls.some((c) => (c[1] as string[])?.includes('kill-session'))
    expect(killed).toBe(true)
    expect(bins).toContain('sbx')
    expect(rebuildAgent).toHaveBeenCalledWith('/fake/root', 'builder')
  })
})
