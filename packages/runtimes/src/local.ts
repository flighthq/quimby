import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

import { parseCommand } from './command'

export const local: RuntimeAdapter = {
  type: 'local',

  async setup() {},

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const { command, args } = parseCommand(entrypoint)
    return { command, args, cwd: ctx.agentDir }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const { command, args } = parseCommand(entrypoint)
    return { command, args, cwd: ctx.agentDir }
  },

  // A local agent runs directly on the host with no sandbox, so there is nothing to tear down.
  teardownSpec(): RunSpec | null {
    return null
  },

  async teardown() {},
}
