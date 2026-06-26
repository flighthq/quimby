import { defineCommand } from 'citty'
import { resolveWorkspace } from '../../core/workspace.js'
import { createBundle, createBundleViaTransport } from '../../core/bundle.js'
import { createTransport } from '../../core/transport/index.js'
import { getSandboxPath } from '../../utils/paths.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'create',
    description: 'Create a bundle from a sandbox\'s work',
  },
  args: {
    sandbox: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
    id: {
      type: 'string',
      description: 'Bundle ID',
      required: true,
    },
    description: {
      type: 'string',
      alias: 'd',
      description: 'Bundle description',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Suggested commit message',
      required: true,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()
    const sandboxState = state.sandboxes[args.sandbox]

    if (!sandboxState) {
      throw new AoError(`Sandbox "${args.sandbox}" not found`)
    }

    logger.start(
      `Creating bundle "${args.id}" from sandbox "${args.sandbox}"`,
    )

    let meta
    if (sandboxState.host && sandboxState.user) {
      const transport = createTransport(workspacePath, sandboxState)
      meta = await createBundleViaTransport({
        transport,
        sandboxName: args.sandbox,
        bundleId: args.id,
        description: args.description,
        suggestedMessage: args.message,
      })
    } else {
      const sandboxPath = getSandboxPath(workspacePath, args.sandbox)
      meta = await createBundle({
        sandboxPath,
        sandboxName: args.sandbox,
        bundleId: args.id,
        description: args.description,
        suggestedMessage: args.message,
      })
    }

    logger.success(`Bundle "${meta.id}" created (${meta.commits.length} commits)`)
  },
})
