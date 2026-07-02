import type { QuimbyState } from '@quimbyhq/types'

import type { StatusSnapshot } from './poller'

/** A subscription change the router decided on; the server persists it. */
export type RouteMutation =
  | { type: 'subscribe'; subscriber: string; target: string }
  | { type: 'unsubscribe'; subscriber: string; target: string }

export interface RouteResult {
  status: number
  body: unknown
  /** A state change to apply + persist before responding (subscriptions only). */
  mutation?: RouteMutation
}

export interface RouteRequest {
  method: string
  path: string
  /** Raw request body (POST only); parsed as JSON here. */
  body: string
  state: Readonly<QuimbyState>
  statusCache: ReadonlyMap<string, StatusSnapshot>
  meta: { pid: number; port: number; uptime: number }
}

/**
 * Map an HTTP request to a response (and optional state mutation) for the server's API.
 * Pure — no socket, no filesystem — so every route, 404, and 400 is unit-testable; the
 * server writes the response and persists any mutation. Throws on a malformed POST body
 * (the server's outer handler turns that into a 500).
 */
export function routeRequest(req: Readonly<RouteRequest>): RouteResult {
  const { method, path, state, statusCache, meta } = req

  if (method === 'GET' && path === '/api/status') {
    return {
      status: 200,
      body: {
        pid: meta.pid,
        port: meta.port,
        uptime: meta.uptime,
        agents: Object.keys(state.agents).length,
        subscriptions: countSubscriptions(state),
      },
    }
  }

  if (method === 'GET' && path === '/api/agents') {
    const agents: Record<string, unknown> = {}
    for (const [name, agent] of Object.entries(state.agents)) {
      agents[name] = { ...agent, currentStatus: statusCache.get(name)?.content ?? null }
    }
    return { status: 200, body: agents }
  }

  if (method === 'GET' && path.startsWith('/api/agents/')) {
    const name = path.split('/')[3]
    if (!state.agents[name]) {
      return { status: 404, body: { error: `Agent "${name}" not found` } }
    }
    return {
      status: 200,
      body: { ...state.agents[name], currentStatus: statusCache.get(name)?.content ?? null },
    }
  }

  if (method === 'GET' && path === '/api/subscriptions') {
    return { status: 200, body: state.subscriptions ?? {} }
  }

  if (method === 'POST' && path === '/api/subscriptions') {
    const { subscriber, target } = JSON.parse(req.body)
    if (!subscriber || !target) {
      return { status: 400, body: { error: 'subscriber and target required' } }
    }
    return { status: 200, body: { ok: true }, mutation: { type: 'subscribe', subscriber, target } }
  }

  if (method === 'DELETE' && path.startsWith('/api/subscriptions/')) {
    const parts = path.split('/')
    const subscriber = decodeURIComponent(parts[3])
    const target = decodeURIComponent(parts[4])
    return {
      status: 200,
      body: { ok: true },
      mutation: { type: 'unsubscribe', subscriber, target },
    }
  }

  return { status: 404, body: { error: 'Not found' } }
}

export function countSubscriptions(state: Readonly<QuimbyState>): number {
  const subs = state.subscriptions ?? {}
  return Object.values(subs).reduce((sum, targets) => sum + targets.length, 0)
}
