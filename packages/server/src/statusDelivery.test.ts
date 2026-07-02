import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentInboxStatusDir } from '@quimbyhq/paths'
import type { AgentState } from '@quimbyhq/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deliverStatusSnapshot, formatStatusSnapshot } from './statusDelivery'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quimby-statusdel-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('deliverStatusSnapshot', () => {
  it('writes the payload into a local recipient inbox/status/<from>.md', async () => {
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
      join(getAgentInboxStatusDir(dir, 'to-id'), 'builder.md'),
      'utf-8',
    )
    expect(written).toBe(payload)
    expect(written).toContain('halfway done')
  })
})

describe('formatStatusSnapshot', () => {
  it('renders the status routing payload with the source name and timestamp', () => {
    expect(formatStatusSnapshot('builder', 'body', '2026-07-02T00:00:00.000Z')).toBe(
      '# Status: builder\n\nUpdated: 2026-07-02T00:00:00.000Z\n\nbody\n',
    )
  })
})
