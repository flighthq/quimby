import type { RunSpec } from './RunSpec'
import type { RuntimeContext } from './RuntimeContext'
import type { RuntimeType } from './RuntimeType'

export interface RuntimeAdapter {
  type: RuntimeType

  setup(ctx: RuntimeContext): Promise<void>

  /**
   * `env` is the resolved profile environment the caller will set on the spawned process. A
   * runtime whose sandbox does not inherit its launcher's environment (`sbx`) must forward it
   * explicitly; one that runs the entrypoint directly (`local`) can ignore it.
   */
  runSpec(ctx: RuntimeContext, entrypoint: string, env?: Readonly<Record<string, string>>): RunSpec

  execSpec(ctx: RuntimeContext, entrypoint: string, env?: Readonly<Record<string, string>>): RunSpec
}
