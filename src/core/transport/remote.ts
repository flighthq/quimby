import { join } from 'pathe'
import { execa } from 'execa'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ensureDir as ensureDirFs } from '../../utils/fs.js'
import type { SandboxTransport, ExecResult } from './types.js'

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export class RemoteTransport implements SandboxTransport {
  constructor(
    public readonly sandboxPath: string,
    private readonly host: string,
    private readonly user: string,
    private readonly port: number = 22,
  ) {}

  private get remote(): string {
    return `${this.user}@${this.host}`
  }

  private get sshPortArgs(): string[] {
    return this.port !== 22 ? ['-p', String(this.port)] : []
  }

  private get rsyncSshFlag(): string[] {
    return this.port !== 22 ? ['-e', `ssh -p ${this.port}`] : []
  }

  private remotePath(relativePath: string): string {
    return join(this.sandboxPath, relativePath)
  }

  async pushFile(relativePath: string, content: string): Promise<void> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'ao-'))
    try {
      const tmpFile = join(tmpDir, 'content')
      await writeFile(tmpFile, content, 'utf-8')
      const remoteFull = this.remotePath(relativePath)
      const parentDir = remoteFull.split('/').slice(0, -1).join('/')
      await this.ssh(['mkdir', '-p', parentDir])
      await execa('rsync', [
        ...this.rsyncSshFlag,
        tmpFile,
        `${this.remote}:${remoteFull}`,
      ])
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  async pullFile(relativePath: string): Promise<string> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'ao-'))
    try {
      const tmpFile = join(tmpDir, 'content')
      await execa('rsync', [
        ...this.rsyncSshFlag,
        `${this.remote}:${this.remotePath(relativePath)}`,
        tmpFile,
      ])
      return await readFile(tmpFile, 'utf-8')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  async pushDir(localPath: string, relativePath: string): Promise<void> {
    const remoteFull = this.remotePath(relativePath)
    await this.ssh(['mkdir', '-p', remoteFull])
    const src = localPath.endsWith('/') ? localPath : `${localPath}/`
    await execa('rsync', [
      '-a', '--delete',
      ...this.rsyncSshFlag,
      src,
      `${this.remote}:${remoteFull}/`,
    ])
  }

  async pullDir(relativePath: string, localPath: string): Promise<void> {
    await ensureDirFs(localPath)
    const remoteFull = this.remotePath(relativePath)
    const dest = localPath.endsWith('/') ? localPath : `${localPath}/`
    await execa('rsync', [
      '-a',
      ...this.rsyncSshFlag,
      `${this.remote}:${remoteFull}/`,
      dest,
    ])
  }

  async exists(relativePath: string): Promise<boolean> {
    const result = await this.ssh(
      ['test', '-e', shellEscape(this.remotePath(relativePath))],
    )
    return result.exitCode === 0
  }

  async listDir(relativePath: string): Promise<string[]> {
    const result = await this.ssh(
      ['ls', '-1', shellEscape(this.remotePath(relativePath))],
    )
    if (result.exitCode !== 0) return []
    return result.stdout.split('\n').filter(Boolean)
  }

  async ensureDir(relativePath: string): Promise<void> {
    await this.ssh(['mkdir', '-p', shellEscape(this.remotePath(relativePath))])
  }

  async exec(command: string[], opts?: { cwd?: string }): Promise<ExecResult> {
    const cwd = opts?.cwd
      ? join(this.sandboxPath, opts.cwd)
      : this.sandboxPath
    const escaped = command.map(shellEscape).join(' ')
    const remoteCmd = `cd ${shellEscape(cwd)} && ${escaped}`
    return this.ssh(remoteCmd)
  }

  private async ssh(command: string | string[]): Promise<ExecResult> {
    const cmdStr = Array.isArray(command)
      ? command.join(' ')
      : command
    try {
      const result = await execa(
        'ssh',
        [...this.sshPortArgs, this.remote, cmdStr],
        { reject: false },
      )
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
}
