import { describe, expect, it, vi } from 'vitest'

const setAgentDefaults = vi.hoisted(() => vi.fn(async () => {}))
const setAgentLocation = vi.hoisted(() => vi.fn(async () => {}))
const setAgentTmux = vi.hoisted(() => vi.fn(async () => {}))
const setAgentSyncRef = vi.hoisted(() => vi.fn(async () => {}))
const runAgentWalkthrough = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/agent', () => ({
  setAgentDefaults,
  setAgentLocation,
  setAgentTmux,
  setAgentSyncRef,
}))
vi.mock('../walkthrough', () => ({ runAgentWalkthrough }))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

let resolved: { state: { agents: Record<string, unknown> }; repoRoot: string }

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'p', agents, subscriptions: {} }, repoRoot: '/repo' }
}

describe('runConfigCommand', () => {
  it('throws when the agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./config')
    await expect(cmd.run!({ args: { agent: 'ghost' } } as never)).rejects.toThrow('not found')
  })

  it('does nothing when the walkthrough is cancelled', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    runAgentWalkthrough.mockResolvedValueOnce(undefined)
    setAgentDefaults.mockClear()
    setAgentLocation.mockClear()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(setAgentDefaults).not.toHaveBeenCalled()
    expect(setAgentLocation).not.toHaveBeenCalled()
  })

  it('persists the collected config, defaulting location and tmux', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    runAgentWalkthrough.mockResolvedValueOnce({ runtime: 'sbx', entrypoint: 'claude' })
    setAgentLocation.mockClear()
    setAgentTmux.mockClear()
    setAgentSyncRef.mockClear()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)

    expect(setAgentLocation).toHaveBeenCalledWith('/repo', 'builder', { type: 'local' })
    expect(setAgentTmux).toHaveBeenCalledWith('/repo', 'builder', false)
    // syncRef is only written when the walkthrough returned one.
    expect(setAgentSyncRef).not.toHaveBeenCalled()
  })

  it('writes the sync ref only when the walkthrough returned one', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    runAgentWalkthrough.mockResolvedValueOnce({
      runtime: 'local',
      entrypoint: 'claude',
      tmux: true,
      syncRef: 'release',
    })
    setAgentSyncRef.mockClear()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(setAgentSyncRef).toHaveBeenCalledWith('/repo', 'builder', 'release')
  })
})
