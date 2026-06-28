import { execa } from 'execa'
import { dirname } from 'pathe'

import type { SSHLocation, WorkerLocation } from '../types/location'
import { isSSH } from '../types/location'
import { ensureDir, exists, readText, writeText } from '../utils/fs'

export interface Transport {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  /** Run a command and return stdout. Throws on non-zero exit. */
  exec(cmd: string, opts?: { cwd?: string }): Promise<string>
  /** Run a command attached to the terminal (for interactive agents). */
  runInteractive(cmd: string, args: string[], cwd?: string): Promise<void>
}

/** POSIX single-quote escaping — safe for any string content in SSH commands. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

class LocalTransport implements Transport {
  async readFile(path: string): Promise<string> {
    return readText(path)
  }

  async writeFile(path: string, content: string): Promise<void> {
    await ensureDir(dirname(path))
    await writeText(path, content)
  }

  async fileExists(path: string): Promise<boolean> {
    return exists(path)
  }

  async ensureDir(path: string): Promise<void> {
    await ensureDir(path)
  }

  async exec(cmd: string, opts?: { cwd?: string }): Promise<string> {
    const { stdout } = await execa('sh', ['-c', cmd], { cwd: opts?.cwd })
    return stdout
  }

  async runInteractive(cmd: string, args: string[], cwd?: string): Promise<void> {
    await execa(cmd, args, { stdio: 'inherit', cwd })
  }
}

class SSHTransport implements Transport {
  private readonly sshFlags: string[]
  private readonly scpFlags: string[]

  constructor(private readonly loc: SSHLocation) {
    this.sshFlags = loc.port ? ['-p', String(loc.port)] : []
    this.scpFlags = loc.port ? ['-P', String(loc.port)] : []
  }

  async readFile(path: string): Promise<string> {
    const { stdout } = await execa('ssh', [...this.sshFlags, this.loc.host, `cat ${path}`])
    return stdout
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Ensure parent dir exists, then pipe content via stdin to avoid escaping issues.
    const dir = dirname(path)
    await execa('ssh', [...this.sshFlags, this.loc.host, `mkdir -p ${dir} && cat > ${path}`], {
      input: content,
    })
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await execa('ssh', [...this.sshFlags, this.loc.host, `test -e ${path}`])
      return true
    } catch {
      return false
    }
  }

  async ensureDir(path: string): Promise<void> {
    await execa('ssh', [...this.sshFlags, this.loc.host, `mkdir -p ${path}`])
  }

  async exec(cmd: string, opts?: { cwd?: string }): Promise<string> {
    const remoteCmd = opts?.cwd ? `cd ${opts.cwd} && ${cmd}` : cmd
    const { stdout } = await execa('ssh', [...this.sshFlags, this.loc.host, remoteCmd], {
      maxBuffer: 256 * 1024 * 1024,
    })
    return stdout
  }

  async runInteractive(cmd: string, args: string[], cwd?: string): Promise<void> {
    const parts = [cmd, ...args].join(' ')
    const remoteCmd = cwd ? `cd ${cwd} && ${parts}` : parts
    await execa('ssh', ['-t', ...this.sshFlags, this.loc.host, remoteCmd], { stdio: 'inherit' })
  }

  /** Copy a file from local to remote using scp. */
  async scpTo(localPath: string, remotePath: string): Promise<void> {
    await execa('scp', [...this.scpFlags, localPath, `${this.loc.host}:${remotePath}`])
  }

  /** Copy a directory from remote to local using rsync. */
  async rsyncFrom(remotePath: string, localPath: string): Promise<void> {
    const portArgs = this.loc.port ? ['-e', `ssh -p ${this.loc.port}`] : []
    await execa('rsync', ['-a', ...portArgs, `${this.loc.host}:${remotePath}/`, `${localPath}/`], {
      stdio: 'inherit',
    })
  }

  /** Copy a local directory to a remote path using rsync. */
  async rsyncTo(localPath: string, remotePath: string): Promise<void> {
    const portArgs = this.loc.port ? ['-e', `ssh -p ${this.loc.port}`] : []
    await execa('rsync', ['-a', ...portArgs, `${localPath}/`, `${this.loc.host}:${remotePath}/`], {
      stdio: 'inherit',
    })
  }
}

export function getTransport(location: WorkerLocation | undefined): Transport {
  if (isSSH(location)) return new SSHTransport(location)
  return new LocalTransport()
}

export function getSSHTransport(location: SSHLocation): SSHTransport {
  return new SSHTransport(location)
}

/**
 * rsync the local project root to the remote workspace, excluding runtime
 * artifacts. The remote receives the full git object store so it can clone
 * locally without any external network access.
 */
export async function syncToRemote(
  localRoot: string,
  remoteProjectRoot: string,
  location: SSHLocation,
): Promise<void> {
  const sshFlags = location.port ? ['-p', String(location.port)] : []
  await execa('ssh', [...sshFlags, location.host, `mkdir -p ${remoteProjectRoot}`])

  const portArgs = location.port ? ['-e', `ssh -p ${location.port}`] : []
  await execa(
    'rsync',
    [
      '-av',
      '--delete',
      '--exclude=.quimby/',
      '--exclude=node_modules/',
      '--exclude=dist/',
      '--exclude=.git/hooks/',
      '--exclude=flight/',
      ...portArgs,
      `${localRoot}/`,
      `${location.host}:${remoteProjectRoot}/`,
    ],
    { stdio: 'inherit' },
  )
}
