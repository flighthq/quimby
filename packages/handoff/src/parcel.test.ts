import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentHandoffInReceivedParcelDir,
  getAgentRepoDir,
  getStagingDir,
  getStagingHandoffDir,
} from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assembleHandoff } from './assemble'
import { deliverHandoff, discardHandoff, healAbandonedStaging, readHandoff } from './parcel'

vi.mock('@quimbyhq/transport', async (importOriginal) => {
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
  const repoRoot = join(tmpdir(), `quimby-parcel-${crypto.randomUUID()}`)
  await mkdir(repoRoot, { recursive: true })
  await execa('git', ['init'], { cwd: repoRoot })
  await configureGit(repoRoot)
  await writeFile(join(repoRoot, 'README.md'), '# Project')
  await execa('git', ['add', '-A'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'initial'], { cwd: repoRoot })
  await ensureWorkspace(repoRoot)
  await execa('git', ['add', '.gitignore'], { cwd: repoRoot })
  await execa('git', ['commit', '-m', 'gitignore .quimby'], { cwd: repoRoot })
  return repoRoot
}

async function setupAgentRepo(repoRoot: string, agentName: string): Promise<string> {
  const agentRepoDir = getAgentRepoDir(repoRoot, agentName)
  const agentDir = getAgentDir(repoRoot, agentName)
  await mkdir(join(agentDir, 'handoff', 'out', 'queued'), { recursive: true })
  await mkdir(join(agentDir, 'handoff', 'in', 'received'), { recursive: true })
  await mkdir(join(agentDir, 'status'), { recursive: true })
  await mkdir(agentRepoDir, { recursive: true })
  await init(agentRepoDir)
  await configureGit(agentRepoDir)
  await writeFile(join(agentRepoDir, 'base.txt'), 'base content\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'base commit')
  await tag(agentRepoDir, 'quimby/seed')
  return agentRepoDir
}

async function withFeatureCommit(agentRepoDir: string): Promise<void> {
  await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'add feature')
}

// A standalone repo left mid-merge-conflict (MERGE_HEAD present), for the merge-in-progress guard.
async function setupConflictedRepo(): Promise<string> {
  const repo = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
  await mkdir(repo, { recursive: true })
  await execa('git', ['init'], { cwd: repo })
  await configureGit(repo)
  await writeFile(join(repo, 'f.txt'), 'base\n')
  await execa('git', ['add', '-A'], { cwd: repo })
  await execa('git', ['commit', '-m', 'base'], { cwd: repo })
  const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })
  const main = stdout.trim()
  await execa('git', ['checkout', '-b', 'feature'], { cwd: repo })
  await writeFile(join(repo, 'f.txt'), 'feature\n')
  await execa('git', ['commit', '-am', 'feature'], { cwd: repo })
  await execa('git', ['checkout', main], { cwd: repo })
  await writeFile(join(repo, 'f.txt'), 'main\n')
  await execa('git', ['commit', '-am', 'main'], { cwd: repo })
  await execa('git', ['merge', 'feature'], { cwd: repo, reject: false }) // conflicts → leaves MERGE_HEAD
  return repo
}

