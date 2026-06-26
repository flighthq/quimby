import { join, dirname } from 'pathe'
import { readdir } from 'node:fs/promises'
import { execa } from 'execa'
import { watch } from 'chokidar'
import { ensureDir as ensureDirFs, exists as existsFs, readText, writeText, cp } from '../../utils/fs.js'
import type { SandboxTransport, ExecResult } from './types.js'

export class LocalTransport implements SandboxTransport {
  constructor(public readonly sandboxPath: string) {}

  private resolve(relativePath: string): string {
    return join(this.sandboxPath, relativePath)
  }

  async pushFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath)
    await ensureDirFs(dirname(fullPath))
    await writeText(fullPath, content)
  }

  async pullFile(relativePath: string): Promise<string> {
    return readText(this.resolve(relativePath))
  }

  async pushDir(localPath: string, relativePath: string): Promise<void> {
    const dest = this.resolve(relativePath)
    await ensureDirFs(dest)
    await cp(localPath, dest, { recursive: true })
  }

  async pullDir(relativePath: string, localPath: string): Promise<void> {
    await ensureDirFs(localPath)
    await cp(this.resolve(relativePath), localPath, { recursive: true })
  }

  async exists(relativePath: string): Promise<boolean> {
    return existsFs(this.resolve(relativePath))
  }

  async listDir(relativePath: string): Promise<string[]> {
    try {
      const entries = await readdir(this.resolve(relativePath))
      return entries
    } catch {
      return []
    }
  }

  async ensureDir(relativePath: string): Promise<void> {
    await ensureDirFs(this.resolve(relativePath))
  }

  async exec(command: string[], opts?: { cwd?: string }): Promise<ExecResult> {
    const [cmd, ...args] = command
    const cwd = opts?.cwd
      ? join(this.sandboxPath, opts.cwd)
      : this.sandboxPath
    try {
      const result = await execa(cmd, args, { cwd, reject: false })
      return {
        stdout: result.stdout,
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
      }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; exitCode?: number }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.exitCode ?? 1,
      }
    }
  }

  watch(callback: (event: string, path: string) => void): { close(): Promise<void> } {
    const watcher = watch(this.sandboxPath, {
      ignoreInitial: true,
      depth: 5,
      persistent: true,
    })
    watcher.on('add', (p) => callback('add', p))
    watcher.on('change', (p) => callback('change', p))
    return { close: () => watcher.close() }
  }
}
