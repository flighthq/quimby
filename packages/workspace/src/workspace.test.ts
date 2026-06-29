import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getStatePath } from '@quimbyhq/paths'
import { ensureDir, exists, writeYaml } from '@quimbyhq/utils'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureWorkspace, loadState, resolveWorkspace, saveState } from './workspace'

let dir: string
let originalCwd: string

async function setupGitRepo(repoDir: string) {
  await mkdir(repoDir, { recursive: true })
  await execa('git', ['init'], { cwd: repoDir })
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
  await writeFile(join(repoDir, 'README.md'), '# Test')
  await execa('git', ['add', '-A'], { cwd: repoDir })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoDir })
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-ws-${crypto.randomUUID()}`)
  originalCwd = process.cwd()
  await setupGitRepo(dir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(dir, { recursive: true, force: true })
})

describe('ensureWorkspace', () => {
  it('creates state.yaml and .gitignore on first call', async () => {
    await ensureWorkspace(dir)
    expect(await exists(getStatePath(dir))).toBe(true)
    expect(await exists(join(dir, '.gitignore'))).toBe(true)
  })

  it('is idempotent — does not overwrite existing state', async () => {
    const first = await ensureWorkspace(dir)
    const second = await ensureWorkspace(dir)
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('migrates state missing id fields by adding stable UUIDs', async () => {
    // Write state without id
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {
        alice: {
          name: 'alice',
          seedCommit: 'abc123',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.id).toBeDefined()
    expect(state.agents.alice.id).toBeDefined()
  })

  it('backfills a missing agent syncRef from the workspace sourceRef', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: 'ws-id',
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      agents: {
        alice: {
          id: 'alice-id',
          name: 'alice',
          seedCommit: 'abc123',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.agents.alice.syncRef).toBe('main')
  })
})

describe('loadState', () => {
  it('reads state.yaml and returns a QuimbyState', async () => {
    await ensureWorkspace(dir)
    const state = await loadState(dir)
    expect(state.id).toBeDefined()
    expect(state.agents).toBeDefined()
    expect(state.sourceRepo).toBeDefined()
  })
})

describe('resolveWorkspace', () => {
  it('resolves the repo root and quimby dir from a git repo', async () => {
    await ensureWorkspace(dir)
    process.chdir(dir)
    const { state, repoRoot } = await resolveWorkspace()
    expect(repoRoot).toBe(dir)
    expect(state.agents).toBeDefined()
  })

  it('migrates legacy schema keys (workers, defaults.agent, check)', async () => {
    await ensureDir(join(dir, '.quimby'))
    await writeYaml(getStatePath(dir), {
      id: 'ws-id',
      sourceRepo: dir,
      sourceRef: 'main',
      snapshot: 'abc123',
      createdAt: '2024-01-01T00:00:00.000Z',
      workers: {
        alice: {
          id: 'alice-id',
          name: 'alice',
          seedCommit: 'abc123',
          createdAt: '2024-01-01T00:00:00.000Z',
          defaults: { runtime: 'sbx', agent: 'claude' },
          check: 'npm run ci',
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect((state as unknown as Record<string, unknown>).workers).toBeUndefined()
    expect(state.agents.alice.defaults?.entrypoint).toBe('claude')
    expect(
      (state.agents.alice.defaults as unknown as Record<string, unknown>).agent,
    ).toBeUndefined()
    expect(state.agents.alice.guard).toBe('npm run ci')
    expect((state.agents.alice as unknown as Record<string, unknown>).check).toBeUndefined()

    // Persisted: a fresh load sees the migrated shape with no further changes.
    const reloaded = await loadState(dir)
    expect(reloaded.agents.alice.defaults?.entrypoint).toBe('claude')
    expect(reloaded.agents.alice.guard).toBe('npm run ci')
  })

  it('throws when called outside a git repo', async () => {
    const notARepo = join(tmpdir(), `not-repo-${crypto.randomUUID()}`)
    await mkdir(notARepo, { recursive: true })
    process.chdir(notARepo)
    try {
      await expect(resolveWorkspace()).rejects.toThrow('Not inside a git repository')
    } finally {
      await rm(notARepo, { recursive: true, force: true })
    }
  })

  it('throws when no state.yaml exists', async () => {
    process.chdir(dir)
    await expect(resolveWorkspace()).rejects.toThrow('No quimby workspace found')
  })
})

describe('saveState', () => {
  it('writes state.yaml with the correct content', async () => {
    const state = await ensureWorkspace(dir)
    state.agents['test-agent'] = {
      id: 'agent-uuid',
      name: 'test-agent',
      seedCommit: 'abc123',
      createdAt: new Date().toISOString(),
    }
    await saveState(dir, state)

    const loaded = await loadState(dir)
    expect(loaded.agents['test-agent']).toBeDefined()
    expect(loaded.agents['test-agent'].id).toBe('agent-uuid')
  })
})
