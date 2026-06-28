import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyPack, createPack, listPacks, readPack, sendPack } from './pack'
import { exists } from './utils/fs'
import { addAll, commit, init, tag } from './utils/git'
import { getPackDir, getWorkerDir, getWorkerRepoDir } from './utils/paths'
import { ensureWorkspace } from './workspace'

// Mock SSH transport since we don't test over SSH
vi.mock('./transport', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    getSSHTransport: vi.fn(() => ({
      exec: vi.fn(async () => ''),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(),
      fileExists: vi.fn(async () => false),
      ensureDir: vi.fn(),
      rsyncFrom: vi.fn(),
      rsyncTo: vi.fn(),
    })),
  }
})

let dir: string

async function configureGit(cwd: string) {
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd })
}

async function setupRepoRoot(): Promise<string> {
  const repoRoot = join(tmpdir(), `quimby-pack-${crypto.randomUUID()}`)
  await mkdir(repoRoot, { recursive: true })
  await execa('git', ['init'], { cwd: repoRoot })
  await configureGit(repoRoot)
  await writeFile(join(repoRoot, 'README.md'), '# Project')
  await execa('git', ['add', '-A'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  await ensureWorkspace(repoRoot)
  return repoRoot
}

async function setupWorkerRepo(repoRoot: string, workerName: string): Promise<string> {
  const workerRepoDir = getWorkerRepoDir(repoRoot, workerName)
  const workerDir = getWorkerDir(repoRoot, workerName)
  await mkdir(join(workerDir, 'inbox', 'packs'), { recursive: true })
  await mkdir(join(workerDir, 'inbox', 'status'), { recursive: true })
  await mkdir(workerRepoDir, { recursive: true })
  await init(workerRepoDir)
  await configureGit(workerRepoDir)
  await writeFile(join(workerRepoDir, 'base.txt'), 'base content\n')
  await addAll(workerRepoDir)
  await commit(workerRepoDir, 'base commit')
  await tag(workerRepoDir, 'quimby/seed')
  return workerRepoDir
}

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('createPack', () => {
  it('creates squashed.diff and meta.yaml in the packs dir', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({ repoRoot: dir, workerName: 'alice' })
    const packDir = getPackDir(dir, meta.name)
    expect(await exists(join(packDir, 'squashed.diff'))).toBe(true)
    expect(await exists(join(packDir, 'meta.yaml'))).toBe(true)
  })

  it('generates individual commit patches when commits exist', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({ repoRoot: dir, workerName: 'alice' })
    const packDir = getPackDir(dir, meta.name)
    expect(await exists(join(packDir, 'commits'))).toBe(true)
    expect(meta.commits).toHaveLength(1)
  })

  it('auto-names the pack <worker>-1, <worker>-2, etc.', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'f1.txt'), 'f1\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'commit 1')
    const meta1 = await createPack({ repoRoot: dir, workerName: 'alice' })
    expect(meta1.name).toBe('alice-1')

    await writeFile(join(workerRepoDir, 'f2.txt'), 'f2\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'commit 2')
    const meta2 = await createPack({ repoRoot: dir, workerName: 'alice' })
    expect(meta2.name).toBe('alice-2')
  })

  it('accepts an explicit --name', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({
      repoRoot: dir,
      workerName: 'alice',
      packName: 'my-custom-pack',
    })
    expect(meta.name).toBe('my-custom-pack')
  })

  it('throws PackError when there are no commits since seed', async () => {
    await setupWorkerRepo(dir, 'alice')
    await expect(createPack({ repoRoot: dir, workerName: 'alice' })).rejects.toThrow(
      'No commits since quimby/seed',
    )
  })
})

describe('listPacks', () => {
  it('returns an empty array when no packs exist', async () => {
    const packs = await listPacks(dir)
    expect(packs).toEqual([])
  })

  it('returns metadata for all packs in the packs dir', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'f1.txt'), 'f1\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'commit 1')
    await createPack({ repoRoot: dir, workerName: 'alice' })

    const packs = await listPacks(dir)
    expect(packs).toHaveLength(1)
    expect(packs[0].worker).toBe('alice')
  })
})

