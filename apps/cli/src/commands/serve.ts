import type { Reporter } from '@quimbyhq/reporter'
import type { QuimbyServerHandle } from '@quimbyhq/server'
import { getServerInfo, startServer, stopServer } from '@quimbyhq/server'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

export default defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the quimby server (status mirroring + outbox auto-dispatch)',
  },
  args: {
    port: {
      type: 'string',
      alias: 'p',
      description: 'Port to listen on (default: 7749)',
    },
    poll: {
      type: 'string',
      description: 'Poll interval in seconds (default: 5)',
    },
    interactive: {
      type: 'boolean',
      alias: 'i',
      description:
        'Drop into a shell on top of the server (run quimby commands live; exit stops it)',
      default: false,
    },
    tty: {
      type: 'boolean',
      alias: 't',
      description: 'Alias of --interactive, so `serve -it` reads like `docker run -it`',
      default: false,
    },
    dispatch: {
      type: 'boolean',
      description:
        'Auto-carry settled outbox drafts to their recipients (on by default; --no-dispatch to skip)',
      default: true,
    },
    stop: {
      type: 'boolean',
      description: 'Stop the running quimby server for this workspace, then exit',
      default: false,
    },
  },
  run: runServeCommand,
})

export async function runServeCommand({
  args,
}: {
  args: {
    port?: string
    poll?: string
    interactive?: boolean
    tty?: boolean
    dispatch?: boolean
    stop?: boolean
  }
}) {
  const { repoRoot } = await resolveWorkspace()

  if (args.stop) {
    const stopped = await stopServer(repoRoot)
    if (stopped) {
      serveLog.success(`Stopped quimby server (pid ${stopped.pid}, port ${stopped.port}).`)
    } else {
      serveLog.info('No quimby server is running for this workspace.')
    }
    return
  }

  // Idempotent: a server already running for this workspace is a no-op, not an error — so a
  // dashboard `$service` pane running `quimby serve` (or a stray double-invocation) never
  // double-starts a poller. -it stacks a shell over the existing server without owning it.
  const existing = await getServerInfo(repoRoot)
  if (existing) {
    serveLog.info(`quimby server already running (pid ${existing.pid}, port ${existing.port}).`)
    if (args.interactive || args.tty) await runInteractiveShell(null)
    return
  }

  const port = args.port ? parseInt(args.port, 10) : undefined
  const pollInterval = args.poll ? parseInt(args.poll, 10) * 1000 : undefined
  const autoDispatch = args.dispatch !== false

  const handle = await startServer({
    repoRoot,
    port,
    pollInterval,
    autoDispatch,
    reporter: timestampedServeReporter,
  })

  if (args.interactive || args.tty) {
    await runInteractiveShell(handle)
    return
  }

  installSignalShutdown(handle)
}

// `handle` is null when a server was already running: we stack a shell over it but must not
// stop it on exit, since this invocation doesn't own its lifecycle.
async function runInteractiveShell(handle: Readonly<QuimbyServerHandle> | null): Promise<void> {
  const shell = process.env.SHELL || 'bash'
  serveLog.info(
    handle
      ? `quimby server running on port ${handle.port} — run quimby commands normally; ` +
          'type `exit` (or press Ctrl+C twice) to stop the server.'
      : 'Attached a shell over the running quimby server — run commands normally; ' +
          'type `exit` to leave (the server keeps running).',
  )

  const child = execa(shell, ['-i'], { stdio: 'inherit', reject: false })

  let lastSigint = 0
  const onSigint = () => {
    const now = Date.now()
    if (now - lastSigint < 2000) {
      child.kill('SIGKILL')
      return
    }
    lastSigint = now
    serveLog.info(
      handle
        ? 'Press Ctrl+C again (or type `exit`) to stop the quimby server.'
        : 'Press Ctrl+C again (or type `exit`) to leave (the server keeps running).',
    )
  }
  const onSigterm = () => child.kill('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  await child

  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  if (handle) {
    serveLog.info('Stopping quimby server...')
    await handle.stop()
    serveLog.success('quimby server stopped.')
  }
  process.exit(0)
}

function installSignalShutdown(handle: Readonly<QuimbyServerHandle>): void {
  const shutdown = async () => {
    serveLog.info('Shutting down...')
    await handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const serveLog = {
  start: (message: string): void => logger.start(formatServeLogMessage(message)),
  success: (message: string): void => logger.success(formatServeLogMessage(message)),
  info: (message: string): void => logger.info(formatServeLogMessage(message)),
  warn: (message: string): void => logger.warn(formatServeLogMessage(message)),
  error: (message: string): void => logger.error(formatServeLogMessage(message)),
}

const timestampedServeReporter: Reporter = serveLog

export function formatServeLogMessage(message: string, date = new Date()): string {
  return `[${formatServeTimestamp(date)}] ${message}`
}

function formatServeTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
