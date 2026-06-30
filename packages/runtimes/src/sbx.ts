import { createHash } from 'node:crypto'

import type { RunSpec, RuntimeAdapter, RuntimeContext } from '@quimbyhq/types'

// sbx is path-sensitive: it keys a sandbox off its working directory and persists
// that absolute path behind the --name, so the name must track the path rather than
// pin one. We derive it from a hash of the agent's location (plus the stable IDs).
// Because agent directories are keyed by UUID, the path is stable across a rename —
// so the hash, and thus the sandbox, survives a rename — while a genuine relocation
// (the .quimby tree moving) changes the path, flips the hash, and lets a fresh
// sandbox fall out instead of a stale name pointing at a directory that is gone.
//
// The friendly agent name is deliberately NOT in the sandbox name: it changes on
// rename, which would break reuse. The agentId prefix is a stable, greppable handle
// for `sbx ls`; the name→agent mapping for humans lives in `quimby list`.
function sandboxName(ctx: RuntimeContext): string {
  const hash = createHash('sha256')
    .update(`${ctx.projectId}\0${ctx.agentId}\0${ctx.agentDir}`)
    .digest('hex')
    .slice(0, 12)
  return `qb-${ctx.agentId.slice(0, 8)}-${hash}`
}

export const sbx: RuntimeAdapter = {
  type: 'sbx',

  async setup() {},

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx), entrypoint],
      cwd: ctx.agentDir,
    }
  },

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec {
    const parts = entrypoint.split(/\s+/)
    return {
      command: 'sbx',
      args: ['run', '--name', sandboxName(ctx), parts[0], '--', ...parts.slice(1)],
      cwd: ctx.agentDir,
    }
  },

  async teardown() {},
}
