import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { startServer } from '../core/server.js'
import { getServerInfo } from '../core/client.js'
import { QuimbyError } from '../utils/errors.js'

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
  async run({ args }) {
    const { repoRoot } = await resolveWorkspace()

    const existing = await getServerInfo(repoRoot)
    if (existing) {
      throw new QuimbyError(
        `Server already running (PID: ${existing.pid}, port: ${existing.port})`,
      )
    }

    const port = args.port ? parseInt(args.port, 10) : undefined
    const pollInterval = args.poll ? parseInt(args.poll, 10) * 1000 : undefined

    await startServer({ repoRoot, port, pollInterval })
  },
})
