import { QuimbyError } from '@quimbyhq/errors'
import { getServerInfo } from '@quimbyhq/server'
import { startServer } from '@quimbyhq/server'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the quimby server (status polling, subscription routing)',
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
  },
  run: runServeCommand,
})

export async function runServeCommand({ args }: { args: { port?: string; poll?: string } }) {
  const { repoRoot } = await resolveWorkspace()

  const existing = await getServerInfo(repoRoot)
  if (existing) {
    throw new QuimbyError(`Server already running (PID: ${existing.pid}, port: ${existing.port})`)
  }

  const port = args.port ? parseInt(args.port, 10) : undefined
  const pollInterval = args.poll ? parseInt(args.poll, 10) * 1000 : undefined

  await startServer({ repoRoot, port, pollInterval })
}
