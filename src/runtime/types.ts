export interface LaunchSpec {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  detached?: boolean
  stdoutLog?: string
  stderrLog?: string
}

export interface RuntimeAdapter {
  readonly type: string
  buildLaunchSpec(configArgv: string[], sandboxPath: string): LaunchSpec
}
