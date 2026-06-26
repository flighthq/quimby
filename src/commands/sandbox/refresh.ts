import { defineCommand } from 'citty'
import { resolveWorkspace, saveWorkspaceState } from '../../core/workspace.js'
import { refreshSandbox } from '../../core/refresh.js'
import { createTransport } from '../../core/transport/index.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'refresh',
    description: 'Update a sandbox\'s baseline to match the latest source',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Force refresh even with uncommitted or unbundled work',
      default: false,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()
    const sandboxState = state.sandboxes[args.name]

    if (!sandboxState) {
      throw new AoError(`Sandbox "${args.name}" not found`)
    }

    const transport = createTransport(workspacePath, sandboxState)

    logger.start(
      `Refreshing sandbox "${args.name}" to latest ${state.sourceRef}`,
    )

    const result = await refreshSandbox({
      workspacePath,
      sandbox: sandboxState,
      sourceRepo: state.sourceRepo,
      sourceRef: state.sourceRef,
      transport,
      force: args.force,
    })

    sandboxState.seedCommit = result.newSeed
    await saveWorkspaceState(workspacePath, state)

    logger.success(
      `Sandbox "${args.name}" refreshed: ` +
      `${result.previousSeed.slice(0, 8)} → ${result.newSeed.slice(0, 8)}`,
    )
    if (result.hadUnbundledWork) {
      logger.warn('Previous unbundled work was discarded.')
    }
    if (result.stashed) {
      logger.info('Uncommitted changes were stashed.')
    }
  },
})
