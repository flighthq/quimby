import { defineCommand } from 'citty'
import { resolve } from 'pathe'
import { resolveWorkspace } from '../core/workspace.js'
import { applyPack, type ApplyMode } from '../core/pack.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'apply',
    description: 'Apply a pack to your repository',
  },
  args: {
    pack: {
      type: 'positional',
      description: 'Pack name',
      required: true,
    },
    commits: {
      type: 'boolean',
      description: 'Replay individual commits instead of squashing',
      default: false,
    },
    patch: {
      type: 'boolean',
      description: 'Apply as working tree changes without committing',
      default: false,
    },
    branch: {
      type: 'string',
      alias: 'b',
      description: 'Create a branch before applying (default name: quimby/<pack>)',
    },
    target: {
      type: 'string',
      alias: 't',
      description: 'Target repo path (defaults to current directory)',
    },
  },
  async run({ args }) {
    const { repoRoot } = await resolveWorkspace()

    if (args.commits && args.patch) {
      throw new QuimbyError('Cannot use --commits and --patch together')
    }

    const mode: ApplyMode = args.commits
      ? 'commits'
      : args.patch
        ? 'patch'
        : 'squashed'

    const targetRepoPath = resolve(args.target ?? process.cwd())

    let branch: boolean | string | undefined
    if (args.branch !== undefined) {
      branch = args.branch === '' ? true : args.branch
    }

    logger.start(`Applying pack "${args.pack}" (${mode} mode)`)

    await applyPack({ repoRoot, packName: args.pack, targetRepoPath, mode, branch })

    logger.success(`Pack applied to ${targetRepoPath}`)
    if (mode === 'patch') {
      logger.info('Changes applied to working tree (no commit created)')
    }
  },
})
