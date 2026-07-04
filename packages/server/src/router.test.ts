import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import type { StatusSnapshot } from './poller'
import { routeRequest } from './router'

function state(over: Partial<QuimbyState> = {}): QuimbyState {
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: { backend: { id: 'b1', name: 'backend', location: { type: 'local' } } },
    ...over,
  } as unknown as QuimbyState
}

const meta = { pid: 123, port: 7749, uptime: 42 }
const emptyCache = new Map<string, StatusSnapshot>()

function req(over: Partial<Parameters<typeof routeRequest>[0]>) {
  return routeRequest({
    method: 'GET',
    path: '/',
    body: '',
    state: state(),
    statusCache: emptyCache,
    meta,
    ...over,
  })
}

describe('routeRequest', () => {
  it('GET /api/status returns server info + agent count', () => {
    const r = req({ path: '/api/status' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ pid: 123, port: 7749, uptime: 42, agents: 1 })
  })

  it('GET /api/agents attaches the cached status', () => {
    const cache = new Map<string, StatusSnapshot>([['backend', { content: 'working', mtime: 1 }]])
    const r = req({ path: '/api/agents', statusCache: cache })
    expect((r.body as Record<string, { currentStatus: string }>).backend.currentStatus).toBe(
      'working',
    )
  })

  it('GET /api/agents/:name returns 404 for an unknown agent', () => {
    expect(req({ path: '/api/agents/ghost' }).status).toBe(404)
  })

  it('GET /api/agents/:name returns the agent + null status when uncached', () => {
    const r = req({ path: '/api/agents/backend' })
    expect(r.status).toBe(200)
    expect((r.body as { currentStatus: unknown }).currentStatus).toBeNull()
  })

  it('returns 404 for an unknown route', () => {
    expect(req({ path: '/nope' })).toMatchObject({ status: 404, body: { error: 'Not found' } })
  })
})
