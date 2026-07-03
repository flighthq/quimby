import { logger } from '@quimbyhq/utils'
import { defineCommand } from 'citty'

import { runMergeCommand } from './merge'

export default defineCommand({
  meta: {
    name: 'apply',
    description: 'Deprecated alias for `quimby merge`',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent whose work to merge',
      required: true,
    },
    commits: {
      type: 'boolean',
      description: 'Replay individual commits instead of squashing',
      default: false,
    },
    patch: {
      type: 'boolean',
      description: 'Land as working tree changes without committing',
      default: false,
    },
    '3way': {
      type: 'boolean',
      description: 'Accepted for compatibility (the merge-based flow is always 3-way)',
      default: false,
    },
    branch: {
      type: 'string',
      alias: 'b',
      description: 'Create a branch before merging',
    },
    target: {
      type: 'string',
      alias: 't',
      description: 'Target repo path (defaults to current directory)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Commit message',
    },
    rebase: {
      type: 'boolean',
      description: 'Rebase the agent onto host HEAD before merging',
      default: false,
    },
    sync: {
      type: 'string',
      description:
        "Advance the agent's seed onto the merge when it lands cleanly on its branch (on by default; --sync <ref> also retargets the agent's sync ref to <ref>; --no-sync skips)",
    },
  },
  run: runApplyCommand,
})

export async function runApplyCommand(ctx: {
  args: {
    agent: string
    commits: boolean
    patch: boolean
    '3way': boolean
    branch?: string
    target?: string
    message?: string
    rebase: boolean
    sync?: string | boolean
  }
}) {
  logger.warn('`quimby apply` is deprecated — use `quimby merge` instead.')
  return runMergeCommand(ctx)
}
