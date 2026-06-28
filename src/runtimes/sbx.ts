import type { RunSpec, RuntimeAdapter, RuntimeContext } from '../types/runtime'

export const sbx: RuntimeAdapter = {
  type: 'sbx',

  async setup() {},

  runSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    return {
      command: 'sbx',
      args: ['run', agentCmd],
      cwd: ctx.workerDir,
    }
  },

  execSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    const parts = agentCmd.split(/\s+/)
    return {
      command: 'sbx',
      args: ['run', parts[0], '--', ...parts.slice(1)],
      cwd: ctx.workerDir,
    }
  },

  async teardown() {},
}
