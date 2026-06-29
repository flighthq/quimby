import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

function parseCmd(agentCmd: string): { command: string; args: string[] } {
  const parts = agentCmd.split(/\s+/)
  return { command: parts[0], args: parts.slice(1) }
}

export const local: RuntimeAdapter = {
  type: 'local',

  async setup() {},

  runSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    const { command, args } = parseCmd(agentCmd)
    return { command, args, cwd: ctx.workerDir }
  },

  execSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    const { command, args } = parseCmd(agentCmd)
    return { command, args, cwd: ctx.workerDir }
  },

  async teardown() {},
}
