import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

export const openshell: RuntimeAdapter = {
  type: 'openshell',

  async setup() {},

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    return {
      command: 'openshell',
      args: ['sandbox', 'create', '--', entrypoint],
      cwd: ctx.agentDir,
    }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const parts = entrypoint.split(/\s+/)
    return {
      command: 'openshell',
      args: ['sandbox', 'create', '--', ...parts],
      cwd: ctx.agentDir,
    }
  },

  async teardown() {},
}
