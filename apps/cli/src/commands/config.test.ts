import { describe, expect, it, vi } from 'vitest'

const setAgentDefaults = vi.hoisted(() => vi.fn(async () => {}))
const setAgentLocation = vi.hoisted(() => vi.fn(async () => {}))
const setAgentTmux = vi.hoisted(() => vi.fn(async () => {}))
const setAgentSyncRef = vi.hoisted(() => vi.fn(async () => {}))
const setAgentRole = vi.hoisted(() => vi.fn(async () => {}))
const setAgentRuntimeProfile = vi.hoisted(() => vi.fn(async () => {}))
const runAgentWalkthrough = vi.hoisted(() => vi.fn())

vi.mock('@quimbyhq/agent', () => ({
  setAgentDefaults,
  setAgentLocation,
  setAgentTmux,
  setAgentSyncRef,
  setAgentRole,
  setAgentRuntimeProfile,
}))
// Keep the real resolveWalkthroughConfig (the coherence mapping under test); mock only the prompts.
vi.mock('../walkthrough', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  runAgentWalkthrough,
}))
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
  loadQuimbyConfig: vi.fn(async () => ({})),
}))

let resolved: { state: { agents: Record<string, unknown> }; repoRoot: string }

function workspace(agents: Record<string, unknown>) {
  return { state: { id: 'p', agents }, repoRoot: '/repo' }
}

function clearSetters() {
  for (const fn of [
    setAgentDefaults,
    setAgentLocation,
    setAgentTmux,
    setAgentSyncRef,
    setAgentRole,
    setAgentRuntimeProfile,
  ]) {
    fn.mockClear()
  }
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
    clearSetters()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)
    expect(setAgentRole).not.toHaveBeenCalled()
    expect(setAgentLocation).not.toHaveBeenCalled()
  })

  it('persists a manual engine as flattened defaults, clearing role and pin', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    runAgentWalkthrough.mockResolvedValueOnce({
      engine: { source: 'manual', runtime: 'sbx', entrypoint: 'claude' },
    })
    clearSetters()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)

    expect(setAgentRole).toHaveBeenCalledWith('/repo', 'builder', undefined)
    expect(setAgentRuntimeProfile).toHaveBeenCalledWith('/repo', 'builder', undefined)
    expect(setAgentDefaults).toHaveBeenCalledWith('/repo', 'builder', {
      runtime: 'sbx',
      entrypoint: 'claude',
      runtimeProfile: undefined,
    })
    expect(setAgentLocation).toHaveBeenCalledWith('/repo', 'builder', { type: 'local' })
    expect(setAgentTmux).toHaveBeenCalledWith('/repo', 'builder', false)
    expect(setAgentSyncRef).not.toHaveBeenCalled()
  })

  it('persists a role engine as a role reference, clearing the flattened defaults', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    runAgentWalkthrough.mockResolvedValueOnce({ role: 'builder', engine: { source: 'role' } })
    clearSetters()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)

    expect(setAgentRole).toHaveBeenCalledWith('/repo', 'builder', 'builder')
    expect(setAgentRuntimeProfile).toHaveBeenCalledWith('/repo', 'builder', undefined)
    expect(setAgentDefaults).toHaveBeenCalledWith('/repo', 'builder', {
      runtime: undefined,
      entrypoint: undefined,
      runtimeProfile: undefined,
    })
  })

  it('persists a profile pin (over a role) and writes a returned sync ref', async () => {
    resolved = workspace({ builder: { id: 'b1', name: 'builder', location: { type: 'local' } } })
    runAgentWalkthrough.mockResolvedValueOnce({
      role: 'builder',
      engine: { source: 'profile', runtimeProfile: 'codex-sbx' },
      syncRef: 'release',
    })
    clearSetters()
    const { default: cmd } = await import('./config')
    await cmd.run!({ args: { agent: 'builder' } } as never)

    expect(setAgentRole).toHaveBeenCalledWith('/repo', 'builder', 'builder')
    expect(setAgentRuntimeProfile).toHaveBeenCalledWith('/repo', 'builder', 'codex-sbx')
    expect(setAgentSyncRef).toHaveBeenCalledWith('/repo', 'builder', 'release')
  })
})