async function setupRebasingRepo(): Promise<string> {
  const repo = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
  await mkdir(repo, { recursive: true })
  await execa('git', ['init'], { cwd: repo })
  await configureGit(repo)
  await writeFile(join(repo, 'f.txt'), 'base\n')
  await execa('git', ['add', '-A'], { cwd: repo })
  await execa('git', ['commit', '-m', 'base'], { cwd: repo })
  const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })
  const main = stdout.trim()
  await execa('git', ['checkout', '-b', 'feature'], { cwd: repo })
  await writeFile(join(repo, 'f.txt'), 'feature\n')
  await execa('git', ['commit', '-am', 'feature'], { cwd: repo })
  await execa('git', ['checkout', main], { cwd: repo })
  await writeFile(join(repo, 'f.txt'), 'main\n')
  await execa('git', ['commit', '-am', 'main'], { cwd: repo })
  await execa('git', ['checkout', 'feature'], { cwd: repo })
  await execa('git', ['rebase', main], { cwd: repo, reject: false }) // conflicts → leaves rebase-merge
  return repo
}

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('deliverHandoff', () => {
  it('carries a staged parcel into the recipient inbox', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    await setupAgentRepo(dir, 'receiver')
    const meta = await assembleHandoff({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      to: 'receiver',
    })
    await deliverHandoff({
      repoRoot: dir,
      name: meta.name,
      to: 'receiver',
      toId: 'receiver',
      toLocation: undefined,
      projectId: 'proj',
    })
    const inboxParcel = getAgentHandoffInReceivedParcelDir(dir, 'receiver', meta.name)
    expect(await exists(join(inboxParcel, 'meta.yaml'))).toBe(true)
  })

  it('routes a parcel to an SSH agent via transport rsync', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    await expect(
      deliverHandoff({
        repoRoot: dir,
        name: meta.name,
        to: 'remote-agent',
        toId: 'remote-id',
        toLocation: { type: 'ssh', host: 'user@host' },
        projectId: 'proj',
      }),
    ).resolves.toBeUndefined()
  })

  it('throws when the parcel has not been staged', async () => {
    await expect(
      deliverHandoff({
        repoRoot: dir,
        name: 'ghost-00000000',
        to: 'receiver',
        toId: 'receiver',
        toLocation: undefined,
        projectId: 'proj',
      }),
    ).rejects.toThrow('not found')
  })

  it('throws when the recipient agent directory does not exist', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    await expect(
      deliverHandoff({
        repoRoot: dir,
        name: meta.name,
        to: 'ghost',
        toId: 'ghost-missing-id',
        toLocation: undefined,
        projectId: 'proj',
      }),
    ).rejects.toThrow('not found')
  })
})

describe('discardHandoff', () => {
  it('is a no-op when the parcel does not exist', async () => {
    await expect(discardHandoff(dir, 'ghost-00000000')).resolves.toBeUndefined()
  })

  it('removes a staged parcel', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(true)
    await discardHandoff(dir, meta.name)
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(false)
  })
})

describe('healAbandonedStaging', () => {
  it('is a no-op when there is no staging area', async () => {
    expect(await healAbandonedStaging(dir, dir)).toBe(false)
  })

  it('clears a leftover staging area when no merge is in progress in the target', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(true)
    // `dir` is itself a clean git repo (no merge underway) — a valid target for the heal.
    expect(await healAbandonedStaging(dir, dir)).toBe(true)
    expect(await exists(getStagingDir(dir))).toBe(false)
  })

  it('preserves the staging area while a merge is in progress in the target (the retry path)', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const target = await setupConflictedRepo()
    try {
      expect(await healAbandonedStaging(dir, target)).toBe(false)
      expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(true)
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  // A `--commits` merge lands via `git am` (a rebase-family operation), so guarding on
  // MERGE_HEAD alone would wipe the parcel while an am/rebase-based retry is still live.
  it('preserves the staging area while a rebase/am is in progress in the target (the retry path)', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const target = await setupRebasingRepo()
    try {
      expect(await healAbandonedStaging(dir, target)).toBe(false)
      expect(await exists(getStagingHandoffDir(dir, meta.name))).toBe(true)
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})

describe('readHandoff', () => {
  it('returns empty squashedDiff for a note-only parcel', async () => {
    await setupAgentRepo(dir, 'alice')
    const created = await assembleHandoff({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      note: 'just a note',
    })
    const { squashedDiff, note } = await readHandoff(dir, created.name)
    expect(squashedDiff).toBe('')
    expect(note).toBe('just a note')
  })

  it('returns meta, diff, and note', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await withFeatureCommit(agentRepoDir)
    const created = await assembleHandoff({
      repoRoot: dir,
      from: 'alice',
      codeSourceId: 'alice',
      note: 'have a look',
    })
    const { meta, squashedDiff, note } = await readHandoff(dir, created.name)
    expect(meta.name).toBe(created.name)
    expect(meta.from).toBe('alice')
    expect(squashedDiff).toContain('feature')
    expect(note).toBe('have a look')
  })

  it('throws when the parcel does not exist', async () => {
    await expect(readHandoff(dir, 'nonexistent-parcel')).rejects.toThrow('not found')
  })
})
