import { defineCommand } from 'citty'
import { join, resolve } from 'pathe'
import { resolveWorkspace } from '../../core/workspace.js'
import { applyBundle, type ApplyMode } from '../../core/bundle.js'
import { getSandboxPath } from '../../utils/paths.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'apply',
    description: 'Apply a bundle to your repository',
  },
  args: {
    sandbox: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
    bundle: {
      type: 'positional',
      description: 'Bundle ID',
      required: true,
    },
    commits: {
      type: 'boolean',
      description: 'Replay individual commits instead of squashing',
      default: false,
    },
    patch: {
      type: 'boolean',
      description: 'Apply as raw patch (no commit)',
      default: false,
    },
    target: {
      type: 'string',
      description: 'Target repo path (defaults to source repo)',
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()

    if (args.commits && args.patch) {
      throw new AoError('Cannot use --commits and --patch together')
    }

    const mode: ApplyMode = args.commits
      ? 'commits'
      : args.patch
        ? 'patch'
        : 'squashed'

    const sandboxPath = getSandboxPath(workspacePath, args.sandbox)
    const bundlePath = join(sandboxPath, '.sandbox', 'bundles', args.bundle)
    const targetRepoPath = resolve(args.target ?? state.sourceRepoPath)

    logger.start(
      `Applying bundle "${args.bundle}" from "${args.sandbox}" (${mode} mode)`,
    )

    await applyBundle({ bundlePath, targetRepoPath, mode })

    logger.success(`Bundle applied to ${targetRepoPath}`)
    if (mode === 'patch') {
      logger.info('Changes applied to working tree (no commit created)')
    }
  },
})
