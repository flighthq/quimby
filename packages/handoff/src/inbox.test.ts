import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readInboxParcelNames } from './inbox'

let repoRoot: string
const AGENT_ID = 'agent-1'

function receivedDir(): string {
  return join(repoRoot, '.quimby', 'agents', AGENT_ID, 'handoff', 'in', 'received')
}

beforeEach(() => {
  repoRoot = join(tmpdir(), `quimby-inbox-${crypto.randomUUID()}`)
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('readInboxParcelNames', () => {
  it('returns delivered parcels from in/received sorted, excluding stray files', async () => {
    await mkdir(join(receivedDir(), 'review-aaa'), { recursive: true })
    await mkdir(join(receivedDir(), 'host-bbb'), { recursive: true })
    await writeFile(join(receivedDir(), 'stray.txt'), 'x')

    expect(await readInboxParcelNames(repoRoot, AGENT_ID)).toEqual(['host-bbb', 'review-aaa'])
  })

  it('returns an empty list when the received dir does not exist', async () => {
    expect(await readInboxParcelNames(repoRoot, 'no-such-agent')).toEqual([])
  })
})
