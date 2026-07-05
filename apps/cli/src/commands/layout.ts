import { QuimbyError } from '@quimbyhq/errors'
import { loadQuimbyConfig, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { buildResolvedLayoutPlan } from '../layoutPlan'
import { createMissingPresetAgents } from '../presetAgents'

export default defineCommand({
  meta: {
    name: 'layout',
    description: 'Resolve a saved layout or preset as a machine-readable plan',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Layout or preset name',
      required: false,
    },
    default: {
      type: 'boolean',
      default: false,
      description: 'Resolve the configured default preset layout',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Print the resolved renderer-neutral JSON plan',
    },
  },
  run: runLayoutCommand,
})

export async function runLayoutCommand({
  args,
}: {
  args: {
    name?: string
    default?: boolean
    json?: boolean
  }
}) {
  if (!args.json) {
    throw new QuimbyError('Only JSON output is supported for now. Use `quimby layout --json`.')
  }
  if (args.name && args.default) {
    throw new QuimbyError('Pass either a layout/preset name or --default, not both.')
  }

  const { state, repoRoot } = await resolveWorkspace()
  const config = await loadQuimbyConfig(repoRoot)
  const targetName = args.default ? config.default : args.name
  const materializesPreset = Boolean(targetName && config.presets?.[targetName]?.layout)

  // Match `quimby run --layout <preset>`: resolving a preset may materialize missing agents
  // before the terminal renderer later runs `quimby run <agent>`.
  if (targetName && materializesPreset) {
    await createMissingPresetAgents(repoRoot, config, targetName)
  }
  const refreshed = materializesPreset ? await resolveWorkspace() : { state, repoRoot }

  console.log(
    JSON.stringify(
      buildResolvedLayoutPlan({
        name: args.name,
        useDefault: args.default,
        state: refreshed.state,
        repoRoot: refreshed.repoRoot,
        config,
      }),
      null,
      2,
    ),
  )
}
