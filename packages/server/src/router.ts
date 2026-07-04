import type { QuimbyState } from '@quimbyhq/types'

import type { StatusSnapshot } from './poller'

export interface RouteResult {
  status: number
  body: unknown
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
 * Map an HTTP request to a response for the server's read-only API. Pure — no socket, no
 * filesystem — so every route and 404 is unit-testable; the server just writes the response.
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
    if (!Object.hasOwn(state.agents, name)) {
      return { status: 404, body: { error: `Agent "${name}" not found` } }
    }
    return {
      status: 200,
      body: { ...state.agents[name], currentStatus: statusCache.get(name)?.content ?? null },
    }
  }

  return { status: 404, body: { error: 'Not found' } }
}
