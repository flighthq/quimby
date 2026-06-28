import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addAll,
  addRemote,
  am,
  apply,
  branchExists,
  checkout,
  commit,
  createBranch,
  deleteBranch,
  diff,
  diffStaged,
  findRoot,
  formatPatch,
  getConflicts,
  getCurrentRef,
  getRemoteUrl,
  hasCommitsSince,
  hasRemote,
  init,
  isClean,
  log,
  resetHard,
  revParse,
  stash,
  stashPop,
  tag,
  tagForce,
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
  dir = join(tmpdir(), `quimby-git-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await init(dir)
  await configureGit(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('init', () => {
  it('creates a .git directory', async () => {
    const newDir = join(tmpdir(), `quimby-init-${crypto.randomUUID()}`)
    await mkdir(newDir, { recursive: true })
    try {
      await init(newDir)
      const { stdout } = await execa('git', ['rev-parse', '--git-dir'], { cwd: newDir })
      expect(stdout.trim()).toBe('.git')
    } finally {
      await rm(newDir, { recursive: true, force: true })
    }
  })
})

describe('addAll', () => {
  it('stages all files', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    await addAll(dir)
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: dir })
    expect(stdout).toContain('A  a.txt')
  })
})

describe('commit', () => {
  it('creates a commit with the given message', async () => {
    await writeFile(join(dir, 'file.txt'), 'content')
    await addAll(dir)
    await commit(dir, 'my test commit')
    const { stdout } = await execa('git', ['log', '--format=%s', '-1'], { cwd: dir })
    expect(stdout.trim()).toBe('my test commit')
  })
})

describe('tag', () => {
  it('creates a tag', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await tag(dir, 'my-tag')
    const { stdout } = await execa('git', ['tag', '-l', 'my-tag'], { cwd: dir })
    expect(stdout.trim()).toBe('my-tag')
  })

  it('revParse resolves the tag', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await tag(dir, 'quimby/seed')
    const sha = await revParse(dir, 'quimby/seed')
    expect(sha).toHaveLength(40)
  })
})

describe('tagForce', () => {
  it('updates an existing tag to the current HEAD', async () => {
    await makeCommit(dir, 'file.txt', 'v1', 'v1 commit')
    await tag(dir, 'my-tag')
    const firstSha = await revParse(dir, 'my-tag')

    await makeCommit(dir, 'file.txt', 'v2', 'v2 commit')
    await tagForce(dir, 'my-tag')
    const secondSha = await revParse(dir, 'my-tag')

    expect(secondSha).not.toBe(firstSha)
    expect(secondSha).toHaveLength(40)
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

describe('log', () => {
  it('returns commit log in specified format', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'my commit message')
    const output = await log(dir, 'HEAD', '%s')
    expect(output).toContain('my commit message')
  })

  it('returns default format with | delimiters', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'test commit')
    const output = await log(dir, 'HEAD')
    expect(output).toContain('|')
  })
})

describe('revParse', () => {
  it('resolves a ref to a SHA', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const sha = await revParse(dir, 'HEAD')
    expect(sha).toHaveLength(40)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('isClean', () => {
  it('returns true when working tree is clean', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await isClean(dir)).toBe(true)
  })

  it('returns false when working tree is dirty', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await writeFile(join(dir, 'file.txt'), 'modified')
    expect(await isClean(dir)).toBe(false)
  })
})

describe('createBranch', () => {
  it('creates a new branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await createBranch(dir, 'feature')
    expect(await branchExists(dir, 'feature')).toBe(true)
  })
})

describe('getConflicts', () => {
  it('returns empty when the working tree has no conflicts', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await getConflicts(dir)).toEqual([])
  })

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
})

describe('deleteBranch', () => {
  it('removes a branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    // Get current branch name before switching
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    const defaultBranch = stdout.trim()
    await createBranch(dir, 'to-delete')
    await checkout(dir, defaultBranch)
    await deleteBranch(dir, 'to-delete')
    expect(await branchExists(dir, 'to-delete')).toBe(false)
  })
})

describe('branchExists', () => {
  it('returns true for an existing branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    const defaultBranch = stdout.trim()
    expect(await branchExists(dir, defaultBranch)).toBe(true)
  })

  it('returns false for a missing branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await branchExists(dir, 'nonexistent-branch')).toBe(false)
  })
})

describe('getCurrentRef', () => {
  it('returns current HEAD SHA', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const sha = await getCurrentRef(dir)
    expect(sha).toHaveLength(40)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('findRoot', () => {
  it('returns .git root when called from a subdir', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const subdir = join(dir, 'sub', 'nested')
    await mkdir(subdir, { recursive: true })
    const root = await findRoot(subdir)
    expect(root).toBe(dir)
  })

  it('returns undefined when not in a git repo', async () => {
    const notARepo = join(tmpdir(), `not-a-repo-${crypto.randomUUID()}`)
    await mkdir(notARepo, { recursive: true })
    try {
      const root = await findRoot(notARepo)
      expect(root).toBeUndefined()
    } finally {
      await rm(notARepo, { recursive: true, force: true })
    }
  })
})

describe('hasCommitsSince', () => {
  it('returns true when commits exist above the base ref', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'feature.txt', 'feature', 'feature commit')
    expect(await hasCommitsSince(dir, 'quimby/seed')).toBe(true)
  })

  it('returns false when no commits since base ref', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    await tag(dir, 'quimby/seed')
    expect(await hasCommitsSince(dir, 'quimby/seed')).toBe(false)
  })
})

describe('hasRemote', () => {
  it('returns false in a repo with no remotes', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await hasRemote(dir, 'origin')).toBe(false)
  })

  it('returns true after adding a remote', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await addRemote(dir, 'origin', 'https://example.com/repo.git')
    expect(await hasRemote(dir, 'origin')).toBe(true)
  })
})

describe('stash', () => {
  it('stashes dirty changes and returns true', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await writeFile(join(dir, 'file.txt'), 'modified\n')
    const result = await stash(dir)
    expect(result).toBe(true)
    const content = await readFile(join(dir, 'file.txt'), 'utf-8')
    expect(content).toBe('original\n')
  })

  it('returns false when there is nothing to stash', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const result = await stash(dir)
    expect(result).toBe(false)
  })
})

describe('stashPop', () => {
  it('restores stashed changes', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await writeFile(join(dir, 'file.txt'), 'modified\n')
    await stash(dir)
    await stashPop(dir)
    const content = await readFile(join(dir, 'file.txt'), 'utf-8')
    expect(content).toBe('modified\n')
  })
})

describe('resetHard', () => {
  it('resets working tree to ref', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await tag(dir, 'seed')
    await makeCommit(dir, 'file.txt', 'modified\n', 'second')
    await resetHard(dir, 'seed')
    const content = await readFile(join(dir, 'file.txt'), 'utf-8')
    expect(content).toBe('original\n')
  })
})

describe('checkout', () => {
  it('switches to an existing branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await execa('git', ['branch', 'dev'], { cwd: dir })
    await checkout(dir, 'dev')
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    expect(stdout.trim()).toBe('dev')
  })
})

describe('addRemote', () => {
  it('adds a named remote', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await addRemote(dir, 'upstream', 'https://example.com/repo.git')
    const { stdout } = await execa('git', ['remote', 'get-url', 'upstream'], { cwd: dir })
    expect(stdout.trim()).toBe('https://example.com/repo.git')
  })
})

describe('getRemoteUrl', () => {
  it('returns undefined for a repo with no remotes', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const url = await getRemoteUrl(dir)
    expect(url).toBeUndefined()
  })

  it('returns the remote URL when origin exists', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await addRemote(dir, 'origin', 'https://example.com/repo.git')
    const url = await getRemoteUrl(dir)
    expect(url).toBe('https://example.com/repo.git')
  })
})
