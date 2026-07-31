import { unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getQuimbyDir } from '@quimbyhq/paths'
import { getPoolIdleTimeoutMs } from '@quimbyhq/pool'
import type { Reporter } from '@quimbyhq/reporter'
import { silentReporter } from '@quimbyhq/reporter'
import { reconcileAgentStatusMirror } from '@quimbyhq/status'
import { formatDuration, writeText } from '@quimbyhq/utils'
import {
  getFocusGraceSeconds,
  loadQuimbyConfig,
  loadState,
  resolveFocusPolicy,
  resolveNudgePolicy,
} from '@quimbyhq/workspace'
import { join } from 'pathe'

import { autoDispatchOutboxes, createOutboxDispatchTracker } from './autodispatch'
import { autoReapIdleSessions } from './autoreap'
import type { StatusSnapshot } from './poller'
import { getFileMtime, pollStatusCycle, reloadStateIfChanged } from './poller'
import { createInboxReminderTracker, remindUnreadInboxes } from './remind'
import { routeRequest } from './router'

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
  const reminderTracker = createInboxReminderTracker()
  let state = await loadState(repoRoot)
  let stateMtime = 0
  // Read once at startup: auto-reaping is a standing policy, so a config edit takes effect on the
  // next `quimby serve` rather than mid-run. Unset (the default) means the server never reaps.
  const serverConfig = await loadQuimbyConfig(repoRoot).catch(() => undefined)
  const idleTimeoutMs = getPoolIdleTimeoutMs(serverConfig)
  // Likewise standing policy: when an auto-dispatch nudge may type into a live session (§7).
  const nudgePolicy = resolveNudgePolicy(serverConfig ?? {})
  // …and what a nudge does when it lands on the pane the human is working in (§7). Separate gate:
  // `nudge` decides which parcels get this far, `whenFocused` whether typing now is acceptable.
  const focusPolicy = resolveFocusPolicy(serverConfig ?? {})
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

    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }

  // setInterval fires on a fixed clock regardless of whether the previous callback finished, and a
  // cycle over SSH (status poll + roster reconcile + dispatch assembly + reminder sweep, each a
  // round trip per agent) routinely outruns the interval on a real fleet. Overlapping cycles then
  // assemble the SAME parcel concurrently, and assembleParcel opens by `rm -rf`-ing the staging
  // dir — so the later cycle deletes `commits/` out from under the earlier one's rsync, which
  // surfaces as `mkstemp … No such file or directory`. One cycle at a time removes the race.
  let cycleTask: Promise<void> | null = null
  let skipped = 0
  const poller = setInterval(async () => {
    if (cycleTask) {
      // Surface a persistently overrunning cycle rather than silently doing less every tick.
      if (++skipped === 1 || skipped % SKIP_WARN_EVERY === 0) {
        reporter.warn(
          `Poll cycle still running after ${pollInterval / 1000}s — skipped ${skipped} tick(s). ` +
            'Raise --poll if this persists; overlapping cycles are not run.',
        )
      }
      return
    }
    skipped = 0
    // Held as a promise, not a flag, so `stop()` can await an in-flight cycle. A cycle writes into
    // the workspace (status mirrors, staging, server.json), so a caller that stops and then cleans
    // up — every test does, and so does a teardown script — otherwise races the writes and fails
    // with ENOTEMPTY on a directory the server is still filling.
    cycleTask = (async () => {
      try {
        state = await reloadStateIfChanged(repoRoot, state, stateMtime)
        const newMtime = await getFileMtime(join(getQuimbyDir(repoRoot), 'state.yaml'))
        if (newMtime !== null) stateMtime = newMtime

        await pollStatusCycle(repoRoot, state, statusCache, reporter)
        // Reconcile every agent's peer roster each cycle: guarantees a file per current peer
        // (placeholder until the poller delivers real content) and sweeps rename/remove orphans.
        // Per-agent guard so one unreachable SSH owner never aborts the whole cycle.
        for (const name of Object.keys(state.agents)) {
          try {
            await reconcileAgentStatusMirror(repoRoot, state, name)
          } catch (err) {
            reporter.warn(`[${name}] roster reconcile failed: ${err}`)
          }
        }
        if (autoDispatch) {
          await autoDispatchOutboxes(
            repoRoot,
            state,
            outboxTracker,
            reporter,
            nudgePolicy,
            serverConfig ?? {},
          )
          // Safety net: re-announce parcels an idle agent still hasn't read, so a lost wake doesn't
          // strand work until a human looks. Shares the --no-dispatch switch, since both are "keep
          // the fleet moving without me".
          await remindUnreadInboxes(
            repoRoot,
            state,
            reminderTracker,
            Date.now(),
            reporter,
            serverConfig ?? {},
          )
        }
        if (idleTimeoutMs) await autoReapIdleSessions(state, idleTimeoutMs, reporter)
      } catch (err) {
        reporter.error(`Poll error: ${err}`)
      } finally {
        cycleTask = null
      }
    })()
    await cycleTask
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
  reporter.info('Mirroring status to every agent')
  if (autoDispatch) {
    reporter.info('Auto-dispatching outboxes on change')
    // Name the resolved policy: "delivered, nobody woken" is otherwise indistinguishable from a
    // broken courier, and this is read ONCE at startup — so a config edit needs a server restart.
    reporter.info(
      `Nudge policy: ${nudgePolicy} (workspace default; an agent's own \`nudge\` overrides it, ` +
        'applied by `quimby sync`). Read at startup — restart the server after editing it.',
    )
    // The second gate, named separately because it is the one that makes a parcel land woken or
    // silent AFTER the nudge policy has already said yes — the distinction `nudge: all` cannot
    // express, and the reason a held nudge reads as a broken courier.
    reporter.info(
      `Focus policy: ${focusPolicy} (${FOCUS_POLICY_BLURB[focusPolicy]}; grace ` +
        `${getFocusGraceSeconds(serverConfig)}s after your last keystroke, per-agent ` +
        '`whenFocused` overrides it).',
    )
  }
  if (idleTimeoutMs) {
    reporter.info(`Reaping agent sessions idle over ${formatDuration(idleTimeoutMs)}`)
  }

  await writeServerInfo(repoRoot, boundPort)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    clearInterval(poller)
    // Let a cycle that is already running finish before the caller tears the workspace down.
    await cycleTask?.catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeServerInfo(repoRoot)
  }

  return { port: boundPort, stop }
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
 * expected — another workspace's server holds it — so we walk *upward* from the preferred port
 * (7749 → 7750 → …) to the next free one, which keeps ports predictable and greppable rather
 * than landing on a random high OS-assigned port; only if a whole window is busy do we fall
 * back to an OS-assigned port. A non-`EADDRINUSE` error always propagates.
 */
const PORT_SCAN_WINDOW = 16

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
    for (let port = preferredPort + 1; port <= preferredPort + PORT_SCAN_WINDOW; port++) {
      try {
        const bound = await tryListen(server, port)
        reporter.warn(`Port ${preferredPort} is in use (another workspace?) — using ${bound}.`)
        return bound
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      }
    }
    reporter.warn(`Ports ${preferredPort}–${preferredPort + PORT_SCAN_WINDOW} are busy — binding an OS-assigned port.`) // prettier-ignore
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

/** Skipped ticks between repeat warnings, so a persistently slow cycle says so without spamming. */
const SKIP_WARN_EVERY = 12

// How each focus policy reads in the startup banner. `directed` is the default and the one that
// needs explaining: it is derived per agent from the authority graph, not a single fleet-wide answer.
const FOCUS_POLICY_BLURB: Record<string, string> = {
  directed: 'a directed agent is typed into, the agent nobody directs holds',
  hold: "a nudge defers while you're working in the agent's pane",
  nudge: 'a nudge types even into the pane you are working in',
}
