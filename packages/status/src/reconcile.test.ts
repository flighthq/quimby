import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentStatusMirrorDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { ensureDir } from '@quimbyhq/utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reconcileAgentStatusMirror, renderRemoteStatusReconcile } from './reconcile'

let dir: string

const STATE = {
  id: 'proj',
  agents: {
    builder: { id: 'builder-id', name: 'builder', location: { type: 'local' } },
    reviewer: { id: 'rev-id', name: 'reviewer', location: { type: 'local' } },
    tester: { id: 'test-id', name: 'tester', location: { type: 'local' } },
  },
} as unknown as QuimbyState

function ownerMirror(): string {
  return getAgentStatusMirrorDir(dir, 'builder-id')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quimby-reconcile-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('reconcileAgentStatusMirror', () => {
  it('creates a placeholder for every other agent, and none for the owner itself', async () => {
    await reconcileAgentStatusMirror(dir, STATE, 'builder')

    const files = (await readdir(ownerMirror())).sort()
    expect(files).toEqual(['reviewer.md', 'tester.md'])
    expect(await readFile(join(ownerMirror(), 'reviewer.md'), 'utf-8')).toContain(
      '_No status reported yet._',
    )
  })

  it('fills gaps without clobbering real mirrored content', async () => {
    await ensureDir(ownerMirror())
    await writeFile(join(ownerMirror(), 'reviewer.md'), '# Status: reviewer\n\nreal content\n')

    await reconcileAgentStatusMirror(dir, STATE, 'builder')

    expect(await readFile(join(ownerMirror(), 'reviewer.md'), 'utf-8')).toBe(
      '# Status: reviewer\n\nreal content\n',
    )
    expect(await readFile(join(ownerMirror(), 'tester.md'), 'utf-8')).toContain(
      '_No status reported yet._',
    )
  })

  it('deletes orphan files whose basename is not a current agent', async () => {
    await ensureDir(ownerMirror())
    await writeFile(join(ownerMirror(), 'ghost.md'), 'left over from a removed/renamed agent')

    await reconcileAgentStatusMirror(dir, STATE, 'builder')

    const files = (await readdir(ownerMirror())).sort()
    expect(files).toEqual(['reviewer.md', 'tester.md'])
  })

  it('is idempotent — a second run produces the same directory', async () => {
    await reconcileAgentStatusMirror(dir, STATE, 'builder')
    const first = (await readdir(ownerMirror())).sort()
    await reconcileAgentStatusMirror(dir, STATE, 'builder')
    const second = (await readdir(ownerMirror())).sort()
    expect(second).toEqual(first)
  })

  it('no-ops for an unknown owner', async () => {
    await reconcileAgentStatusMirror(dir, STATE, 'nobody')
    // Nothing to assert beyond not throwing; the unknown owner has no mirror dir.
    expect(true).toBe(true)
  })
})

describe('renderRemoteStatusReconcile', () => {
  it('creates the dir, writes a placeholder per absent peer, and sweeps orphans', () => {
    const cmd = renderRemoteStatusReconcile('/r/status', [
      { name: 'reviewer', placeholder: '# Status: reviewer\n\n_No status reported yet._\n' },
      { name: 'tester', placeholder: '# Status: tester\n\n_No status reported yet._\n' },
    ])
    expect(cmd).toContain('mkdir -p')
    expect(cmd).toContain('/r/status/reviewer.md')
    expect(cmd).toContain('/r/status/tester.md')
    // Orphan sweep keeps only listed peers.
    expect(cmd).toContain("case ' reviewer tester '")
    expect(cmd).toContain('rm -f "$f"')
  })
})
