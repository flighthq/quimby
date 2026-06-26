import { defineCommand } from 'citty'
import { resolveWorkspace } from '../../core/workspace.js'
import { sendBundle } from '../../core/inbox.js'
import { listBundles } from '../../core/bundle.js'
import { getSandboxPath } from '../../utils/paths.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'send',
    description: 'Send a bundle to another sandbox\'s inbox',
  },
  args: {
    from: {
      type: 'positional',
      description: 'Source sandbox name',
      required: true,
    },
    to: {
      type: 'positional',
      description: 'Destination sandbox name',
      required: true,
    },
    bundle: {
      type: 'positional',
      description: 'Bundle ID (defaults to latest)',
      required: false,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()

    if (!state.sandboxes[args.from]) {
      throw new AoError(`Sandbox "${args.from}" not found`)
    }
    if (!state.sandboxes[args.to]) {
      throw new AoError(`Sandbox "${args.to}" not found`)
    }

    let bundleId = args.bundle

    if (!bundleId) {
      const sandboxPath = getSandboxPath(workspacePath, args.from)
      const bundles = await listBundles(sandboxPath)
      if (bundles.length === 0) {
        throw new AoError(`No bundles found in sandbox "${args.from}"`)
      }
      bundleId = bundles[bundles.length - 1].id
      logger.info(`Using latest bundle: ${bundleId}`)
    }

    await sendBundle({
      workspacePath,
      fromSandbox: args.from,
      toSandbox: args.to,
      bundleId,
    })

    logger.success(
      `Bundle "${bundleId}" sent from "${args.from}" to "${args.to}"`,
    )
  },
})
