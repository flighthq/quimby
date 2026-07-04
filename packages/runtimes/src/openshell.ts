import { createHash } from 'node:crypto'

import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

import { parseCommand } from './command'
import { bestEffortExec, requireRuntimeCli } from './probe'

// A stable per-agent sandbox handle, mirroring sbx's UUID-keyed naming so a rename reuses the
// sandbox and a relocation gets a fresh one.
function sandboxName(ctx: RuntimeContext): string {
  const hash = createHash('sha256')
    .update(`${ctx.projectId}\0${ctx.agentId}\0${ctx.agentDir}`)
    .digest('hex')
    .slice(0, 12)
  return `qb-${ctx.agentId.slice(0, 8)}-${hash}`
}

export const openshell: RuntimeAdapter = {
  type: 'openshell',

  // Validate the `openshell` CLI is installed before launching (clear error over a dead pane).
  async setup() {
    await requireRuntimeCli('openshell', 'openshell')
  },

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    return {
      command: 'openshell',
      args: ['sandbox', 'create', '--name', sandboxName(ctx), '--', entrypoint],
      cwd: ctx.agentDir,
    }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const parts = parseCommand(entrypoint)
    return {
      command: 'openshell',
      args: ['sandbox', 'create', '--name', sandboxName(ctx), '--', parts.command, ...parts.args],
      cwd: ctx.agentDir,
    }
  },

  // The remove verb for the agent's sandbox, as data so the caller can run it locally or over an
  // SSH transport (a remote agent's sandbox lives on the remote host).
  teardownSpec(ctx: RuntimeContext): RunSpec {
    return { command: 'openshell', args: ['sandbox', 'rm', sandboxName(ctx)], cwd: ctx.agentDir }
  },

  // Best-effort sandbox cleanup on agent teardown on the local host; the exact removal verb may
  // need adjusting.
  async teardown(ctx: RuntimeContext) {
    const spec = this.teardownSpec(ctx)
    if (spec) await bestEffortExec(spec.command, spec.args)
  },
}
