import { createHash } from 'node:crypto'

import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

import { parseCommand } from './command'
import { bestEffortExec, requireRuntimeCli } from './probe'

// sbx is path-sensitive: it keys a sandbox off its working directory and persists
// that absolute path behind the --name, so the name must track the path rather than
// pin one. It also records the command a named sandbox runs; attempting to reuse a
// `claude` sandbox as `codex` fails. We therefore derive the name from the agent's
// location plus the base entrypoint command.
// Because agent directories are keyed by UUID, the path is stable across a rename —
// so the hash, and thus the sandbox, survives a rename — while a genuine relocation
// (the .quimby tree moving) changes the path, flips the hash, and lets a fresh
// sandbox fall out instead of a stale name pointing at a directory that is gone.
//
// The friendly agent name is deliberately NOT in the sandbox name: it changes on
// rename, which would break reuse. The agentId prefix is a stable, greppable handle
// for `sbx ls`; the name→agent mapping for humans lives in `quimby list`.
function sandboxName(ctx: RuntimeContext, entrypoint = ''): string {
  const command = entrypoint ? parseCommand(entrypoint).command : ''
  const hash = createHash('sha256')
    .update(`${ctx.projectId}\0${ctx.agentId}\0${ctx.agentDir}\0${command}`)
    .digest('hex')
    .slice(0, 12)
  return `qb-${ctx.agentId.slice(0, 8)}-${hash}`
}

export const sbx: RuntimeAdapter = {
  type: 'sbx',

  // Validate `sbx` is installed before a launch, so a missing CLI fails clearly here rather than
  // the agent's tmux pane dying instantly with a bare "[exited]".
  async setup() {
    await requireRuntimeCli('sbx', 'sbx')
  },

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx, entrypoint), entrypoint],
      cwd: ctx.agentDir,
    }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const parsed = parseCommand(entrypoint)
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx, entrypoint), parsed.command, '--', ...parsed.args],
      cwd: ctx.agentDir,
    }
  },

  // The remove verb for the agent's sandbox, as data so the caller can run it locally or over an
  // SSH transport (a remote agent's sandbox lives on the remote host). The exact `sbx` removal
  // verb may need adjusting as the CLI settles.
  teardownSpec(ctx: RuntimeContext): RunSpec {
    return { command: 'sbx', args: ['rm', sandboxName(ctx)], cwd: ctx.agentDir }
  },

  // Remove the agent's sandbox when the agent is torn down (remove/rebuild) on the local host.
  // Best-effort: a missing sandbox or CLI is fine.
  async teardown(ctx: RuntimeContext) {
    const spec = this.teardownSpec(ctx)
    if (spec) await bestEffortExec(spec.command, spec.args)
  },
}
