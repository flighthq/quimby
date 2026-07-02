import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import type { StatusSnapshot } from './poller'
import { countSubscriptions, routeRequest } from './router'

function state(over: Partial<QuimbyState> = {}): QuimbyState {
  return {
    id: 'proj',
    sourceRef: 'main',
    agents: { backend: { id: 'b1', name: 'backend', location: { type: 'local' } } },
    subscriptions: { reviewer: ['backend'] },
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

describe('countSubscriptions', () => {
  it('sums targets across all subscribers', () => {
    expect(countSubscriptions(state({ subscriptions: { a: ['x', 'y'], b: ['z'] } }))).toBe(3)
  })

  it('is 0 when there are no subscriptions', () => {
    expect(countSubscriptions(state({ subscriptions: {} }))).toBe(0)
  })
})

describe('routeRequest', () => {
  it('GET /api/status returns server + counts', () => {
    const r = req({ path: '/api/status' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ pid: 123, port: 7749, uptime: 42, agents: 1, subscriptions: 1 })
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

  it('GET /api/subscriptions returns the subscription map', () => {
    expect(req({ path: '/api/subscriptions' }).body).toEqual({ reviewer: ['backend'] })
  })

  it('POST /api/subscriptions emits a subscribe mutation', () => {
    const r = req({
      method: 'POST',
      path: '/api/subscriptions',
      body: JSON.stringify({ subscriber: 'a', target: 'b' }),
    })
    expect(r.status).toBe(200)
    expect(r.mutation).toEqual({ type: 'subscribe', subscriber: 'a', target: 'b' })
  })

  it('POST /api/subscriptions returns 400 (no mutation) when fields are missing', () => {
    const r = req({
      method: 'POST',
      path: '/api/subscriptions',
      body: JSON.stringify({ subscriber: 'a' }),
    })
    expect(r.status).toBe(400)
    expect(r.mutation).toBeUndefined()
  })

  it('DELETE decodes the path and emits an unsubscribe mutation', () => {
    const r = req({ method: 'DELETE', path: '/api/subscriptions/rev%40x/back%2Fend' })
    expect(r.status).toBe(200)
    expect(r.mutation).toEqual({ type: 'unsubscribe', subscriber: 'rev@x', target: 'back/end' })
  })

  it('returns 404 for an unknown route', () => {
    expect(req({ path: '/nope' })).toMatchObject({ status: 404, body: { error: 'Not found' } })
  })

  it('throws on a malformed POST body (the server maps it to 500)', () => {
    expect(() => req({ method: 'POST', path: '/api/subscriptions', body: 'not json' })).toThrow()
  })
})
