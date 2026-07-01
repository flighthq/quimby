import { QuimbyError } from '@quimbyhq/errors'
import type { QuimbyServerHandle } from '@quimbyhq/server'
import { getServerInfo, startServer } from '@quimbyhq/server'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

export default defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the quimby server (status polling, outbox auto-dispatch, subscriptions)',
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
  },
  run: runServeCommand,
})

export async function runServeCommand({
  args,
}: {
  args: { port?: string; poll?: string; interactive?: boolean; tty?: boolean; dispatch?: boolean }
}) {
  const { repoRoot } = await resolveWorkspace()

  const existing = await getServerInfo(repoRoot)
  if (existing) {
    throw new QuimbyError(`Server already running (pid ${existing.pid}, port ${existing.port})`)
  }

  const port = args.port ? parseInt(args.port, 10) : undefined
  const pollInterval = args.poll ? parseInt(args.poll, 10) * 1000 : undefined
  const autoDispatch = args.dispatch !== false

  const handle = await startServer({ repoRoot, port, pollInterval, autoDispatch })

  if (args.interactive || args.tty) {
    await runInteractiveShell(handle)
    return
  }

  installSignalShutdown(handle)
}

async function runInteractiveShell(handle: Readonly<QuimbyServerHandle>): Promise<void> {
  const shell = process.env.SHELL || 'bash'
  logger.info(
    `quimby server running on port ${handle.port} — run quimby commands normally; ` +
      'type `exit` (or press Ctrl+C twice) to stop the server.',
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
    logger.info('Press Ctrl+C again (or type `exit`) to stop the quimby server.')
  }
  const onSigterm = () => child.kill('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  await child

  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  logger.info('Stopping quimby server...')
  await handle.stop()
  logger.success('quimby server stopped.')
  process.exit(0)
}

function installSignalShutdown(handle: Readonly<QuimbyServerHandle>): void {
  const shutdown = async () => {
    logger.info('Shutting down...')
    await handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