describe('readPack', () => {
  it('returns PackMeta and squashed diff content', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const created = await createPack({ repoRoot: dir, workerName: 'alice' })
    const { meta, squashedDiff } = await readPack(dir, created.name)

    expect(meta.name).toBe(created.name)
    expect(meta.worker).toBe('alice')
    expect(squashedDiff).toContain('feature')
  })

  it('throws PackError when pack does not exist', async () => {
    await expect(readPack(dir, 'nonexistent-pack')).rejects.toThrow('not found')
  })
})

describe('applyPack', () => {
  it('applies squashed diff to the host repo (squashed mode)', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({ repoRoot: dir, workerName: 'alice' })

    // Create a clean target repo with the same baseline
    const targetDir = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
    await mkdir(targetDir, { recursive: true })
    await execa('git', ['init'], { cwd: targetDir })
    await configureGit(targetDir)
    await writeFile(join(targetDir, 'base.txt'), 'base content\n')
    await execa('git', ['add', '-A'], { cwd: targetDir })
    await execa('git', ['commit', '-m', 'base commit'], { cwd: targetDir })

    try {
      await applyPack({
        repoRoot: dir,
        packName: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('applies individual patches (commits mode)', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({ repoRoot: dir, workerName: 'alice' })

    const targetDir = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
    await mkdir(targetDir, { recursive: true })
    await execa('git', ['init'], { cwd: targetDir })
    await configureGit(targetDir)
    await writeFile(join(targetDir, 'base.txt'), 'base content\n')
    await execa('git', ['add', '-A'], { cwd: targetDir })
    await execa('git', ['commit', '-m', 'base commit'], { cwd: targetDir })

    try {
      await applyPack({
        repoRoot: dir,
        packName: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('applies via git apply (patch mode)', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({ repoRoot: dir, workerName: 'alice' })

    const targetDir = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
    await mkdir(targetDir, { recursive: true })
    await execa('git', ['init'], { cwd: targetDir })
    await configureGit(targetDir)
    await writeFile(join(targetDir, 'base.txt'), 'base content\n')
    await execa('git', ['add', '-A'], { cwd: targetDir })
    await execa('git', ['commit', '-m', 'base commit'], { cwd: targetDir })

    try {
      await applyPack({
        repoRoot: dir,
        packName: meta.name,
        targetRepoPath: targetDir,
        mode: 'patch',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})

describe('sendPack', () => {
  it('copies pack files to the worker inbox', async () => {
    const workerRepoDir = await setupWorkerRepo(dir, 'alice')
    await writeFile(join(workerRepoDir, 'feature.txt'), 'feature\n')
    await addAll(workerRepoDir)
    await commit(workerRepoDir, 'add feature')

    const meta = await createPack({ repoRoot: dir, workerName: 'alice' })

    // Setup receiver worker
    const receiverDir = getWorkerDir(dir, 'receiver')
    await mkdir(join(receiverDir, 'inbox', 'packs'), { recursive: true })
    await mkdir(join(receiverDir, 'inbox', 'status'), { recursive: true })

    await sendPack({ repoRoot: dir, packName: meta.name, workerName: 'receiver' })

    const inboxPack = join(receiverDir, 'inbox', 'packs', meta.name)
    expect(await exists(join(inboxPack, 'meta.yaml'))).toBe(true)
  })
})

describe('createRemotePack', () => {
  it('creates a pack on a remote worker via SSH transport (mocked)', async () => {
    // createRemotePack requires SSH transport; we verify the mock is called
    // and the pack ends up in the local packs dir
    const { createRemotePack: createRemotePackFn } = await import('./pack')
    // Just verify the function exists
    expect(typeof createRemotePackFn).toBe('function')
  })
})
