import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addAll, commit, init, tag } from '@quimbyhq/git'
import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import { exists } from '@quimbyhq/utils'
import { ensureWorkspace } from '@quimbyhq/workspace'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyHandoff, classifyParcelApplication } from './apply'
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

async function setupAgentRepo(repoRoot: string, agentName: string): Promise<string> {
  const agentRepoDir = getAgentRepoDir(repoRoot, agentName)
  const agentDir = getAgentDir(repoRoot, agentName)
  await mkdir(join(agentDir, 'inbox', 'status'), { recursive: true })
  await mkdir(join(agentDir, 'outbox'), { recursive: true })
  await mkdir(agentRepoDir, { recursive: true })
  await init(agentRepoDir)
  await configureGit(agentRepoDir)
  await writeFile(join(agentRepoDir, 'base.txt'), 'base content\n')
  await addAll(agentRepoDir)
  await commit(agentRepoDir, 'base commit')
  await tag(agentRepoDir, 'quimby/seed')
  return agentRepoDir
}

async function setupTargetRepo(): Promise<string> {
  const targetDir = join(tmpdir(), `quimby-target-${crypto.randomUUID()}`)
  await mkdir(targetDir, { recursive: true })
  await execa('git', ['init'], { cwd: targetDir })
  await configureGit(targetDir)
  await writeFile(join(targetDir, 'base.txt'), 'base content\n')
  await execa('git', ['add', '-A'], { cwd: targetDir })
  await execa('git', ['commit', '-m', 'base commit'], { cwd: targetDir })
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
      const agentRepoDir = await setupAgentRepo(dir, 'alice')
      await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
      await addAll(agentRepoDir)
      await commit(agentRepoDir, 'add feature')
      const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })
      const targetDir = await setupTargetRepo()
      try {
        await applyHandoff({ repoRoot: dir, name: meta.name, targetRepoPath: targetDir, mode })
        expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
      } finally {
        await rm(targetDir, { recursive: true, force: true })
      }
    })
  }
})

describe('applyHandoff skipFiles', () => {
  it('lands only the new file when settled files are skipped', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    // Two files: one already in the target (settled), one genuinely new.
    await writeFile(join(agentRepoDir, 'shipped.txt'), 'already shipped\n')
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'work')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })

    const targetDir = await setupTargetRepo()
    try {
      // Pre-place the settled file so its patch can't forward-apply.
      await writeFile(join(targetDir, 'shipped.txt'), 'already shipped\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'ship'], { cwd: targetDir })

      const { settled, fresh } = await classifyParcelApplication(dir, meta.name, targetDir)
      expect(settled).toEqual(['shipped.txt'])
      expect(fresh).toEqual(['feature.txt'])

      // Without skipping, the whole-diff apply would abort on shipped.txt; skipping
      // it lets feature.txt land.
      await applyHandoff({
        repoRoot: dir,
        name: meta.name,
        targetRepoPath: targetDir,
        mode: 'patch',
        skipFiles: settled,
      })
      expect(await exists(join(targetDir, 'feature.txt'))).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})

describe('classifyParcelApplication', () => {
  it('reports fresh files as new and re-sent files as settled', async () => {
    const agentRepoDir = await setupAgentRepo(dir, 'alice')
    await writeFile(join(agentRepoDir, 'feature.txt'), 'new feature\n')
    await addAll(agentRepoDir)
    await commit(agentRepoDir, 'add feature')
    const meta = await assembleHandoff({ repoRoot: dir, from: 'alice', codeSourceId: 'alice' })

    const targetDir = await setupTargetRepo()
    try {
      const beforeApply = await classifyParcelApplication(dir, meta.name, targetDir)
      expect(beforeApply.fresh).toEqual(['feature.txt'])
      expect(beforeApply.settled).toEqual([])

      // Land the work, then re-classify: the same parcel is now already present.
      await writeFile(join(targetDir, 'feature.txt'), 'new feature\n')
      await execa('git', ['add', '-A'], { cwd: targetDir })
      await execa('git', ['commit', '-m', 'ship feature'], { cwd: targetDir })

      const afterApply = await classifyParcelApplication(dir, meta.name, targetDir)
      expect(afterApply.settled).toEqual(['feature.txt'])
      expect(afterApply.fresh).toEqual([])
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})
