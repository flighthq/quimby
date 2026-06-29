import { unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { getQuimbyDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { logger, writeText } from '@quimbyhq/utils'
import { loadState, saveState } from '@quimbyhq/workspace'
import { join } from 'pathe'

import type { StatusSnapshot } from './poller'
import { getFileMtime, pollAgentStatus, reloadStateIfChanged } from './poller'

export interface ServerOptions {
  repoRoot: string
  port?: number
  pollInterval?: number
}

export interface ServerInfo {
  pid: number
  port: number
  startedAt: string
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const { repoRoot, port = 7749, pollInterval = 5000 } = opts

  const statusCache = new Map<string, StatusSnapshot>()
  let state = await loadState(repoRoot)
  let stateMtime = 0

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, `http://localhost:${port}`)
    const path = url.pathname

    if (req.method === 'GET' && path === '/api/status') {
      json(res, {
        pid: process.pid,
        port,
        uptime: process.uptime(),
        agents: Object.keys(state.agents).length,
        subscriptions: countSubscriptions(state),
      })
      return
    }

    if (req.method === 'GET' && path === '/api/agents') {
      const agents: Record<string, unknown> = {}
      for (const [name, agent] of Object.entries(state.agents)) {
        const cached = statusCache.get(name)
        agents[name] = { ...agent, currentStatus: cached?.content ?? null }
      }
      json(res, agents)
      return
    }

    if (req.method === 'GET' && path.startsWith('/api/agents/')) {
      const name = path.split('/')[3]
      if (!state.agents[name]) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Agent "${name}" not found` }))
        return
      }
      const cached = statusCache.get(name)
      json(res, { ...state.agents[name], currentStatus: cached?.content ?? null })
      return
    }

    if (req.method === 'GET' && path === '/api/subscriptions') {
      json(res, state.subscriptions ?? {})
      return
    }

    if (req.method === 'POST' && path === '/api/subscriptions') {
      const body = await readBody(req)
      const { subscriber, target } = JSON.parse(body)
      if (!subscriber || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'subscriber and target required' }))
        return
      }
      state = await addSubscription(repoRoot, state, subscriber, target)
      json(res, { ok: true })
      return
    }

    if (req.method === 'DELETE' && path.startsWith('/api/subscriptions/')) {
      const parts = path.split('/')
      const subscriber = decodeURIComponent(parts[3])
      const target = decodeURIComponent(parts[4])
      state = await removeSubscription(repoRoot, state, subscriber, target)
      json(res, { ok: true })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  const poller = setInterval(async () => {
    try {
      state = await reloadStateIfChanged(repoRoot, state, stateMtime)
      const newMtime = await getFileMtime(join(getQuimbyDir(repoRoot), 'state.yaml'))
      if (newMtime !== null) stateMtime = newMtime

      for (const name of Object.keys(state.agents)) {
        await pollAgentStatus(repoRoot, state, name, statusCache)
      }
    } catch (err) {
      logger.error(`Poll error: ${err}`)
    }
  }, pollInterval)

  await writeServerInfo(repoRoot, port)

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is already in use. Is another server running?`)
      process.exit(1)
    }
    throw err
  })

  server.listen(port, '127.0.0.1', () => {
    logger.success(`Server listening on http://127.0.0.1:${port}`)
    logger.info(`Polling every ${pollInterval / 1000}s`)
    logger.info(`Watching ${Object.keys(state.agents).length} agent(s)`)
    const subCount = countSubscriptions(state)
    if (subCount > 0) {
      logger.info(`${subCount} active subscription(s)`)
    }
  })

  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(poller)
    server.close()
    await removeServerInfo(repoRoot)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function addSubscription(
  repoRoot: string,
  state: QuimbyState,
  subscriber: string,
  target: string,
): Promise<QuimbyState> {
  const subs = state.subscriptions ?? {}
  const targets = subs[subscriber] ?? []
  if (!targets.includes(target)) {
    targets.push(target)
    subs[subscriber] = targets
    state.subscriptions = subs
    await saveState(repoRoot, state)
  }
  return state
}

async function removeSubscription(
  repoRoot: string,
  state: QuimbyState,
  subscriber: string,
  target: string,
): Promise<QuimbyState> {
  const subs = state.subscriptions ?? {}
  if (subs[subscriber]) {
    subs[subscriber] = subs[subscriber].filter((t) => t !== target)
    if (subs[subscriber].length === 0) delete subs[subscriber]
    state.subscriptions = subs
    await saveState(repoRoot, state)
  }
  return state
}

function countSubscriptions(state: QuimbyState): number {
  const subs = state.subscriptions ?? {}
  return Object.values(subs).reduce((sum, targets) => sum + targets.length, 0)
}

async function writeServerInfo(repoRoot: string, port: number): Promise<void> {
  const info: ServerInfo = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  }
  await writeText(join(getQuimbyDir(repoRoot), 'server.json'), JSON.stringify(info, null, 2))
}

async function removeServerInfo(repoRoot: string): Promise<void> {
  try {
    await unlink(join(getQuimbyDir(repoRoot), 'server.json'))
  } catch {}
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
