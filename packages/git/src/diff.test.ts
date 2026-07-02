import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  am,
  amAbort,
  apply,
  diff,
  diffStaged,
  diffWorkingTree,
  diffWorkingTreeNumstat,
  formatPatch,
  getConflicts,
} from './diff'
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

describe('amAbort', () => {
  it('throws when not mid-am', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await expect(amAbort(dir)).rejects.toThrow()
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

  it('emits an applyable binary patch with { binary: true }, concise notation without', async () => {
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await writeFile(join(dir, 'logo.bin'), Buffer.from([0x89, 0x00, 0xff, 0xfe]))

    expect(await diffWorkingTree(dir, 'HEAD')).toContain('Binary files')
    expect(await diffWorkingTree(dir, 'HEAD', { binary: true })).toContain('GIT binary patch')
  })

  it('throws GitError when the base ref does not exist', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await expect(diffWorkingTree(dir, 'nonexistent-sha')).rejects.toThrow()
  })

  it('omits exclude paths from the capture even when not gitignored', async () => {
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await tag(dir, 'quimby/seed')
    await mkdir(join(dir, '.quimby', 'agents'), { recursive: true })
    await writeFile(join(dir, '.quimby', 'state.yaml'), 'id: x\n')
    await writeFile(join(dir, 'feature.txt'), 'new work\n')

    const output = await diffWorkingTree(dir, 'quimby/seed', { exclude: ['.quimby'] })
    expect(output).toContain('feature.txt')
    expect(output).not.toContain('.quimby')
    expect(output).not.toContain('state.yaml')
  })

  it('excludes a gitignored path without erroring on the ignored match', async () => {
    await writeFile(join(dir, '.gitignore'), '.quimby\n')
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await tag(dir, 'quimby/seed')
    await mkdir(join(dir, '.quimby'), { recursive: true })
    await writeFile(join(dir, '.quimby', 'state.yaml'), 'id: x\n')
    await writeFile(join(dir, 'feature.txt'), 'new work\n')

    const output = await diffWorkingTree(dir, 'quimby/seed', { exclude: ['.quimby'] })
    expect(output).toContain('feature.txt')
    expect(output).not.toContain('state.yaml')
  })

  it('leaves an excluded path that is part of the baseline (no spurious deletion)', async () => {
    await mkdir(join(dir, '.quimby'), { recursive: true })
    await writeFile(join(dir, '.quimby', 'state.yaml'), 'committed\n')
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await tag(dir, 'quimby/seed')
    await writeFile(join(dir, 'feature.txt'), 'new work\n')

    const output = await diffWorkingTree(dir, 'quimby/seed', { exclude: ['.quimby'] })
    expect(output).toContain('feature.txt')
    expect(output).not.toContain('deleted file')
    expect(output).not.toContain('state.yaml')
  })

  it('excludes the path only at the repo root, not a same-named nested dir', async () => {
    await makeCommit(dir, 'base.txt', 'base\n', 'initial')
    await tag(dir, 'quimby/seed')
    await mkdir(join(dir, 'pkg', '.quimby'), { recursive: true })
    await writeFile(join(dir, 'pkg', '.quimby', 'keep.txt'), 'legit\n')

    const output = await diffWorkingTree(dir, 'quimby/seed', { exclude: ['.quimby'] })
    expect(output).toContain('pkg/.quimby/keep.txt')
  })
})

describe('diffWorkingTreeNumstat', () => {
  it('counts committed, uncommitted, and untracked changes and sums line deltas', async () => {
    await makeCommit(dir, 'base.txt', 'a\n', 'initial')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'committed.txt', 'x\ny\n', 'a commit since seed') // +2
    await writeFile(join(dir, 'base.txt'), 'a\nb\n') // +1 (uncommitted)
    await writeFile(join(dir, 'untracked.txt'), 'z\n') // +1 (untracked)

    const stat = await diffWorkingTreeNumstat(dir, 'quimby/seed')
    expect(stat).toEqual({ files: 3, insertions: 4, deletions: 0 })
  })

  it('returns zeros when the working tree matches the base', async () => {
    await makeCommit(dir, 'base.txt', 'a\n', 'initial')
    await tag(dir, 'quimby/seed')
    expect(await diffWorkingTreeNumstat(dir, 'quimby/seed')).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
    })
  })

  it('counts a binary file as changed but with no line deltas', async () => {
    await makeCommit(dir, 'base.txt', 'a\n', 'initial')
    await tag(dir, 'quimby/seed')
    await writeFile(join(dir, 'logo.bin'), Buffer.from([0x89, 0x00, 0xff, 0xfe]))

    expect(await diffWorkingTreeNumstat(dir, 'quimby/seed')).toEqual({
      files: 1,
      insertions: 0,
      deletions: 0,
    })
  })

  it('drops an excluded path from the counts', async () => {
    await makeCommit(dir, 'base.txt', 'a\n', 'initial')
    await tag(dir, 'quimby/seed')
    await mkdir(join(dir, '.quimby'), { recursive: true })
    await writeFile(join(dir, '.quimby', 'state.yaml'), 'id: x\n')
    await writeFile(join(dir, 'real.txt'), 'r\n')

    expect(await diffWorkingTreeNumstat(dir, 'quimby/seed', { exclude: ['.quimby'] })).toEqual({
      files: 1,
      insertions: 1,
      deletions: 0,
    })
  })

  it('throws GitError when the base ref does not exist', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await expect(diffWorkingTreeNumstat(dir, 'nonexistent-sha')).rejects.toThrow()
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
