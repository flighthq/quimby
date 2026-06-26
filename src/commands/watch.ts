import { defineCommand } from 'citty'
import { resolveWorkspace } from '../core/workspace.js'
import { loadConfig } from '../core/config.js'
import { startWatcher } from '../core/watcher.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'watch',
    description: 'Watch sandboxes for changes and auto-route bundles',
  },
  args: {
    poll: {
      type: 'string',
      description: 'Poll interval in seconds for remote sandboxes (default: 10)',
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()
    const config = await loadConfig(state.sourceRepoPath)
    const pollInterval = args.poll ? parseInt(args.poll, 10) * 1000 : 10_000

    logger.info(`Watching workspace "${state.name}"`)
    logger.info(
      `Sandboxes: ${Object.keys(state.sandboxes).join(', ')}`,
    )

    const watcher = startWatcher({
      workspacePath,
      config,
      state,
      callbacks: {
        onBundleCreated(sandbox, bundleId) {
          logger.success(`Bundle created: ${sandbox}/${bundleId}`)
        },
        onStatusChanged(sandbox) {
          logger.info(`Status updated: ${sandbox}`)
        },
        onMessageReceived(sandbox, from, messageId) {
          logger.info(`Message received: ${from} -> ${sandbox} (${messageId})`)
        },
      },
      pollInterval,
    })

    process.on('SIGINT', async () => {
      logger.info('Stopping watcher...')
      await watcher.close()
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      await watcher.close()
      process.exit(0)
    })

    await new Promise(() => {})
  },
})
