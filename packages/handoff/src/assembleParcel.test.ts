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
        patchFiles: ['0001-a.patch', '0002-b.patch'],
        commitLog: 'h1|feat: a|me|2024\nh2|fix: b|me|2024',
        headDiff: 'uncommitted bit\n',
      }),
    )
    const staged = getStagingHandoffDir(dir, meta.name)
    expect(await exists(join(staged, 'uncommitted.diff'))).toBe(true)
    expect(meta.commits).toHaveLength(2)
    expect(meta.commits[0]).toMatchObject({ hash: 'h1', patchFile: '0001-a.patch' })
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
  it('pairs each pipe-delimited log line with its patch file by index', () => {
    const commits = parseCommits('h1|msg one|amy|2024\nh2|msg two|bob|2025', [
      '0001.patch',
      '0002.patch',
    ])
    expect(commits).toEqual([
      { hash: 'h1', message: 'msg one', author: 'amy', date: '2024', patchFile: '0001.patch' },
      { hash: 'h2', message: 'msg two', author: 'bob', date: '2025', patchFile: '0002.patch' },
    ])
  })

  it('leaves patchFile empty when there are fewer patches than commits', () => {
    expect(parseCommits('h1|m|a|d', [])[0].patchFile).toBe('')
  })
})
