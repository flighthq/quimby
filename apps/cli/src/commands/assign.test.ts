import { afterEach, describe, expect, it, vi } from 'vitest'

const assignAgentTask = vi.hoisted(() => vi.fn())
const nudgeAgentSession = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => {}))

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'proj-id', agents, subscriptions: {} }, repoRoot: '/fake/root' }
}

let resolved = workspace({})

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))
// Default assignAgentTask to the real implementation so the existing "not found" test
// exercises real validation; the behavioral tests override per-call.
vi.mock('@quimbyhq/agent', async (importOriginal) => {
  const actual = (await importOriginal()) as { assignAgentTask: typeof assignAgentTask }
  assignAgentTask.mockImplementation(actual.assignAgentTask as never)
  return { ...actual, assignAgentTask }
})
vi.mock('@quimbyhq/session', () => ({ nudgeAgentSession }))

afterEach(() => {
  vi.clearAllMocks()
  resolved = workspace({})
})

describe('run', () => {
  it('is a function', async () => {
    const { default: cmd } = await import('./assign')
    expect(typeof cmd.run).toBe('function')
  })

  it('throws QuimbyError when agent does not exist', async () => {
    const { default: cmd } = await import('./assign')
    await expect(
      cmd.run!({ args: { agent: 'nonexistent', message: 'hello', nudge: false } } as never),
    ).rejects.toThrow('not found')
  })

  it('nudges a running agent over tmux by default (--no-nudge to skip)', async () => {
    const { default: cmd } = await import('./assign')
    const args = cmd.args as Record<string, { type: string; default?: boolean }>
    expect(args.nudge).toMatchObject({ type: 'boolean', default: true })
  })

  it('enacts the nudge with the returned text when nudgeText is set', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    assignAgentTask.mockResolvedValueOnce({
      behind: 0,
      syncFailed: false,
      nudgeText: "Here's your assignment: @assignment.md",
    } as never)
    const { default: cmd } = await import('./assign')
    await cmd.run!({
      args: { agent: 'builder', message: 'do it', nudge: true, sync: true, clear: false },
    } as never)
    expect(nudgeAgentSession).toHaveBeenCalledTimes(1)
    expect(nudgeAgentSession.mock.calls[0][0]).toMatchObject({
      displayName: 'builder',
      text: "Here's your assignment: @assignment.md",
      clear: false,
    })
  })

  it('decodes --sync <ref> into a retarget and --no-sync into a skip', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    assignAgentTask.mockResolvedValue({ behind: 0, syncFailed: false, nudgeText: null } as never)
    const { default: cmd } = await import('./assign')

    // `--sync main` → retarget: sync on, syncRef carried through.
    await cmd.run!({
      args: { agent: 'builder', message: 'x', nudge: false, sync: 'main', clear: false },
    } as never)
    expect(assignAgentTask.mock.calls[0][0]).toMatchObject({ sync: true, syncRef: 'main' })

    // `--no-sync` → citty yields `false`: skip, no retarget.
    await cmd.run!({
      args: { agent: 'builder', message: 'x', nudge: false, sync: false, clear: false },
    } as never)
    expect(assignAgentTask.mock.calls[1][0]).toMatchObject({ sync: false, syncRef: undefined })
  })

  it('passes --verify through to assignAgentTask', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    assignAgentTask.mockResolvedValueOnce({
      behind: 0,
      syncFailed: false,
      nudgeText: null,
    } as never)
    const { default: cmd } = await import('./assign')
    await cmd.run!({
      args: { agent: 'builder', message: 'do it', nudge: false, verify: true, clear: false },
    } as never)
    expect(assignAgentTask.mock.calls[0][0]).toMatchObject({ verify: true })
  })

  it('does not nudge when nudgeText is null (e.g. sync failed or nudge not requested)', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder' } })
    assignAgentTask.mockResolvedValueOnce({
      behind: 0,
      syncFailed: true,
      nudgeText: null,
    } as never)
    const { default: cmd } = await import('./assign')
    await cmd.run!({
      args: { agent: 'builder', message: 'do it', nudge: true, sync: true, clear: false },
    } as never)
    expect(nudgeAgentSession).not.toHaveBeenCalled()
  })
})
