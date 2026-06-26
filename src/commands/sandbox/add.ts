import { defineCommand } from 'citty'
import { resolveWorkspace, saveWorkspaceState } from '../../core/workspace.js'
import { scaffoldSandbox } from '../../core/sandbox.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Add a new sandbox to the workspace',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Name for the new sandbox',
      required: true,
    },
    runtime: {
      type: 'string',
      description: 'Runtime type (default: docker-sandbox)',
      default: 'docker-sandbox',
    },
    role: {
      type: 'string',
      description: 'Role description for the sandbox agent',
      default: 'General-purpose agent',
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()

    if (state.sandboxes[args.name]) {
      throw new AoError(`Sandbox "${args.name}" already exists`)
    }

    const sandboxState = await scaffoldSandbox({
      workspacePath,
      sandboxName: args.name,
      sourceRepo: state.sourceRepo,
      sourceRef: state.sourceRef,
      config: {
        role: args.role,
        runtime: {
          type: args.runtime,
          launch: () => [],
        },
      },
    })

    state.sandboxes[args.name] = sandboxState
    await saveWorkspaceState(workspacePath, state)

    logger.success(`Sandbox "${args.name}" added`)
  },
})
