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

  it('leaves the uncommitted remainder in the working tree (commits mode)', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    await writeFile(join(agentRepoDir, 'wip.txt'), 'work in progress\n')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const result = await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      expect(result.leftUncommitted).toBe(true)
      const { stdout: log } = await execa('git', ['log', '--format=%s'], { cwd: targetDir })
      expect(log).toContain('add feature')
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: targetDir })
      expect(status).toContain('wip.txt')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('commits the remainder when a message is given (commits mode)', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    await writeFile(join(agentRepoDir, 'wip.txt'), 'work in progress\n')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const result = await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
        message: 'wip: finish the feature',
      })
      expect(result.leftUncommitted).toBe(false)
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: targetDir })
      expect(status.trim()).toBe('')
      const { stdout: log } = await execa('git', ['log', '--format=%s'], { cwd: targetDir })
      expect(log).toContain('add feature')
      expect(log).toContain('wip: finish the feature')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('flags leftUncommitted for patch but not for squashed', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    try {
      const squashedTarget = await setupTargetRepo(sourceDir)
      const patchTarget = await setupTargetRepo(sourceDir)
      try {
        const squashed = await applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: squashedTarget,
          mode: 'squashed',
        })
        const patched = await applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: patchTarget,
          mode: 'patch',
        })
        expect(squashed.leftUncommitted).toBe(false)
        expect(patched.leftUncommitted).toBe(true)
      } finally {
        await rm(squashedTarget, { recursive: true, force: true })
        await rm(patchTarget, { recursive: true, force: true })
      }
    } finally {
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

  it('uses the provided message for the landed commit', async () => {
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

  it('fast-forwards to a single commit when the target is still at the seed', async () => {
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
      })
      // A fast-forward leaves HEAD with a single parent — no merge commit / boundary node.
      const { stdout } = await execa('git', ['log', '-1', '--format=%P'], { cwd: targetDir })
      expect(stdout.trim().split(/\s+/)).toHaveLength(1)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('creates a standard merge commit when the target has diverged', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      // Move the target past the seed with a non-conflicting commit, forcing a real merge.
      await writeFile(join(targetDir, 'unrelated.txt'), 'host work\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'host work'], { cwd: targetDir })
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
      })
      const { stdout } = await execa('git', ['log', '-1', '--format=%P%n%s'], { cwd: targetDir })
      const [parents, subject] = stdout.split('\n')
      expect(parents.trim().split(/\s+/)).toHaveLength(2)
      expect(subject).toMatch(/^Merge branch/)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('commits mode replays each agent commit as its own commit', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'a.txt'), 'a\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'first change')
    await writeFile(join(agentRepoDir, 'b.txt'), 'b\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'second change')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      const { stdout } = await execa('git', ['log', '--format=%s'], { cwd: targetDir })
      const subjects = stdout.split('\n')
      // both commits land as distinct commits (git am), not a single squashed one
      expect(subjects).toContain('first change')
      expect(subjects).toContain('second change')
      expect(await exists(join(targetDir, 'a.txt'))).toBe(true)
      expect(await exists(join(targetDir, 'b.txt'))).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('commits mode replays commits and leaves the uncommitted remainder loose in the working tree', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    // Uncommitted work on top of the commit — captured as the remainder.
    await writeFile(join(agentRepoDir, 'remainder.txt'), 'still in progress\n')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      expect(await exists(join(targetDir, 'remainder.txt'))).toBe(true)
      // The agent's commit is replayed…
      const { stdout: subjects } = await execa('git', ['log', '--format=%s'], { cwd: targetDir })
      expect(subjects.split('\n')).toContain('add feature')
      // …but with no -m the remainder stays uncommitted (quimby doesn't invent a commit
      // the agent never drew): it shows as a dirty working-tree entry, not a log entry.
      expect(subjects).not.toMatch(/Uncommitted work/)
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: targetDir })
      expect(status).toMatch(/remainder\.txt/)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('commits mode falls back to a squashed commit when the parcel has no per-commit patches', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    // Only uncommitted work (HEAD is still at the seed) — no commits to format as patches.
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      // Landed as a single fallback commit carrying the parcel's suggested message,
      // not an "Uncommitted work from …" commit (that path only runs alongside patches).
      const { stdout } = await execa('git', ['log', '-1', '--format=%s'], { cwd: targetDir })
      expect(stdout.trim()).toBe(meta.suggestedMessage)
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
