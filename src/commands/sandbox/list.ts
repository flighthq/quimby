import { defineCommand } from 'citty'
import { resolveWorkspace } from '../../core/workspace.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List all sandboxes and their status',
  },
  async run() {
    const { state } = await resolveWorkspace()

    if (Object.keys(state.sandboxes).length === 0) {
      logger.info('No sandboxes configured.')
      return
    }

    logger.info(`Workspace: ${state.name}\n`)

    const rows = Object.values(state.sandboxes).map((s) => ({
      Name: s.name,
      Status: s.status,
      Runtime: s.runtimeType,
      Created: s.createdAt.slice(0, 10),
    }))

    console.table(rows)
  },
})
