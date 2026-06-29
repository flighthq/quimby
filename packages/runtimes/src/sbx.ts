import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

function sandboxName(ctx: RuntimeContext, entrypoint: string): string {
  const program = entrypoint.split(/\s+/)[0]
  return `${program}-${ctx.projectId.slice(0, 8)}-${ctx.agentId.slice(0, 8)}`
}

export const sbx: RuntimeAdapter = {
  type: 'sbx',

  async setup() {},

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx, entrypoint), entrypoint],
      cwd: ctx.agentDir,
    }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const parts = entrypoint.split(/\s+/)
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx, entrypoint), parts[0], '--', ...parts.slice(1)],
      cwd: ctx.agentDir,
    }
  },

  async teardown() {},
}
