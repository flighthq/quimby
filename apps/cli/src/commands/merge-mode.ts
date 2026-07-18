import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import type { QuimbyConfig } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { loadQuimbyConfig, saveMergeModeDefault } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

const MODES = ['squashed', 'commits', 'patch'] as const

export default defineCommand({
  meta: {
    name: 'merge-mode',
    description: 'Show or set the default mode a bare `quimby merge` uses (squashed/commits/patch)',
  },
  args: {
    mode: {
      type: 'positional',
      description: 'Mode to set: squashed, commits, or patch (omit to show the current default)',
      required: false,
    },
    global: {
      type: 'boolean',
      default: false,
      description: 'Save for every project (~/.config/quimby/config.yaml) instead of this repo',
    },
  },
  run: runMergeModeCommand,
})

export async function runMergeModeCommand({
  args,
}: {
  args: { mode?: string; global?: boolean }
}): Promise<void> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')

  // No mode → show the resolved default (across the config layers), or the built-in fallback.
  if (!args.mode) {
    showMergeMode(await loadQuimbyConfig(repoRoot))
    return
  }

  const mode = args.mode.trim()
  if (!isMergeMode(mode)) {
    throw new QuimbyError(`Invalid merge mode "${args.mode}" — use squashed, commits, or patch.`)
  }
  const path = await saveMergeModeDefault(repoRoot, mode, { global: args.global })
  logger.success(`Default merge mode set to "${mode}" (${path})`)
}

function isMergeMode(value: string): value is NonNullable<QuimbyConfig['mergeMode']> {
  return (MODES as readonly string[]).includes(value)
}

function showMergeMode(config: Readonly<QuimbyConfig>): void {
  if (config.mergeMode) {
    logger.info(`Default merge mode: ${config.mergeMode}`)
    return
  }
  logger.info(
    'Default merge mode: squashed (built-in default — set one with `quimby merge-mode <mode>`)',
  )
}
