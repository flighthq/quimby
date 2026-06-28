import { defineCommand } from 'citty'
import { resolve } from 'pathe'

import { type ApplyMode, applyPack } from '../core/pack'
import { resolveWorkspace } from '../core/workspace'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'

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
  run,
})

async function run({
  args,
}: {
  args: { pack: string; commits: boolean; patch: boolean; branch?: string; target?: string }
}) {
  const { repoRoot } = await resolveWorkspace()

  if (args.commits && args.patch) {
    throw new QuimbyError('Cannot use --commits and --patch together')
  }

  const mode: ApplyMode = args.commits ? 'commits' : args.patch ? 'patch' : 'squashed'
  const targetRepoPath = resolve(args.target ?? process.cwd())
  const branch: boolean | string | undefined =
    args.branch !== undefined ? (args.branch === '' ? true : args.branch) : undefined

  logger.start(`Applying pack "${args.pack}" (${mode} mode)`)
  await applyPack({ repoRoot, packName: args.pack, targetRepoPath, mode, branch })

  logger.success(`Pack applied to ${targetRepoPath}`)
  if (mode === 'patch') {
    logger.info('Changes applied to working tree (no commit created)')
  }
}
