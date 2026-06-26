import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'pathe'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as git from '../../src/utils/git.js'

let tmp: string
let repo: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ao-git-test-'))
  repo = join(tmp, 'repo')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(repo, { recursive: true })
  await git.init(repo)
  await writeFile(join(repo, 'file.txt'), 'initial')
  await git.addAll(repo)
  await git.commit(repo, 'initial commit')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('init', () => {
  it('creates a git repo', async () => {
    const newRepo = join(tmp, 'new')
    const { mkdir, writeFile: write } = await import('node:fs/promises')
    await mkdir(newRepo)
    await git.init(newRepo)
    await write(join(newRepo, 'init.txt'), 'init')
    await git.addAll(newRepo)
    await git.commit(newRepo, 'first')
    const ref = await git.getCurrentRef(newRepo)
    expect(ref).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('addAll', () => {
  it('stages all changes', async () => {
    await writeFile(join(repo, 'new.txt'), 'new content')
    await git.addAll(repo)
    const clean = await git.isClean(repo)
    expect(clean).toBe(false)
  })
})

describe('commit', () => {
  it('creates a commit', async () => {
    await writeFile(join(repo, 'c.txt'), 'committed')
    await git.addAll(repo)
    await git.commit(repo, 'add c.txt')
    expect(await git.isClean(repo)).toBe(true)
  })
})

describe('tag', () => {
  it('creates a tag', async () => {
    await git.tag(repo, 'v1.0')
    const ref = await git.revParse(repo, 'v1.0')
    const head = await git.getCurrentRef(repo)
    expect(ref).toBe(head)
  })
})

describe('tagForce', () => {
  it('moves a tag to a new commit', async () => {
    await git.tag(repo, 'marker')
    const first = await git.getCurrentRef(repo)

    await writeFile(join(repo, 'extra.txt'), 'x')
    await git.addAll(repo)
    await git.commit(repo, 'second')
    const second = await git.getCurrentRef(repo)

    await git.tagForce(repo, 'marker')
    const moved = await git.revParse(repo, 'marker')
    expect(moved).toBe(second)
    expect(moved).not.toBe(first)
  })
})

describe('isClean', () => {
  it('returns true when working tree is clean', async () => {
    expect(await git.isClean(repo)).toBe(true)
  })

  it('returns false when there are uncommitted changes', async () => {
    await writeFile(join(repo, 'dirty.txt'), 'dirty')
    expect(await git.isClean(repo)).toBe(false)
  })
})

describe('getCurrentRef', () => {
  it('returns the current HEAD sha', async () => {
    const ref = await git.getCurrentRef(repo)
    expect(ref).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('revParse', () => {
  it('resolves a ref to a sha', async () => {
    const head = await git.getCurrentRef(repo)
    const parsed = await git.revParse(repo, 'HEAD')
    expect(parsed).toBe(head)
  })
})

describe('createBranch', () => {
  it('creates and checks out a new branch', async () => {
    await git.createBranch(repo, 'feature/test')
    const { execa } = await import('execa')
    const { stdout } = await execa('git', ['branch', '--show-current'], { cwd: repo })
    expect(stdout.trim()).toBe('feature/test')
  })
})

describe('findRoot', () => {
  it('finds the git root from a subdirectory', async () => {
    const { mkdir } = await import('node:fs/promises')
    const sub = join(repo, 'a', 'b')
    await mkdir(sub, { recursive: true })
    const root = await git.findRoot(sub)
    expect(root).toBe(repo)
  })

  it('returns undefined for non-git directories', async () => {
    const noGit = join(tmp, 'nogit')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(noGit)
    const root = await git.findRoot(noGit)
    expect(root).toBeUndefined()
  })
})

describe('getRemoteUrl', () => {
  it('returns undefined when no remote is set', async () => {
    const url = await git.getRemoteUrl(repo)
    expect(url).toBeUndefined()
  })
})

describe('diff', () => {
  it('shows diff against a ref', async () => {
    await git.tag(repo, 'base')
    await writeFile(join(repo, 'added.txt'), 'new')
    await git.addAll(repo)
    await git.commit(repo, 'add file')
    const d = await git.diff(repo, 'base')
    expect(d).toContain('added.txt')
  })
})

describe('log', () => {
  it('returns formatted log output', async () => {
    await writeFile(join(repo, 'log.txt'), 'for log')
    await git.addAll(repo)
    await git.commit(repo, 'second commit')
    const output = await git.log(repo, 'HEAD~1..HEAD')
    expect(output).toContain('second commit')
  })
})

describe('formatPatch', () => {
  it('generates patch files', async () => {
    await git.tag(repo, 'base')
    await writeFile(join(repo, 'patched.txt'), 'p')
    await git.addAll(repo)
    await git.commit(repo, 'patch commit')
    const patches = await git.formatPatch(repo, 'base', join(tmp, 'patches'))
    expect(patches.length).toBe(1)
    expect(patches[0]).toContain('.patch')
  })
})

describe('hasCommitsSince', () => {
  it('returns false when no commits since ref', async () => {
    await git.tag(repo, 'mark')
    expect(await git.hasCommitsSince(repo, 'mark')).toBe(false)
  })

  it('returns true when there are commits since ref', async () => {
    await git.tag(repo, 'mark')
    await writeFile(join(repo, 'new.txt'), 'n')
    await git.addAll(repo)
    await git.commit(repo, 'after mark')
    expect(await git.hasCommitsSince(repo, 'mark')).toBe(true)
  })
})

describe('stash', () => {
  it('stashes uncommitted changes', async () => {
    await writeFile(join(repo, 'unstaged.txt'), 'u')
    await git.addAll(repo)
    const stashed = await git.stash(repo)
    expect(stashed).toBe(true)
    expect(await git.isClean(repo)).toBe(true)
  })

  it('returns false when nothing to stash', async () => {
    const stashed = await git.stash(repo)
    expect(stashed).toBe(false)
  })
})

describe('stashPop', () => {
  it('restores stashed changes', async () => {
    await writeFile(join(repo, 'stashed.txt'), 's')
    await git.addAll(repo)
    await git.stash(repo)
    await git.stashPop(repo)
    expect(await git.isClean(repo)).toBe(false)
  })
})

describe('resetHard', () => {
  it('resets to a ref', async () => {
    const before = await git.getCurrentRef(repo)
    await writeFile(join(repo, 'extra.txt'), 'e')
    await git.addAll(repo)
    await git.commit(repo, 'extra')
    await git.resetHard(repo, before)
    const after = await git.getCurrentRef(repo)
    expect(after).toBe(before)
  })
})

describe('checkout', () => {
  it('checks out a branch', async () => {
    await git.createBranch(repo, 'other')
    await git.checkout(repo, 'master')
    const { execa } = await import('execa')
    const { stdout } = await execa('git', ['branch', '--show-current'], { cwd: repo })
    expect(stdout.trim()).toBe('master')
  })
})

describe('fetch', () => {
  it('fetches from a named remote', async () => {
    const remote = join(tmp, 'remote-bare')
    const { execa } = await import('execa')
    await execa('git', ['clone', '--bare', repo, remote])
    await git.addRemote(repo, 'test-remote', remote)
    await git.fetch(repo, 'test-remote')
  })
})

describe('addRemote', () => {
  it('adds a remote', async () => {
    await git.addRemote(repo, 'upstream', 'https://example.com/repo.git')
    const has = await git.hasRemote(repo, 'upstream')
    expect(has).toBe(true)
  })
})

describe('hasRemote', () => {
  it('returns false for non-existent remote', async () => {
    expect(await git.hasRemote(repo, 'nope')).toBe(false)
  })
})

describe('apply', () => {
  it('applies a diff patch', async () => {
    await git.tag(repo, 'base')
    await writeFile(join(repo, 'applied.txt'), 'a')
    await git.addAll(repo)
    await git.commit(repo, 'for patch')
    const d = await git.diff(repo, 'base')
    const patchFile = join(tmp, 'test.patch')
    await writeFile(patchFile, d)
    await git.resetHard(repo, 'base')
    await git.apply(repo, patchFile)
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(repo, 'applied.txt'), 'utf-8')
    expect(content).toBe('a')
  })
})

describe('am', () => {
  it('applies format-patch patches', async () => {
    await git.tag(repo, 'base')
    await writeFile(join(repo, 'am.txt'), 'am')
    await git.addAll(repo)
    await git.commit(repo, 'am commit')
    const { mkdir } = await import('node:fs/promises')
    const patchDir = join(tmp, 'am-patches')
    await mkdir(patchDir)
    const patches = await git.formatPatch(repo, 'base', patchDir)
    await git.resetHard(repo, 'base')
    await git.am(repo, patches)
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(repo, 'am.txt'), 'utf-8')
    expect(content).toBe('am')
  })
})
