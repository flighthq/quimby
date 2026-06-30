import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConflictError } from '@quimbyhq/errors'
import { addAll, commit, getCurrentBranch, init, tag } from '@quimbyhq/git'
import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyHandoff } from './apply'
import { assembleHandoff } from './assemble'

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
  const repoRoot = join(tmpdir(), `quimby-apply-${crypto.randomUUID()}`)
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

/**
 * Create the "source" repo that both the agent clone and the target clone derive from.
 * This ensures they share commit history, so the agent's seed commit exists in the target.
 */
async function setupSourceRepo(): Promise<string> {
  const sourceDir = join(tmpdir(), `quimby-source-${crypto.randomUUID()}`)
  await mkdir(sourceDir, { recursive: true })
  await execa('git', ['init'], { cwd: sourceDir })
  await configureGit(sourceDir)
  await writeFile(join(sourceDir, 'base.txt'), 'base content\n')
  await execa('git', ['add', '-A'], { cwd: sourceDir })
  await execa('git', ['commit', '-m', 'base commit'], { cwd: sourceDir })
  return sourceDir
}

async function setupAgentRepo(
  repoRoot: string,
  agentName: string,
  sourceDir: string,
): Promise<string> {
  const agentRepoDir = getAgentRepoDir(repoRoot, agentName)
  const agentDir = getAgentDir(repoRoot, agentName)
  await mkdir(join(agentDir, 'inbox', 'status'), { recursive: true })
  await mkdir(join(agentDir, 'outbox'), { recursive: true })
  await execa('git', ['clone', sourceDir, agentRepoDir])
  await configureGit(agentRepoDir)
  await tag(agentRepoDir, 'quimby/seed')
  return agentRepoDir
}

async function setupTargetRepo(sourceDir: string): Promise<string> {
  const targetDir = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
  await execa('git', ['clone', sourceDir, targetDir])
  await configureGit(targetDir)
  return targetDir
}

beforeEach(async () => {
  dir = await setupRepoRoot()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('applyHandoff', () => {
  for (const mode of ['squashed', 'commits', 'patch'] as const) {
    it(`applies a code parcel to the host repo (${mode} mode)`, async () => {
      const sourceDir = await setupSourceRepo()
      const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
      await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
      await addAll(agentRepoDir)
      await commit(agentRepoDir, 'add feature')
      const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
      const targetDir = await setupTargetRepo(sourceDir)
      try {
        await applyHandoff({ repoRoot: dir, name: meta.name, targetRepoPath: targetDir, mode })
        expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      } finally {
        await rm(targetDir, { recursive: true, force: true })
        await rm(sourceDir, { recursive: true, force: true })
      }
    })
  }

  it('applies cleanly in patch mode leaving changes in the working tree', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'patch',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('throws ConflictError when the merge conflicts', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'base.txt'), 'modified by agent\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'modify base')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await writeFile(join(targetDir, 'base.txt'), 'modified by target\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'diverge'], { cwd: targetDir })
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'squashed',
        }),
      ).rejects.toThrow(ConflictError)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('cleans up the temp branch after a successful apply', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const result = await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
      })
      const { stdout } = await execa('git', ['branch', '--list', result.tempBranch], {
        cwd: targetDir,
      })
      expect(stdout.trim()).toBe('')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('leaves the target on its original branch after a successful apply', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const branchBefore = await getCurrentBranch(targetDir)
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
      })
      const branchAfter = await getCurrentBranch(targetDir)
      expect(branchAfter).toBe(branchBefore)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('uses the provided message for the merge commit', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
        message: 'feat: integrate alice work',
      })
      const { stdout } = await execa('git', ['log', '-1', '--format=%s'], { cwd: targetDir })
      expect(stdout.trim()).toBe('feat: integrate alice work')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('merges settled files cleanly when agent is behind', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'shipped.txt'), 'already shipped\n')
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'work')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })

    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await writeFile(join(targetDir, 'shipped.txt'), 'already shipped\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'ship'], { cwd: targetDir })

      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      expect(await readFile(join(targetDir, 'shipped.txt'), 'utf-8')).toBe('already shipped\n')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })
})
