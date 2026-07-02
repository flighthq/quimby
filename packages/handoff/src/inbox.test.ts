import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readInboxParcelNames } from './inbox'

let repoRoot: string
const AGENT_ID = 'agent-1'

function inboxDir(): string {
  return join(repoRoot, '.quimby', 'agents', AGENT_ID, 'inbox')
}

beforeEach(() => {
  repoRoot = join(tmpdir(), `quimby-inbox-${crypto.randomUUID()}`)
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('readInboxParcelNames', () => {
  it('returns delivered parcels sorted, excluding status/, .done/, and stray files', async () => {
    await mkdir(join(inboxDir(), 'review-aaa'), { recursive: true })
    await mkdir(join(inboxDir(), 'host-bbb'), { recursive: true })
    await mkdir(join(inboxDir(), 'status'), { recursive: true })
    await mkdir(join(inboxDir(), '.done', 'old-ccc'), { recursive: true })
    await writeFile(join(inboxDir(), 'stray.txt'), 'x')

    expect(await readInboxParcelNames(repoRoot, AGENT_ID)).toEqual(['host-bbb', 'review-aaa'])
  })

  it('returns an empty list when the inbox does not exist', async () => {
    expect(await readInboxParcelNames(repoRoot, 'no-such-agent')).toEqual([])
  })
})
