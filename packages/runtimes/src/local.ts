import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

function parseCmd(entrypoint: string): { command: string; args: string[] } {
  const parts = entrypoint.split(/\s+/)
  return { command: parts[0], args: parts.slice(1) }
}

export const local: RuntimeAdapter = {
  type: 'local',

  async setup() {},

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const { command, args } = parseCmd(entrypoint)
    return { command, args, cwd: ctx.agentDir }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const { command, args } = parseCmd(entrypoint)
    return { command, args, cwd: ctx.agentDir }
  },

  async teardown() {},
}
