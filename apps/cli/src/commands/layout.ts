import { QuimbyError } from '@quimbyhq/errors'
import { resolveLayoutPlan } from '@quimbyhq/layout'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

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

  const { repoRoot } = await resolveWorkspace()
  const plan = await resolveLayoutPlan({
    repoRoot,
    name: args.name,
    useDefault: args.default,
    commandMode: 'cli',
    createMissingPresetAgents: true,
  })

  console.log(JSON.stringify(plan, null, 2))
}
