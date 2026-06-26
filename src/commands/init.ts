import { defineCommand } from 'citty'
import { resolve } from 'pathe'
import { createWorkspace } from '../core/workspace.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Create a workspace from a repo containing ao.config.ts',
  },
  args: {
    repo: {
      type: 'positional',
      description: 'Path to the source repo (defaults to current directory)',
      required: false,
    },
  },
  async run({ args }) {
    const repoPath = resolve(args.repo ?? '.')

    logger.start(`Initializing workspace from ${repoPath}`)

    const { state, workspacePath } = await createWorkspace(repoPath)

    const sandboxNames = Object.keys(state.sandboxes)
    logger.success(`Workspace "${state.name}" created at ${workspacePath}`)
    logger.info(`Sandboxes: ${sandboxNames.join(', ')}`)
    logger.info(`Source: ${state.sourceRepo} @ ${state.snapshot.slice(0, 8)}`)
  },
})
