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

describe('resolveWorkspace', () => {
  it('resolves the repo root and quimby dir from a git repo', async () => {
    await ensureWorkspace(dir)
    process.chdir(dir)
    const { state, repoRoot } = await resolveWorkspace()
    expect(repoRoot).toBe(dir)
    expect(state.workers).toBeDefined()
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
      workers: {
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
    expect(state.workers.alice.id).toBeDefined()
  })

  it('backfills a missing worker syncRef from the workspace sourceRef', async () => {
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
        },
      },
    })
    process.chdir(dir)
    const { state } = await resolveWorkspace()
    expect(state.workers.alice.syncRef).toBe('main')
  })
})

describe('loadState', () => {
  it('reads state.yaml and returns a QuimbyState', async () => {
    await ensureWorkspace(dir)
    const state = await loadState(dir)
    expect(state.id).toBeDefined()
    expect(state.workers).toBeDefined()
    expect(state.sourceRepo).toBeDefined()
  })
})

describe('saveState', () => {
  it('writes state.yaml with the correct content', async () => {
    const state = await ensureWorkspace(dir)
    state.workers['test-worker'] = {
      id: 'worker-uuid',
      name: 'test-worker',
      seedCommit: 'abc123',
      createdAt: new Date().toISOString(),
    }
    await saveState(dir, state)

    const loaded = await loadState(dir)
    expect(loaded.workers['test-worker']).toBeDefined()
    expect(loaded.workers['test-worker'].id).toBe('worker-uuid')
  })
})
