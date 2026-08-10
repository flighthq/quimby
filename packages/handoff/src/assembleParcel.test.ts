import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getStagingHandoffDir } from '@quimbyhq/paths'
import { exists, readText } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assembleParcel,
  contentDigest,
  parcelName,
  parseCommits,
  type RepoAssembleOps,
} from './assembleParcel'

interface FakeConfig {
  seed?: string
  subjects?: string[]
  seedDiff?: string
  headDiff?: string
  patchFiles?: string[]
  commitLog?: string
}

function fakeOps(cfg: FakeConfig = {}): RepoAssembleOps {
  return {
    resolveSeed: async () => cfg.seed ?? 'seedcommit',
    commitSubjects: async () => cfg.subjects ?? [],
    workingTreeDiff: async (base) =>
      base === 'HEAD' ? (cfg.headDiff ?? '') : (cfg.seedDiff ?? ''),
    formatPatches: async () => cfg.patchFiles ?? [],
    fullCommitLog: async () => cfg.commitLog ?? '',
  }
}

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `quimby-assemble-${crypto.randomUUID()}`)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('assembleParcel', () => {
  it('throws when there is neither a diff nor a note', async () => {
    await expect(
      assembleParcel({ repoRoot: dir, from: 'builder' }, fakeOps({ seedDiff: '' })),
    ).rejects.toThrow(/Nothing to hand off/)
  })

  it('writes the squashed diff and a content-derived name for code-only', async () => {
    const meta = await assembleParcel(
      { repoRoot: dir, from: 'builder' },
      fakeOps({ seedDiff: 'diff --git a b\n' }),
    )
    expect(meta.name).toMatch(/^builder-[0-9a-f]{8}$/)
    expect(await exists(join(getStagingHandoffDir(dir, meta.name), 'squashed.diff'))).toBe(true)
    expect(meta.seedCommit).toBe('seedcommit')
  })

  it('embeds the resolved attestation into the parcel meta, keyed on the code source', async () => {
    const seen: string[] = []
    const meta = await assembleParcel(
      {
        repoRoot: dir,
        from: 'builder',
        resolveAttestation: async (codeSource) => {
          seen.push(codeSource)
          return { command: 'npm run ci', result: 'pass', atCommit: 'a1b2c3d' }
        },
      },
      fakeOps({ seedDiff: 'diff --git a b\n' }),
    )
    expect(seen).toEqual(['builder'])
    expect(meta.attestation).toEqual({ command: 'npm run ci', result: 'pass', atCommit: 'a1b2c3d' })
  })

  it('leaves meta.attestation undefined when no resolver is given', async () => {
    const meta = await assembleParcel(
      { repoRoot: dir, from: 'builder' },
      fakeOps({ seedDiff: 'd\n' }),
    )
    expect(meta.attestation).toBeUndefined()
  })

  it('writes only the note for a note-only parcel (no diff)', async () => {
    const meta = await assembleParcel(
      { repoRoot: dir, from: 'reviewer', note: 'please fix Y' },
      fakeOps({ seedDiff: '' }),
    )
    const staged = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(staged, 'squashed.diff'))).toBe(false)
    expect(await readText(join(staged, 'README.md'))).toBe('please fix Y')
  })

  it('writes a host-promoted user-directed signal into parcel metadata', async () => {
    const meta = await assembleParcel(
      { repoRoot: dir, from: 'supervisor', note: 'review Y', userDirected: true },
      fakeOps(),
    )
    expect(meta.userDirected).toBe(true)
  })

  it('gives ordinary and user-directed copies of the same note distinct parcel identities', async () => {
    const ordinary = await assembleParcel(
      { repoRoot: dir, from: 'supervisor', note: 'review Y' },
      fakeOps(),
    )
    const directed = await assembleParcel(
      { repoRoot: dir, from: 'supervisor', note: 'review Y', userDirected: true },
      fakeOps(),
    )
    expect(directed.name).not.toBe(ordinary.name)
  })

  it('writes patches and the uncommitted remainder when the agent has commits', async () => {
    const meta = await assembleParcel(
      { repoRoot: dir, from: 'builder' },
      fakeOps({
        seedDiff: 'big diff\n',
        subjects: ['feat: a', 'fix: b'],
        // format-patch order: 0001 is the OLDEST commit
        patchFiles: ['0001-b.patch', '0002-a.patch'],
        // git log order: newest first, so h1 (feat: a) is the newest and belongs to 0002-a
        commitLog: 'h1|feat: a|me|2024\nh2|fix: b|me|2024',
        headDiff: 'uncommitted bit\n',
      }),
    )
    const staged = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(staged, 'uncommitted.diff'))).toBe(true)
    expect(meta.commits).toHaveLength(2)
    // The newest commit pairs with the LAST patch — log and format-patch run opposite ways.
    expect(meta.commits[0]).toMatchObject({ hash: 'h1', patchFile: '0002-a.patch' })
    expect(meta.commits[1]).toMatchObject({ hash: 'h2', patchFile: '0001-b.patch' })
    // subjects drive the description + suggested message
    expect(meta.description).toBe('feat: a; fix: b')
  })

  it('omits the uncommitted remainder when there is none', async () => {
    const meta = await assembleParcel(
      { repoRoot: dir, from: 'b' },
      fakeOps({
        seedDiff: 'd\n',
        subjects: ['x'],
        patchFiles: ['0001.patch'],
        commitLog: 'h|x|m|d',
        headDiff: '',
      }),
    )
    expect(await exists(join(getStagingHandoffDir(dir, meta.name), 'uncommitted.diff'))).toBe(false)
  })

  it('records codeSource only when it differs from the sender', async () => {
    const same = await assembleParcel(
      { repoRoot: dir, from: 'b', codeSource: 'b' },
      fakeOps({ seedDiff: 'd\n' }),
    )
    expect(same.codeSource).toBeUndefined()
    const diff = await assembleParcel(
      { repoRoot: dir, from: 'review', codeSource: 'builder' },
      fakeOps({ seedDiff: 'd\n' }),
    )
    expect(diff.codeSource).toBe('builder')
  })
})

