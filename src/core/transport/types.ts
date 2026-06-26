export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SandboxTransport {
  readonly sandboxPath: string

  pushFile(relativePath: string, content: string): Promise<void>
  pullFile(relativePath: string): Promise<string>
  pushDir(localPath: string, relativePath: string): Promise<void>
  pullDir(relativePath: string, localPath: string): Promise<void>
  exists(relativePath: string): Promise<boolean>
  listDir(relativePath: string): Promise<string[]>
  ensureDir(relativePath: string): Promise<void>
  exec(command: string[], opts?: { cwd?: string }): Promise<ExecResult>
  watch?(callback: (event: string, path: string) => void): { close(): Promise<void> }
}
