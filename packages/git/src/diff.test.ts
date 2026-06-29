import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { am, apply, diff, diffStaged, diffWorkingTree, formatPatch, getConflicts } from './diff'
import {
  addAll,
  branchExists,
  checkout,
  commit,
  createBranch,
  init,
  resetHard,
  revParse,
  tag,
} from './git'

let dir: string

async function configureGit(cwd: string) {
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd })
  await execa('git', ['config', 'user.name', 'Test User'], { cwd })
}

async function makeCommit(cwd: string, filename: string, content: string, message: string) {
  await writeFile(join(cwd, filename), content)
  await execa('git', ['add', '-A'], { cwd })
  await execa('git', ['commit', '-m', message], { cwd })
}

beforeEach(async () => {
  dir = join(tmpdir(), `quimby-git-diff-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await init(dir)
  await configureGit(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('am', () => {
  it('applies patch files via git am', async () => {
    await makeCommit(dir, 'base.txt', 'base\n', 'base commit')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'feature.txt', 'feature\n', 'add feature')

    const patchDir = join(dir, 'patches')
    await mkdir(patchDir, { recursive: true })
    const patchFiles = await formatPatch(dir, 'quimby/seed', patchDir)

    await resetHard(dir, 'quimby/seed')

    await am(dir, patchFiles)

    const content = await readFile(join(dir, 'feature.txt'), 'utf-8')
    expect(content).toBe('feature\n')
  })
})

describe('apply', () => {
  it('applies a patch to a repo', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await tag(dir, 'quimby/seed')
    await writeFile(join(dir, 'file.txt'), 'modified\n')

    const patchContent = await diff(dir, 'HEAD')
    await execa('git', ['checkout', '--', 'file.txt'], { cwd: dir })

    const patchFile = join(dir, 'changes.patch')
    await writeFile(patchFile, patchContent)
    await apply(dir, patchFile)

    const content = await readFile(join(dir, 'file.txt'), 'utf-8')
    expect(content).toBe('modified\n')
  })
})

describe('diff', () => {
  it('returns diff text for uncommitted changes vs a ref', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await tag(dir, 'quimby/seed')
    await writeFile(join(dir, 'file.txt'), 'modified\n')

    const output = await diff(dir, 'quimby/seed')
    expect(output).toContain('modified')
    expect(output).toContain('original')
  })
})

describe('diffStaged', () => {
  it('returns diff text for staged changes vs a ref', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await tag(dir, 'quimby/seed')
    await writeFile(join(dir, 'file.txt'), 'staged change\n')
    await execa('git', ['add', '-A'], { cwd: dir })

    const output = await diffStaged(dir, 'quimby/seed')
    expect(output).toContain('staged change')
    expect(output).toContain('original')
  })
})

describe('diffWorkingTree', () => {
  it('captures committed, uncommitted, and untracked changes without a commit', async () => {
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'committed.txt', 'committed\n', 'a commit since seed')
    await writeFile(join(dir, 'base.txt'), 'modified\n')
    await writeFile(join(dir, 'untracked.txt'), 'new file\n')

    const output = await diffWorkingTree(dir, 'quimby/seed')
    expect(output).toContain('committed.txt')
    expect(output).toContain('modified')
    expect(output).toContain('untracked.txt')

    const { stdout: head } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })
    const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: dir })
    expect(head.trim()).toBe(await revParse(dir, 'HEAD'))
    expect(status).toContain('?? untracked.txt')
  })

  it('yields only the uncommitted remainder against HEAD', async () => {
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await writeFile(join(dir, 'wip.txt'), 'wip\n')

    const output = await diffWorkingTree(dir, 'HEAD')
    expect(output).toContain('wip.txt')
  })
})

describe('formatPatch', () => {
  it('returns patch files for commits since a ref', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'feature.txt', 'feature', 'add feature')

    const patchDir = join(dir, 'patches')
    await mkdir(patchDir, { recursive: true })
    const patches = await formatPatch(dir, 'quimby/seed', patchDir)

    expect(patches).toHaveLength(1)
    expect(patches[0]).toContain('.patch')
  })
})

describe('getConflicts', () => {
  it('lists files with unresolved merge conflicts', async () => {
    await makeCommit(dir, 'file.txt', 'base\n', 'initial')
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    const main = stdout.trim()
    await createBranch(dir, 'other')
    await makeCommit(dir, 'file.txt', 'other change\n', 'other')
    await checkout(dir, main)
    await makeCommit(dir, 'file.txt', 'main change\n', 'main')
    await execa('git', ['merge', 'other'], { cwd: dir }).catch(() => {})
    expect(await getConflicts(dir)).toContain('file.txt')
  })

  it('returns empty when the working tree has no conflicts', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await getConflicts(dir)).toEqual([])
  })
})
