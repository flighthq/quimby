import { describe, expect, it, vi } from 'vitest'

const runStartCommand = vi.hoisted(() => vi.fn(async () => {}))
const getAgentSessionState = vi.hoisted(() => vi.fn(async () => 'running' as string))
const ensureAgentConnections = vi.hoisted(() => vi.fn(async () => {}))
const execaCalls = vi.hoisted(() => [] as string[][])

vi.mock('./start', () => ({ default: {}, runStartCommand }))
vi.mock('@quimbyhq/session', () => ({ getAgentSessionState }))
vi.mock('../hostAlias', () => ({ ensureAgentConnections }))
vi.mock('execa', () => ({
  execa: vi.fn(async (_cmd: string, args: string[]) => {
    execaCalls.push(args)
    return {}
  }),
}))

let stateAgents: Record<string, unknown>
vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveWorkspace: vi.fn(async () => ({
    state: { id: 'proj-id', agents: stateAgents },
    repoRoot: '/repo',
  })),
}))

import { runRestartCommand } from './restart'

describe('runRestartCommand', () => {
  it('kills a running agent session and relaunches it via start', async () => {
    stateAgents = { builder: { id: 'b1', name: 'builder', location: { type: 'local' } } }
    getAgentSessionState.mockResolvedValue('running')
    execaCalls.length = 0
    runStartCommand.mockClear()
    await runRestartCommand({ args: { agent: 'builder' } })
    expect(execaCalls.some((a) => a.includes('kill-session'))).toBe(true)
    expect(runStartCommand).toHaveBeenCalledWith({ args: { agent: 'builder' } })
  })

  it('errors for an unknown agent', async () => {
    stateAgents = {}
    await expect(runRestartCommand({ args: { agent: 'ghost' } })).rejects.toThrow('not found')
  })

  it('--all with nothing running starts nothing', async () => {
    stateAgents = { builder: { id: 'b1', name: 'builder', location: { type: 'local' } } }
    getAgentSessionState.mockResolvedValue('stopped')
    runStartCommand.mockClear()
    await runRestartCommand({ args: { all: true } })
    expect(runStartCommand).not.toHaveBeenCalled()
  })
})
