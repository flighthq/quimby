import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GitError } from '@quimbyhq/errors'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addAll,
  addRemote,
  branchExists,
  checkout,
  clone,
  commit,
  countCommits,
  createBranch,
  deleteBranch,
  fetch,
  findRoot,
  getConfig,
  getCurrentBranch,
  getCurrentRef,
  getRemoteUrl,
  hasCommitsSince,
  hasRemote,
  init,
  isClean,
  isMergeInProgress,
  log,
  merge,
  mergeAbort,
  rebase,
  rebaseAbort,
  resetHard,
  revParse,
  setConfig,
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

describe('addAll', () => {
  it('stages all files', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    await addAll(dir)
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: dir })
    expect(stdout).toContain('A  a.txt')
  })

  it('keeps excluded paths out of the index when they are not gitignored', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    await mkdir(join(dir, '.quimby'), { recursive: true })
    await writeFile(join(dir, '.quimby', 'state.yaml'), 'id: x')
    await addAll(dir, { exclude: ['.quimby'] })
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: dir })
    // a.txt is staged; .quimby stays unstaged (shown untracked), never added to the index.
    expect(stdout).toContain('A  a.txt')
    expect(stdout).not.toMatch(/A\s+\.quimby/)
    expect(stdout).toContain('?? .quimby/')
  })

  // The failure mode that motivated the bare-add + reset form: when the excluded path IS
  // gitignored, an explicit `:(exclude)` pathspec still made `git add` exit 1 ("paths are
  // ignored by .gitignore"), aborting the whole merge. addAll must stage the rest cleanly.
  it('does not error when an excluded path is gitignored', async () => {
    await writeFile(join(dir, '.gitignore'), '.quimby\n')
    await makeCommit(dir, 'seed.txt', 'seed', 'seed')
    await writeFile(join(dir, 'a.txt'), 'hello')
    await mkdir(join(dir, '.quimby'), { recursive: true })
    await writeFile(join(dir, '.quimby', 'state.yaml'), 'id: x')
    await addAll(dir, { exclude: ['.quimby'] })
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: dir })
    expect(stdout).toContain('A  a.txt')
    expect(stdout).not.toMatch(/A\s+\.quimby/)
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

describe('branchExists', () => {
  it('returns false for a missing branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await branchExists(dir, 'nonexistent-branch')).toBe(false)
  })

  it('returns true for an existing branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    const defaultBranch = stdout.trim()
    expect(await branchExists(dir, defaultBranch)).toBe(true)
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

  // The `git()` wrapper turns any failed command into a GitError tagged with the
  // subcommand; checkout of a missing ref is the simplest way to force that path.
  it('throws a GitError prefixed with the failing subcommand', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await expect(checkout(dir, 'no-such-ref')).rejects.toThrow(GitError)
    await expect(checkout(dir, 'no-such-ref')).rejects.toThrow(/^git checkout failed:/)
  })
})

