import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConflictError, QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { addAll, commit, getCurrentBranch, init, tag } from '@quimbyhq/git'
import { getAgentDir, getAgentRepoDir, getStagingHandoffDir } from '@quimbyhq/paths'
import { exists, readYaml, writeYaml } from '@quimbyhq/utils'
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

  // Regression: `quimby merge` runs in the user's real repo, which carries a gitignored
  // `.quimby/` workspace dir in its working tree. The staging `git add` used to error out
  // ("paths are ignored by .gitignore") and abort the whole merge. The merge must ignore it.
  it('applies cleanly when the target has a gitignored .quimby directory present', async () => {
    const sourceDir = await setupSourceRepo()
    // The seed itself ignores `.quimby` (as a real workspace does — the ignore lands at
    // `quimby add` time, before the agent's seed is tagged). This is the case the merge
    // used to choke on: an explicit `git add` pathspec errors on a matched-but-ignored path.
    await writeFile(join(sourceDir, '.gitignore'), '.quimby\n')
    await execa('git', ['add', '.gitignore'], { cwd: sourceDir })
    await execa('git', ['commit', '-m', 'ignore .quimby'], { cwd: sourceDir })
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    await mkdir(join(targetDir, '.quimby', 'agents'), { recursive: true })
    await writeFile(join(targetDir, '.quimby', 'state.yaml'), 'id: workspace\n')
    try {
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      // The workspace state is left untouched in the working tree, never committed.
      expect(await exists(join(targetDir, '.quimby', 'state.yaml'))).toBe(true)
      const { stdout: tracked } = await execa('git', ['ls-files', '.quimby'], { cwd: targetDir })
      expect(tracked).toBe('')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

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

  it('commits mode is idempotent when retrying a parcel whose commits already landed', async () => {
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
      const first = await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      expect(first.alreadyApplied).toBe(false)
      const headAfterFirst = await git.revParse(targetDir, 'HEAD')

      const retry = await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'commits',
      })
      expect(retry.alreadyApplied).toBe(true)
      expect(await git.revParse(targetDir, 'HEAD')).toBe(headAfterFirst)
      const { stdout: subjects } = await execa('git', ['log', '--format=%s'], { cwd: targetDir })
      expect(subjects.split('\n').filter((s) => s === 'first change')).toHaveLength(1)
      expect(subjects.split('\n').filter((s) => s === 'second change')).toHaveLength(1)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('stops clearly when retrying from an interrupted temporary apply branch', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const tempBranch = `quimby/merge-${meta.from}-${meta.seedCommit!.slice(0, 8)}`
      await git.createBranch(targetDir, tempBranch, meta.seedCommit)
      await git.am(
        targetDir,
        [join(getStagingHandoffDir(dir, meta.name), 'commits', '0001-add-feature.patch')],
        {
          skipHooks: true,
        },
      )

      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'commits',
        }),
      ).rejects.toThrow('temporary merge branch')
      expect(await getCurrentBranch(targetDir)).toBe(tempBranch)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('commits mode aborts a failed git am and leaves the target clean and retryable', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })

    // Corrupt the staged patch so `git am --3way` cannot apply it (context and blob indexes
    // absent at the seed) — standing in for the real triggers the user hit (binary/mode/CRLF
    // patches that won't replay). Before the abort fix this stranded the target mid-am on the
    // temp branch with `.git/rebase-apply` left behind.
    const commitsDir = join(getStagingHandoffDir(dir, meta.name), 'commits')
    const patchFile = (await readdir(commitsDir)).find((f) => f.endsWith('.patch'))!
    await writeFile(
      join(commitsDir, patchFile),
      [
        'From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001',
        'From: Test User <test@test.com>',
        'Date: Mon, 1 Jan 2024 00:00:00 +0000',
        'Subject: [PATCH] unappliable change',
        '',
        '---',
        ' base.txt | 2 +-',
        ' 1 file changed, 1 insertion(+), 1 deletion(-)',
        '',
        'diff --git a/base.txt b/base.txt',
        'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
        '--- a/base.txt',
        '+++ b/base.txt',
        '@@ -1 +1 @@',
        '-line that does not exist at seed',
        '+replacement',
        '',
      ].join('\n'),
    )

    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const before = await getCurrentBranch(targetDir)
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'commits',
        }),
      ).rejects.toThrow(/Could not replay the agent's commits/)
      // No dangling am session, back on the original branch, clean tree, temp branch gone — so
      // the staged parcel (kept by the caller) can simply be retried.
      expect(await git.isRebaseOrAmInProgress(targetDir)).toBe(false)
      expect(await getCurrentBranch(targetDir)).toBe(before)
      expect(await git.isClean(targetDir)).toBe(true)
      const tempBranch = `quimby/merge-${meta.from}-${meta.seedCommit!.slice(0, 8)}`
      expect(await git.branchExists(targetDir, tempBranch)).toBe(false)
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

  it('parks work on a fresh -b branch and restores the original checkout', async () => {
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
        branch: 'feature/land',
      })
      // The work is committed on the landing branch…
      const { stdout: onBranch } = await execa('git', ['ls-tree', '--name-only', 'feature/land'], {
        cwd: targetDir,
      })
      expect(onBranch).toContain('feature.txt')
      // …and the user's checkout is left exactly where it started (not stranded on the branch).
      expect(await getCurrentBranch(targetDir)).toBe(branchBefore)
      const { stdout: onTarget } = await execa('git', ['ls-tree', '--name-only', 'HEAD'], {
        cwd: targetDir,
      })
      expect(onTarget).not.toContain('feature.txt')
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('replaces a pre-existing landing branch rather than failing', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      const originalBranch = await getCurrentBranch(targetDir)
      // A stale landing branch carrying a marker that must be gone once it's replaced.
      await execa('git', ['checkout', '-b', 'feature/land'], { cwd: targetDir })
      await writeFile(join(targetDir, 'stale.txt'), 'stale\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'stale'], { cwd: targetDir })
      await execa('git', ['checkout', originalBranch as string], { cwd: targetDir })

      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'squashed',
        branch: 'feature/land',
      })

      // The branch was recreated from the target's HEAD, so the stale commit is gone and
      // the agent's work is present — the pre-existing branch was replaced, not appended to.
      const { stdout: onBranch } = await execa('git', ['ls-tree', '--name-only', 'feature/land'], {
        cwd: targetDir,
      })
      expect(onBranch).toContain('feature.txt')
      expect(onBranch).not.toContain('stale.txt')
      // The checkout is restored to where it started, even when the branch pre-existed.
      expect(await getCurrentBranch(targetDir)).toBe(originalBranch)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('throws QuimbyError for a parcel assembled without a seed commit', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    // Strip the seed commit to mimic a parcel assembled before the merge-based apply existed.
    const metaPath = join(getStagingHandoffDir(dir, meta.name), 'meta.yaml')
    const raw = await readYaml<Record<string, unknown>>(metaPath)
    delete raw.seedCommit
    await writeYaml(metaPath, raw)
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'squashed',
        }),
      ).rejects.toThrow(/no seed commit recorded/)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('throws when the commits-mode remainder does not apply cleanly', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    // Committed work that touches only a new file, plus an uncommitted remainder that
    // edits base.txt — captured as the remainder diff against the agent's committed HEAD.
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    await writeFile(join(agentRepoDir, 'base.txt'), 'edited by agent\n')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    try {
      // The target commits a diverging edit to base.txt, so the remainder's context no
      // longer matches after the agent's commit merges — the plain `git apply` rejects it.
      await writeFile(join(targetDir, 'base.txt'), 'edited by target\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'diverge base'], { cwd: targetDir })
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'commits',
        }),
      ).rejects.toThrow(/didn't apply cleanly/)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('restores the checkout and reports "Merge failed" when the merge fails without conflicts', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    // Force a merge failure that reports no conflicting paths — the mergeAbort → restore
    // → "Merge failed" branch, distinct from the ConflictError path.
    const mergeSpy = vi.spyOn(git, 'merge').mockRejectedValueOnce(new Error('boom'))
    const conflictsSpy = vi.spyOn(git, 'getConflicts').mockResolvedValueOnce([])
    try {
      const branchBefore = await getCurrentBranch(targetDir)
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'squashed',
        }),
      ).rejects.toThrow(/Merge failed/)
      expect(await getCurrentBranch(targetDir)).toBe(branchBefore)
    } finally {
      mergeSpy.mockRestore()
      conflictsSpy.mockRestore()
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('restores a detached HEAD to its SHA when the merge fails', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    const mergeSpy = vi.spyOn(git, 'merge').mockRejectedValueOnce(new Error('boom'))
    const conflictsSpy = vi.spyOn(git, 'getConflicts').mockResolvedValueOnce([])
    try {
      // Detach HEAD: previousRef falls back from getCurrentBranch (undefined) to the SHA.
      const sha = await git.getCurrentRef(targetDir)
      await execa('git', ['checkout', sha], { cwd: targetDir })
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'squashed',
        }),
      ).rejects.toThrow(/Merge failed/)
      // getCurrentBranch stays undefined (still detached) and HEAD is back at the SHA.
      expect(await getCurrentBranch(targetDir)).toBeUndefined()
      expect(await git.getCurrentRef(targetDir)).toBe(sha)
    } finally {
      mergeSpy.mockRestore()
      conflictsSpy.mockRestore()
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('wraps a non-QuimbyError failure and restores the checkout', async () => {
    const sourceDir = await setupSourceRepo()
    const agentRepoDir = await setupAgentRepo(dir, 'alice', sourceDir)
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
    const targetDir = await setupTargetRepo(sourceDir)
    // A plain (non-Quimby, non-Conflict) failure inside the try block hits the generic
    // outer catch: the user's checkout is restored and the error is rewrapped.
    const createSpy = vi.spyOn(git, 'createBranch').mockRejectedValueOnce(new Error('disk full'))
    try {
      const branchBefore = await getCurrentBranch(targetDir)
      await expect(
        applyHandoff({
          repoRoot: dir,
          name: meta.name,
          targetRepoPath: targetDir,
          mode: 'squashed',
        }),
      ).rejects.toThrow(/Failed to apply handoff/)
      expect(await getCurrentBranch(targetDir)).toBe(branchBefore)
    } finally {
      createSpy.mockRestore()
      await rm(targetDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })
})
