export interface RunSpec {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}
