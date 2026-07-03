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

  async teardown() {},
}
