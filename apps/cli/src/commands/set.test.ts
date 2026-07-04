import type { AgentLocation } from '@quimbyhq/types'
import { describe, expect, it, vi } from 'vitest'

const setAgentLocation = vi.hoisted(() => vi.fn(async () => {}))
const setAgentDefaults = vi.hoisted(() => vi.fn(async () => {}))
const setAgentSyncRef = vi.hoisted(() => vi.fn(async () => {}))
const setAgentCheckCommand = vi.hoisted(() => vi.fn(async () => {}))
const setAgentVerifyByDefault = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/agent', () => ({
  setAgentLocation,
  setAgentDefaults,
  setAgentSyncRef,
  setAgentCheckCommand,
  setAgentVerifyByDefault,
}))

let resolved: {
  state: { id: string; agents: Record<string, { location: AgentLocation }>; subscriptions: object }
  repoRoot: string
}

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => resolved),
}))

function workspace(agents: Record<string, { location: AgentLocation }>) {
  return { state: { id: 'proj-id', agents, subscriptions: {} }, repoRoot: '/fake/root' }
}

describe('run', () => {
  it('is a function', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./set')
    expect(typeof cmd.run).toBe('function')
  })

  it('does not alias --cmd to -c, keeping -c reserved for --clear', async () => {
    const { default: cmd } = await import('./set')
    expect((cmd.args as Record<string, { alias?: string }>).cmd.alias).toBeUndefined()
  })

  it('throws when agent does not exist', async () => {
    resolved = workspace({})
    const { default: cmd } = await import('./set')
    await expect(
      cmd.run!({ args: { agent: 'nonexistent', runtime: 'local' } } as never),
    ).rejects.toThrow('not found')
  })

  it('--local converts an SSH agent back to a local location', async () => {
    resolved = workspace({ researcher: { location: { type: 'ssh', host: 'user@box' } } })
    setAgentLocation.mockClear()
    const { default: cmd } = await import('./set')
    await cmd.run!({ args: { agent: 'researcher', local: true } } as never)
    expect(setAgentLocation).toHaveBeenCalledWith('/fake/root', 'researcher', { type: 'local' })
  })

  it('--check sets the agent verification command', async () => {
    resolved = workspace({ builder: { location: { type: 'local' } } })
    setAgentCheckCommand.mockClear()
    const { default: cmd } = await import('./set')
    await cmd.run!({ args: { agent: 'builder', check: 'npm run ci' } } as never)
    expect(setAgentCheckCommand).toHaveBeenCalledWith('/fake/root', 'builder', 'npm run ci')
  })

  it('--verify-by-default updates the advisory check default', async () => {
    resolved = workspace({ builder: { location: { type: 'local' } } })
    setAgentVerifyByDefault.mockClear()
    const { default: cmd } = await import('./set')
    await cmd.run!({ args: { agent: 'builder', verifyByDefault: true } } as never)
    expect(setAgentVerifyByDefault).toHaveBeenCalledWith('/fake/root', 'builder', true)
  })

  it('--runtime-profile updates the saved runtime profile reference', async () => {
    resolved = workspace({ builder: { location: { type: 'local' } } })
    setAgentDefaults.mockClear()
    const { default: cmd } = await import('./set')
    await cmd.run!({ args: { agent: 'builder', runtimeProfile: 'openshellOllama' } } as never)
    expect(setAgentDefaults).toHaveBeenCalledWith('/fake/root', 'builder', {
      runtimeProfile: 'openshellOllama',
    })
  })

  it('--runtime-profile "" clears the saved runtime profile reference', async () => {
    resolved = workspace({ builder: { location: { type: 'local' } } })
    setAgentDefaults.mockClear()
    const { default: cmd } = await import('./set')
    await cmd.run!({ args: { agent: 'builder', runtimeProfile: '' } } as never)
    expect(setAgentDefaults).toHaveBeenCalledWith('/fake/root', 'builder', {
      runtimeProfile: undefined,
    })
  })

  it('--local errors clearly when the agent is already local', async () => {
    resolved = workspace({ builder: { location: { type: 'local' } } })
    const { default: cmd } = await import('./set')
    await expect(cmd.run!({ args: { agent: 'builder', local: true } } as never)).rejects.toThrow(
      'already local',
    )
  })

  it('--local cannot be combined with --host', async () => {
    resolved = workspace({ researcher: { location: { type: 'ssh', host: 'user@box' } } })
    const { default: cmd } = await import('./set')
    await expect(
      cmd.run!({ args: { agent: 'researcher', local: true, host: 'user@other' } } as never),
    ).rejects.toThrow('cannot be combined')
  })
})
