import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { ensureWorkspace, loadQuimbyConfig } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { createMissingPresetAgents } from '../presetAgents'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Create missing agents from a configured preset',
  },
  args: {
    preset: {
      type: 'positional',
      description: 'Preset name from quimby.yaml',
      required: false,
    },
    default: {
      type: 'boolean',
      default: false,
      description: 'Use the configured default preset',
    },
  },
  run: runUpCommand,
})

export async function runUpCommand({ args }: { args: { preset?: string; default?: boolean } }) {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')

  await ensureWorkspace(repoRoot)
  const config = await loadQuimbyConfig(repoRoot)
  const presetName = resolveUpPresetName(config.default, args)
  await createMissingPresetAgents(repoRoot, config, presetName)
}

function resolveUpPresetName(
  configuredDefault: string | undefined,
  args: Readonly<{ preset?: string; default?: boolean }>,
): string {
  if (args.preset && args.default) {
    throw new QuimbyError('Choose either a preset name or --default, not both.')
  }
  if (args.preset) return args.preset
  if (configuredDefault) return configuredDefault
  throw new QuimbyError(
    'Provide a preset name or configure a default preset. ' +
      'Set one with `quimby run --layout <name> --default`, or add `default: <preset>` to quimby config.',
  )
}
