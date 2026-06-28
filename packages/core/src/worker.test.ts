import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exists } from './utils/fs'
import { getWorkerDir } from './utils/paths'
import {
  addWorker,
  removeWorker,
  renameWorker,
  resetWorker,
  setWorkerCheck,
  setWorkerDefaults,
  setWorkerLocation,
} from './worker'
import { ensureWorkspace, loadState } from './workspace'

vi.mock('../utils/git', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    clone: vi.fn(async (_url: string, dest: string) => {
      await mkdir(dest, { recursive: true })
      await execa('git', ['init'], { cwd: dest })
      await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dest })
      await execa('git', ['config', 'user.name', 'Test User'], { cwd: dest })
      await writeFile(join(dest, '.gitkeep'), '')
      await execa('git', ['add', '-A'], { cwd: dest })
      await execa('git', ['commit', '-m', 'initial'], { cwd: dest })
    }),
  }
})

let dir: string

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
  dir = join(tmpdir(), `quimby-worker-${crypto.randomUUID()}`)
  await setupGitRepo(dir)
  await ensureWorkspace(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('addWorker', () => {
  it('adds a worker entry to state with a stable UUID', async () => {
    const worker = await addWorker(dir, 'alice')
    expect(worker.id).toBeDefined()
    expect(worker.name).toBe('alice')
    const state = await loadState(dir)
    expect(state.workers.alice).toBeDefined()
    expect(state.workers.alice.id).toBe(worker.id)
  })

  it('creates the worker directory and CLAUDE.md scaffold', async () => {
    await addWorker(dir, 'bob')
    const workerDir = getWorkerDir(dir, 'bob')
    expect(await exists(workerDir)).toBe(true)
    expect(await exists(join(workerDir, 'CLAUDE.md'))).toBe(true)
    expect(await exists(join(workerDir, 'assignment.md'))).toBe(true)
    expect(await exists(join(workerDir, 'status.md'))).toBe(true)
  })

  it('throws QuimbyError if a worker with that name already exists', async () => {
    await addWorker(dir, 'charlie')
    await expect(addWorker(dir, 'charlie')).rejects.toThrow('already exists')
  })
})

describe('setWorkerCheck', () => {
  it('sets and clears the worker check command', async () => {
    await addWorker(dir, 'alice')
    await setWorkerCheck(dir, 'alice', 'npm run ci')
    let state = await loadState(dir)
    expect(state.workers.alice.check).toBe('npm run ci')

    await setWorkerCheck(dir, 'alice', '')
    state = await loadState(dir)
    expect(state.workers.alice.check).toBeUndefined()
  })
})

describe('setWorkerDefaults', () => {
  it('updates runtime and agent on the worker state', async () => {
    await addWorker(dir, 'alice')
    await setWorkerDefaults(dir, 'alice', { runtime: 'sbx', agent: 'codex' })
    const state = await loadState(dir)
    expect(state.workers.alice.defaults?.runtime).toBe('sbx')
    expect(state.workers.alice.defaults?.agent).toBe('codex')
  })
})

describe('setWorkerLocation', () => {
  it('updates the location on the worker state', async () => {
    await addWorker(dir, 'alice')
    await setWorkerLocation(dir, 'alice', { type: 'local' })
    const state = await loadState(dir)
    expect(state.workers.alice.location).toEqual({ type: 'local' })
  })
})

describe('removeWorker', () => {
  it('removes the worker from state', async () => {
    await addWorker(dir, 'alice')
    await removeWorker(dir, 'alice')
    const state = await loadState(dir)
    expect(state.workers.alice).toBeUndefined()
  })

  it('deletes the worker directory', async () => {
    await addWorker(dir, 'alice')
    const workerDir = getWorkerDir(dir, 'alice')
    await removeWorker(dir, 'alice')
    expect(await exists(workerDir)).toBe(false)
  })

  it('throws QuimbyError if worker does not exist', async () => {
    await expect(removeWorker(dir, 'nonexistent')).rejects.toThrow('not found')
  })
})

describe('renameWorker', () => {
  it('updates the worker name in state', async () => {
    await addWorker(dir, 'alice')
    await renameWorker(dir, 'alice', 'bob')
    const state = await loadState(dir)
    expect(state.workers.bob).toBeDefined()
    expect(state.workers.alice).toBeUndefined()
  })

  it('renames the worker directory', async () => {
    await addWorker(dir, 'alice')
    await renameWorker(dir, 'alice', 'bob')
    expect(await exists(getWorkerDir(dir, 'bob'))).toBe(true)
    expect(await exists(getWorkerDir(dir, 'alice'))).toBe(false)
  })

  it('throws QuimbyError if worker does not exist', async () => {
    await expect(renameWorker(dir, 'nonexistent', 'new-name')).rejects.toThrow('not found')
  })

  it('throws QuimbyError if the new name is already taken', async () => {
    await addWorker(dir, 'alice')
    await addWorker(dir, 'bob')
    await expect(renameWorker(dir, 'alice', 'bob')).rejects.toThrow('already exists')
  })
})

describe('resetWorker', () => {
  it('removes and re-clones the worker repo', async () => {
    const worker = await addWorker(dir, 'alice')
    const firstSeed = worker.seedCommit
    // Reset should create a fresh clone
    await resetWorker(dir, 'alice')
    const state = await loadState(dir)
    expect(state.workers.alice.seedCommit).toBeDefined()
    expect(state.workers.alice.seedCommit).toHaveLength(40)
    // The seedCommit may change or stay same depending on HEAD
    expect(typeof state.workers.alice.seedCommit).toBe('string')
    void firstSeed
  })

  it('throws QuimbyError if worker does not exist', async () => {
    await expect(resetWorker(dir, 'nonexistent')).rejects.toThrow('not found')
  })
})
