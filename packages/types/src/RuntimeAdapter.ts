import type { RunSpec } from './RunSpec'
import type { RuntimeContext } from './RuntimeContext'
import type { RuntimeType } from './RuntimeType'

export interface RuntimeAdapter {
  type: RuntimeType

  setup(ctx: RuntimeContext): Promise<void>

  runSpec(ctx: RuntimeContext, agentCmd: string): RunSpec

  execSpec(ctx: RuntimeContext, agentCmd: string): RunSpec

  teardown(ctx: RuntimeContext): Promise<void>
}