describe('contentDigest', () => {
  it('is stable for the same inputs and differs when they change', () => {
    expect(contentDigest(['a', 'b'])).toBe(contentDigest(['a', 'b']))
    expect(contentDigest(['a', 'b'])).not.toBe(contentDigest(['a', 'c']))
  })
})

describe('parcelName', () => {
  it('joins the sender and the first 8 hash chars', () => {
    expect(parcelName('builder', 'abcdef1234567890')).toBe('builder-abcdef12')
  })
})

describe('parseCommits', () => {
  // The two inputs run in OPPOSITE directions: `git log` is newest-first, `git format-patch` numbers
  // oldest-first (`0001-` is the oldest commit). Pairing them by raw index maps every commit to the
  // wrong patch — exactly reversed, so only the middle of an odd-length run lands right, which is
  // why it reached recipients looking intermittent. Verified against real git: three commits
  // first/second/third produced `third → 0001-first.patch`.
  it('pairs the newest commit with the LAST patch, since the two run in opposite directions', () => {
    const commits = parseCommits('newest|msg one|amy|2024\noldest|msg two|bob|2025', [
      '0001-oldest.patch',
      '0002-newest.patch',
    ])
    expect(commits).toEqual([
      {
        hash: 'newest',
        message: 'msg one',
        author: 'amy',
        date: '2024',
        patchFile: '0002-newest.patch',
      },
      {
        hash: 'oldest',
        message: 'msg two',
        author: 'bob',
        date: '2025',
        patchFile: '0001-oldest.patch',
      },
    ])
  })

  it('keeps the emitted order newest-first, reversing only the patch lookup', () => {
    const commits = parseCommits('c3|three|a|d\nc2|two|a|d\nc1|one|a|d', ['p1', 'p2', 'p3'])
    expect(commits.map((c) => c.hash)).toEqual(['c3', 'c2', 'c1'])
    expect(commits.map((c) => c.patchFile)).toEqual(['p3', 'p2', 'p1'])
  })

  it('leaves patchFile empty when there are fewer patches than commits', () => {
    expect(parseCommits('h1|m|a|d', [])[0].patchFile).toBe('')
  })
})
