import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectingReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sync', () => ({
  getAgentSyncStatus: vi.fn(),
  syncAgent: vi.fn(),
}))

import { assignAgentTask } from './assign'
import { getAgentSyncStatus, syncAgent } from './sync'

const mockedStatus = vi.mocked(getAgentSyncStatus)
const mockedSync = vi.mocked(syncAgent)

let dir: string

function stateWithLocalAgent(): QuimbyState {
  return {
    id: 'proj-uuid',
    sourceRef: 'main',
    subscriptions: {},
    agents: {
      alice: {
        id: 'alice-uuid',
        name: 'alice',
        seedCommit: 'seedcommit',
        syncRef: 'main',
        createdAt: '2024-01-01T00:00:00.000Z',
        location: { type: 'local' },
      },
    },
  } as unknown as QuimbyState
}

function agentDir(): string {
  return join(dir, '.quimby', 'agents', 'alice-uuid')
}

async function readAssignment(): Promise<string> {
  return readFile(join(agentDir(), 'assignment.md'), 'utf-8')
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-assign-${crypto.randomUUID()}`)
  await mkdir(agentDir(), { recursive: true })
  mockedStatus.mockResolvedValue({ behind: 0, syncRef: 'main', targetCommit: 'tip' })
  mockedSync.mockResolvedValue({ newSeed: 'newseedcommit', rebased: false, commitsReplayed: 0 })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('assignAgentTask', () => {
  it('retargets via syncAgent { base } when syncRef is set, even at 0 behind', async () => {
    mockedStatus.mockResolvedValue({ behind: 0, syncRef: 'main', targetCommit: 'tip' })
    const { reporter } = collectingReporter()
    await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: 'go',
        sync: true,
        syncRef: 'release',
        nudge: false,
      },
      reporter,
    )
    expect(mockedSync).toHaveBeenCalledWith(dir, 'alice', { base: 'release' })
  })

  it('writes assignment.md, reports success, and returns the nudge text', async () => {
    const { reporter, events } = collectingReporter()
    const result = await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: 'do the thing',
        sync: true,
        nudge: true,
      },
      reporter,
    )

    expect(await readAssignment()).toBe('do the thing')
    expect(events).toContainEqual({ level: 'success', message: 'Assignment set for "alice"' })
    expect(result.nudgeText).toBe("Here's your assignment: @assignment.md")
    expect(result.syncFailed).toBe(false)
  })

  it('suppresses the nudge when no nudge was requested', async () => {
    const result = await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: 'x',
        sync: true,
        nudge: false,
      },
      collectingReporter().reporter,
    )
    expect(result.nudgeText).toBeNull()
  })

  it('reads the task from a file when the message begins with @', async () => {
    const file = join(dir, 'task.md')
    await writeFile(file, 'from a file')
    await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: `@${file}`,
        sync: false,
        nudge: false,
      },
      collectingReporter().reporter,
    )
    expect(await readAssignment()).toBe('from a file')
  })

  it('throws when the resolved message is empty', async () => {
    await expect(
      assignAgentTask(
        {
          state: stateWithLocalAgent(),
          repoRoot: dir,
          name: 'alice',
          message: '',
          sync: false,
          nudge: true,
        },
        collectingReporter().reporter,
      ),
    ).rejects.toThrow(/Provide a message/)
  })

  it('throws when the agent does not exist', async () => {
    await expect(
      assignAgentTask(
        {
          state: stateWithLocalAgent(),
          repoRoot: dir,
          name: 'ghost',
          message: 'x',
          sync: true,
          nudge: true,
        },
        collectingReporter().reporter,
      ),
    ).rejects.toThrow(/not found/)
  })

  it('skips syncing entirely when sync is false', async () => {
    await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: 'x',
        sync: false,
        nudge: true,
      },
      collectingReporter().reporter,
    )
    expect(mockedStatus).not.toHaveBeenCalled()
    expect(mockedSync).not.toHaveBeenCalled()
  })

  it('suppresses the nudge but keeps the assignment when the pre-assign sync fails', async () => {
    mockedStatus.mockResolvedValue({ behind: 2, syncRef: 'main', targetCommit: 'tip' })
    mockedSync.mockRejectedValue(new Error('rebase conflicts onto abc1234 — aborted'))

    const { reporter, events } = collectingReporter()
    const result = await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: 'still durable',
        sync: true,
        nudge: true,
      },
      reporter,
    )

    expect(result.syncFailed).toBe(true)
    expect(result.nudgeText).toBeNull()
    expect(await readAssignment()).toBe('still durable')
    expect(events.some((e) => e.level === 'warn' && /Sync failed/.test(e.message))).toBe(true)
  })

  it('reports a rebase and nudges when the pre-assign sync succeeds', async () => {
    mockedStatus.mockResolvedValue({ behind: 1, syncRef: 'main', targetCommit: 'tip' })
    mockedSync.mockResolvedValue({ newSeed: 'abcdef1234', rebased: true, commitsReplayed: 3 })

    const { reporter, events } = collectingReporter()
    const result = await assignAgentTask(
      {
        state: stateWithLocalAgent(),
        repoRoot: dir,
        name: 'alice',
        message: 'x',
        sync: true,
        nudge: true,
      },
      reporter,
    )

    expect(events).toContainEqual({
      level: 'success',
      message: 'Rebased 3 commit(s) onto abcdef12',
    })
    expect(result.nudgeText).toBe("Here's your assignment: @assignment.md")
  })
})