describe('clone', () => {
  async function makeSource(): Promise<string> {
    const source = join(tmpdir(), `quimby-clone-src-${crypto.randomUUID()}`)
    await mkdir(source, { recursive: true })
    await init(source)
    await configureGit(source)
    await makeCommit(source, 'file.txt', 'v1', 'first')
    await makeCommit(source, 'file.txt', 'v2', 'second')
    return source
  }

  it('clones a source repo into a new directory', async () => {
    const source = await makeSource()
    const dest = join(tmpdir(), `quimby-clone-dest-${crypto.randomUUID()}`)
    try {
      await clone(source, dest)
      expect(await readFile(join(dest, 'file.txt'), 'utf-8')).toBe('v2')
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('honors opts.depth for a shallow clone', async () => {
    const source = await makeSource()
    const dest = join(tmpdir(), `quimby-clone-shallow-${crypto.randomUUID()}`)
    try {
      // git ignores --depth for bare local-path clones; a file:// URL uses a real
      // transport so the depth flag actually shallows the history.
      await clone(`file://${source}`, dest, { depth: 1 })
      const { stdout } = await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: dest })
      expect(stdout.trim()).toBe('1')
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('checks out opts.ref via --branch', async () => {
    const source = await makeSource()
    await execa('git', ['branch', 'release'], { cwd: source })
    const dest = join(tmpdir(), `quimby-clone-ref-${crypto.randomUUID()}`)
    try {
      await clone(source, dest, { ref: 'release' })
      const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dest })
      expect(stdout.trim()).toBe('release')
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
  })

  // clone bypasses the git() wrapper (raw execa), so a failure surfaces as the
  // unwrapped execa error, not a GitError.
  it('throws an unwrapped (non-GitError) error when the clone fails', async () => {
    const dest = join(tmpdir(), `quimby-clone-fail-${crypto.randomUUID()}`)
    let caught: unknown
    try {
      await clone(join(tmpdir(), `not-a-repo-${crypto.randomUUID()}`), dest)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(GitError)
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

describe('countCommits', () => {
  it('counts commits in a valid range', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'a.txt', 'a', 'first')
    await makeCommit(dir, 'b.txt', 'b', 'second')
    expect(await countCommits(dir, 'quimby/seed..HEAD')).toBe(2)
  })

  it('returns 0 when an endpoint is unknown rather than throwing', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    expect(await countCommits(dir, 'no-such-ref..HEAD')).toBe(0)
  })
})

describe('createBranch', () => {
  it('creates a new branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await createBranch(dir, 'feature')
    expect(await branchExists(dir, 'feature')).toBe(true)
  })

  it('creates a branch from a specific start point', async () => {
    await makeCommit(dir, 'file.txt', 'v1', 'first')
    const firstSha = await revParse(dir, 'HEAD')
    await makeCommit(dir, 'file.txt', 'v2', 'second')
    await createBranch(dir, 'from-first', firstSha)
    const branchSha = await revParse(dir, 'HEAD')
    expect(branchSha).toBe(firstSha)
  })
})

describe('deleteBranch', () => {
  it('removes a branch', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    const defaultBranch = stdout.trim()
    await createBranch(dir, 'to-delete')
    await checkout(dir, defaultBranch)
    await deleteBranch(dir, 'to-delete')
    expect(await branchExists(dir, 'to-delete')).toBe(false)
  })
})

describe('fetch', () => {
  it('brings new commits from a remote into remote-tracking refs', async () => {
    const source = join(tmpdir(), `quimby-fetch-src-${crypto.randomUUID()}`)
    await mkdir(source, { recursive: true })
    await init(source)
    await configureGit(source)
    await makeCommit(source, 'file.txt', 'v1', 'first')
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: source,
    })
    const defaultBranch = branch.trim()
    const dest = join(tmpdir(), `quimby-fetch-dest-${crypto.randomUUID()}`)
    await clone(source, dest)
    await configureGit(dest)
    await makeCommit(source, 'file.txt', 'v2', 'second')
    const sourceHead = await revParse(source, 'HEAD')
    try {
      await fetch(dest, 'origin')
      expect(await revParse(dest, `origin/${defaultBranch}`)).toBe(sourceHead)
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(dest, { recursive: true, force: true })
    }
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

describe('getConfig', () => {
  it('returns the configured value for a key', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await setConfig(dir, 'quimby.test', 'hello')
    const value = await getConfig(dir, 'quimby.test')
    expect(value).toBe('hello')
  })

  it('returns undefined for a key that does not exist', async () => {
    const value = await getConfig(dir, 'quimby.nonexistent')
    expect(value).toBeUndefined()
  })
})

describe('getCurrentBranch', () => {
  it('returns the checked-out branch name', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await createBranch(dir, 'feature/x')
    expect(await getCurrentBranch(dir)).toBe('feature/x')
  })

  it('returns undefined on a detached HEAD', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const sha = await getCurrentRef(dir)
    await checkout(dir, sha)
    expect(await getCurrentBranch(dir)).toBeUndefined()
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

describe('getRemoteUrl', () => {
  it('returns the remote URL when origin exists', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await addRemote(dir, 'origin', 'https://example.com/repo.git')
    const url = await getRemoteUrl(dir)
    expect(url).toBe('https://example.com/repo.git')
  })

  it('returns undefined for a repo with no remotes', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const url = await getRemoteUrl(dir)
    expect(url).toBeUndefined()
  })
})

describe('hasCommitsSince', () => {
  it('returns false when no commits since base ref', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    await tag(dir, 'quimby/seed')
    expect(await hasCommitsSince(dir, 'quimby/seed')).toBe(false)
  })

  it('returns true when commits exist above the base ref', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'base commit')
    await tag(dir, 'quimby/seed')
    await makeCommit(dir, 'feature.txt', 'feature', 'feature commit')
    expect(await hasCommitsSince(dir, 'quimby/seed')).toBe(true)
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

describe('isClean', () => {
  it('returns false when working tree is dirty', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await writeFile(join(dir, 'file.txt'), 'modified')
    expect(await isClean(dir)).toBe(false)
  })

  it('returns true when working tree is clean', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await isClean(dir)).toBe(true)
  })
})

describe('isMergeInProgress', () => {
  it('is false in a clean repo with no merge underway', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    expect(await isMergeInProgress(dir)).toBe(false)
  })

  it('is true while a conflicted merge is unresolved, false again after abort', async () => {
    await makeCommit(dir, 'file.txt', 'base\n', 'initial')
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const defaultBranch = branch.trim()
    await createBranch(dir, 'feature')
    await makeCommit(dir, 'file.txt', 'feature change\n', 'feature edit')
    await checkout(dir, defaultBranch)
    await makeCommit(dir, 'file.txt', 'main change\n', 'main edit')
    await expect(merge(dir, 'feature')).rejects.toThrow() // conflict leaves the merge in progress
    expect(await isMergeInProgress(dir)).toBe(true)
    await mergeAbort(dir)
    expect(await isMergeInProgress(dir)).toBe(false)
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

describe('merge', () => {
  it('merges a branch with --no-ff', async () => {
    await makeCommit(dir, 'file.txt', 'base', 'initial')
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const defaultBranch = branch.trim()
    await createBranch(dir, 'feature')
    await makeCommit(dir, 'feature.txt', 'feature work', 'add feature')
    await checkout(dir, defaultBranch)
    await merge(dir, 'feature', { noFf: true, message: 'merge feature' })
    const output = await log(dir, 'HEAD', '%s')
    expect(output).toContain('merge feature')
    expect(await readFile(join(dir, 'feature.txt'), 'utf-8')).toBe('feature work')
  })

  it('merges with --squash --no-commit leaving changes staged', async () => {
    await makeCommit(dir, 'file.txt', 'base', 'initial')
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const defaultBranch = branch.trim()
    await createBranch(dir, 'feature')
    await makeCommit(dir, 'new.txt', 'new content', 'add new')
    await checkout(dir, defaultBranch)
    await merge(dir, 'feature', { squash: true, noCommit: true })
    expect(await isClean(dir)).toBe(false)
    expect(await readFile(join(dir, 'new.txt'), 'utf-8')).toBe('new content')
  })

  // apply.ts relies on this throw to detect conflicts and surface a ConflictError.
  it('throws when the merge conflicts', async () => {
    await makeCommit(dir, 'file.txt', 'base\n', 'initial')
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const defaultBranch = branch.trim()
    await createBranch(dir, 'feature')
    await makeCommit(dir, 'file.txt', 'feature change\n', 'feature edit')
    await checkout(dir, defaultBranch)
    await makeCommit(dir, 'file.txt', 'main change\n', 'main edit')
    await expect(merge(dir, 'feature')).rejects.toThrow(GitError)
  })
})

describe('mergeAbort', () => {
  it('throws when not in a merge', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await expect(mergeAbort(dir)).rejects.toThrow()
  })
})

describe('rebase', () => {
  it('replays commits from a feature branch onto an updated base', async () => {
    await makeCommit(dir, 'base.txt', 'base', 'initial')
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    const defaultBranch = branch.trim()
    await createBranch(dir, 'feature')
    await makeCommit(dir, 'feature.txt', 'feature work', 'add feature')
    await checkout(dir, defaultBranch)
    await makeCommit(dir, 'extra.txt', 'extra', 'update base')
    await checkout(dir, 'feature')
    await rebase(dir, defaultBranch)
    const output = await log(dir, 'HEAD', '%s')
    expect(output).toContain('add feature')
    expect(output).toContain('update base')
  })
})

describe('rebaseAbort', () => {
  it('is a no-op when not in a rebase', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await expect(rebaseAbort(dir)).resolves.toBeUndefined()
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

describe('revParse', () => {
  it('resolves a ref to a SHA', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const sha = await revParse(dir, 'HEAD')
    expect(sha).toHaveLength(40)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('setConfig', () => {
  it('sets a git config key to the given value', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    await setConfig(dir, 'quimby.key', 'myvalue')
    const { stdout } = await execa('git', ['config', 'quimby.key'], { cwd: dir })
    expect(stdout.trim()).toBe('myvalue')
  })
})

describe('stash', () => {
  it('returns false when there is nothing to stash', async () => {
    await makeCommit(dir, 'file.txt', 'content', 'initial')
    const result = await stash(dir)
    expect(result).toBe(false)
  })

  it('stashes dirty changes and returns true', async () => {
    await makeCommit(dir, 'file.txt', 'original\n', 'initial')
    await writeFile(join(dir, 'file.txt'), 'modified\n')
    const result = await stash(dir)
    expect(result).toBe(true)
    const content = await readFile(join(dir, 'file.txt'), 'utf-8')
    expect(content).toBe('original\n')
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
