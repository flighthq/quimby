export type RuntimeType = 'local' | 'sbx' | 'openshell'

export interface RuntimeContext {
  projectId: string
  workerId: string
  workerName: string
  workerDir: string
  repoDir: string
  repoRoot: string
}

export interface RunSpec {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface RuntimeAdapter {
  type: RuntimeType

  setup(ctx: RuntimeContext): Promise<void>

  runSpec(ctx: RuntimeContext, agentCmd: string): RunSpec | Promise<RunSpec>

  execSpec(ctx: RuntimeContext, agentCmd: string): RunSpec

  teardown(ctx: RuntimeContext): Promise<void>
}
