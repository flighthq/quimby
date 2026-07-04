import type { RunSpec } from './RunSpec'
import type { RuntimeContext } from './RuntimeContext'
import type { RuntimeType } from './RuntimeType'

export interface RuntimeAdapter {
  type: RuntimeType

  setup(ctx: RuntimeContext): Promise<void>

  runSpec(ctx: RuntimeContext, entrypoint: string): RunSpec

  execSpec(ctx: RuntimeContext, entrypoint: string): RunSpec

  /**
   * The command that tears the agent's sandbox down (e.g. `sbx rm <name>`), or `null` when the
   * runtime has no sandbox to remove (`local`). Returned as data — rather than executed like
   * {@link teardown} — so the caller can run it locally *or* over an SSH transport, tearing down
   * a remote agent's sandbox on the machine where it actually lives.
   */
  teardownSpec(ctx: RuntimeContext): RunSpec | null

  teardown(ctx: RuntimeContext): Promise<void>
}
