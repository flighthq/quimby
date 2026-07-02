import { unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getQuimbyDir } from '@quimbyhq/paths'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import type { QuimbyState } from '@quimbyhq/types'
import { writeText } from '@quimbyhq/utils'
import {
  addSubscriptionToState,
  loadState,
  removeSubscriptionFromState,
  saveState,
} from '@quimbyhq/workspace'
import { join } from 'pathe'

import { autoDispatchOutboxes, createOutboxDispatchTracker } from './autodispatch'
import type { StatusSnapshot } from './poller'
import { getFileMtime, pollAgentStatus, reloadStateIfChanged } from './poller'
import { countSubscriptions, routeRequest } from './router'

export interface ServerOptions {
  repoRoot: string
  port?: number
  pollInterval?: number
  autoDispatch?: boolean
  /** Where the server narrates lifecycle + poll activity; the CLI passes a consola-backed one. */
  reporter?: Reporter
}

export interface ServerInfo {
  pid: number
  port: number
  startedAt: string
}

export interface QuimbyServerHandle {
  port: number
  stop(): Promise<void>
}

export async function startServer(opts: ServerOptions): Promise<QuimbyServerHandle> {
  const { repoRoot, port = 7749, pollInterval = 5000, autoDispatch = true } = opts
  const reporter = opts.reporter ?? silentReporter

  const statusCache = new Map<string, StatusSnapshot>()
  const outboxTracker = createOutboxDispatchTracker()
  let state = await loadState(repoRoot)
  let stateMtime = 0
  // The actual bound port; equals `port` unless it was 0 (OS-assigned ephemeral).
  let boundPort = port

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, `http://localhost:${boundPort}`)
    const body = req.method === 'POST' ? await readBody(req) : ''

    const result = routeRequest({
      method: req.method ?? 'GET',
      path: url.pathname,
      body,
      state,
      statusCache,
      meta: { pid: process.pid, port: boundPort, uptime: process.uptime() },
    })

    if (result.mutation) {
      const { type, subscriber, target } = result.mutation
      state =
        type === 'subscribe'
          ? await addSubscription(repoRoot, state, subscriber, target)
          : await removeSubscription(repoRoot, state, subscriber, target)
    }

    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }

  const poller = setInterval(async () => {
    try {
      state = await reloadStateIfChanged(repoRoot, state, stateMtime)
      const newMtime = await getFileMtime(join(getQuimbyDir(repoRoot), 'state.yaml'))
      if (newMtime !== null) stateMtime = newMtime

      for (const name of Object.keys(state.agents)) {
        await pollAgentStatus(repoRoot, state, name, statusCache, reporter)
      }
      if (autoDispatch) await autoDispatchOutboxes(repoRoot, state, outboxTracker, reporter)
    } catch (err) {
      reporter.error(`Poll error: ${err}`)
    }
  }, pollInterval)

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      reporter.error(`Port ${port} is already in use. Is another server running?`)
      process.exit(1)
    }
    throw err
  })

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      boundPort = (server.address() as AddressInfo | null)?.port ?? port
      reporter.success(`Server listening on http://127.0.0.1:${boundPort}`)
      reporter.info(`Polling every ${pollInterval / 1000}s`)
      reporter.info(`Watching ${Object.keys(state.agents).length} agent(s)`)
      if (autoDispatch) reporter.info('Auto-dispatching outboxes on change')
      const subCount = countSubscriptions(state)
      if (subCount > 0) {
        reporter.info(`${subCount} active subscription(s)`)
      }
      resolve()
    })
  })

  await writeServerInfo(repoRoot, boundPort)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    clearInterval(poller)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeServerInfo(repoRoot)
  }

  return { port: boundPort, stop }
}

async function addSubscription(
  repoRoot: string,
  state: QuimbyState,
  subscriber: string,
  target: string,
): Promise<QuimbyState> {
  if (addSubscriptionToState(state, subscriber, target)) {
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
  if (removeSubscriptionFromState(state, subscriber, target)) {
    await saveState(repoRoot, state)
  }
  return state
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
