import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimby/types'

function sandboxName(ctx: RuntimeContext, agentCmd: string): string {
  const agent = agentCmd.split(/\s+/)[0]
  return `${agent}-${ctx.projectId.slice(0, 8)}-${ctx.workerId.slice(0, 8)}`
}

export const sbx: RuntimeAdapter = {
  type: 'sbx',

  async setup() {},

  runSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx, agentCmd), agentCmd],
      cwd: ctx.workerDir,
    }
  },

  execSpec(ctx: RuntimeContext, agentCmd: string): RunSpec {
    const parts = agentCmd.split(/\s+/)
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx, agentCmd), parts[0], '--', ...parts.slice(1)],
      cwd: ctx.workerDir,
    }
  },

  async teardown() {},
}
