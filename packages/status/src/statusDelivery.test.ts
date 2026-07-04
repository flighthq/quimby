import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentStatusMirrorDir } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deliverStatusSnapshot } from './statusDelivery'
import { formatStatusSnapshot } from './statusSnapshot'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quimby-statusdel-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('deliverStatusSnapshot', () => {
  it('writes the payload into a local recipient status/<from>.md mirror', async () => {
    const toAgent = { id: 'to-id', name: 'reviewer', location: { type: 'local' } } as AgentState
    const payload = formatStatusSnapshot('builder', 'halfway done', '2026-07-02T00:00:00.000Z')

    await deliverStatusSnapshot({
      repoRoot: dir,
      stateId: 'p',
      fromName: 'builder',
      toAgent,
      payload,
    })

    const written = await readFile(
      join(getAgentStatusMirrorDir(dir, 'to-id'), 'builder.md'),
      'utf-8',
    )
    expect(written).toBe(payload)
    expect(written).toContain('halfway done')
  })
})
