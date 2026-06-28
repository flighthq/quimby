import type { RunSpec, RuntimeAdapter, RuntimeContext } from '../types/runtime'

export const openshell: RuntimeAdapter = {
  type: 'openshell',

  async setup() {},

  runSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    return {
      command: 'openshell',
      args: ['sandbox', 'create', '--', agentCmd],
      cwd: ctx.workerDir,
    }
  },

  execSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    const parts = agentCmd.split(/\s+/)
    return {
      command: 'openshell',
      args: ['sandbox', 'create', '--', ...parts],
      cwd: ctx.workerDir,
    }
  },

  async teardown() {},
}
