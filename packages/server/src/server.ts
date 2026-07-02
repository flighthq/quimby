import { unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
  const { repoRoot, pollInterval = 5000, autoDispatch = true } = opts
  const reporter = opts.reporter ?? silentReporter

  const statusCache = new Map<string, StatusSnapshot>()
  const outboxTracker = createOutboxDispatchTracker()
  let state = await loadState(repoRoot)
  let stateMtime = 0
  // The actual bound port, set once the server is listening (see bindServer below).
  let boundPort = 0

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

  // Prefer 7749, but only pin it when the caller asked for a specific port. With no explicit
  // port, a busy 7749 (a server already up in another workspace) falls back to a free one, so
  // two workspaces can each run a server without a shared-default clash — server.json records
  // the actual port and every command reads its own workspace's file to find it. A bind failure
  // must not leave the poller running, so clear it before the error escapes.
  try {
    boundPort = await bindServer(server, opts.port ?? 7749, opts.port !== undefined, reporter)
  } catch (err) {
    clearInterval(poller)
    throw err
  }

  reporter.success(`Server listening on http://127.0.0.1:${boundPort}`)
  reporter.info(`Polling every ${pollInterval / 1000}s`)
  reporter.info(`Watching ${Object.keys(state.agents).length} agent(s)`)
  if (autoDispatch) reporter.info('Auto-dispatching outboxes on change')
  const subCount = countSubscriptions(state)
  if (subCount > 0) {
    reporter.info(`${subCount} active subscription(s)`)
  }

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

/**
 * Bind `server` to `preferredPort` on loopback and resolve with the port actually bound. When
 * the caller pinned a port (`explicit`), a clash is a hard error. Otherwise a busy default is
 * expected — another workspace's server holds it — so we retry on an OS-assigned free port
 * rather than fail. A non-`EADDRINUSE` error always propagates.
 */
async function bindServer(
  server: Server,
  preferredPort: number,
  explicit: boolean,
  reporter: Reporter,
): Promise<number> {
  try {
    return await tryListen(server, preferredPort)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    if (explicit) {
      throw new Error(
        `Port ${preferredPort} is already in use. Choose another with -p, or stop what's using it.`,
      )
    }
    reporter.warn(`Port ${preferredPort} is in use (another workspace?) — binding a free port.`)
    return tryListen(server, 0)
  }
}

/** Resolve with the bound port on success, reject with the listen error (a failed attempt leaves the server free to retry). */
function tryListen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
