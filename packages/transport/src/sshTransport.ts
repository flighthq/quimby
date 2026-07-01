import type { SSHLocation } from '@quimbyhq/types'
import { execa } from 'execa'
import { dirname } from 'pathe'

import type { Transport } from './localTransport'

/** POSIX single-quote escaping — safe for any string content in SSH commands. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

export class SSHTransport implements Transport {
  private readonly sshFlags: string[]
  private readonly scpFlags: string[]
  private readonly sshRsyncCmd: string

  constructor(private readonly loc: SSHLocation) {
    // Derive a short socket path from the host spec. Used by ControlMaster to
    // multiplex all SSH connections for this agent through a single TCP session
    // — the user only authenticates once per 60-second window.
    const safeHost = loc.host.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 50)
    const portSuffix = loc.port ? `_${loc.port}` : ''
    const controlPath = `/tmp/qb_${safeHost}${portSuffix}`

    const ctrlFlags = [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      'ControlPersist=60s',
      '-o',
      'ConnectTimeout=5',
    ]
    this.sshFlags = [...ctrlFlags, ...(loc.port ? ['-p', String(loc.port)] : [])]
    this.scpFlags = [...ctrlFlags, ...(loc.port ? ['-P', String(loc.port)] : [])]
    // Shell string passed to rsync -e. ControlPath has no special chars, so no quoting needed.
    this.sshRsyncCmd = ['ssh', ...ctrlFlags, ...(loc.port ? ['-p', String(loc.port)] : [])].join(
      ' ',
    )
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
      stripFinalNewline: false,
    })
    return stdout
  }

  async runInteractive(cmd: string, args: string[], cwd?: string): Promise<void> {
    const parts = [cmd, ...args].join(' ')
    const remoteCmd = cwd ? `cd ${cwd} && ${parts}` : parts
    await execa('ssh', ['-t', ...this.sshFlags, this.loc.host, remoteCmd], { stdio: 'inherit' })
  }

  async checkCapabilities(required: string[]): Promise<void> {
    const missing: string[] = []
    for (const cmd of required) {
      try {
        await execa('ssh', [...this.sshFlags, this.loc.host, `command -v ${cmd}`])
      } catch {
        missing.push(cmd)
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Remote host ${this.loc.host} is missing required tools: ${missing.join(', ')}. Install them before running an SSH agent.`,
      )
    }
  }

  /** Copy a file from local to remote using scp. */
  async scpTo(localPath: string, remotePath: string): Promise<void> {
    await execa('scp', [...this.scpFlags, localPath, `${this.loc.host}:${remotePath}`])
  }

  /** Copy a directory from remote to local using rsync. */
  async rsyncFrom(remotePath: string, localPath: string): Promise<void> {
    await execa(
      'rsync',
      ['-a', '-e', this.sshRsyncCmd, `${this.loc.host}:${remotePath}/`, `${localPath}/`],
      {
        stdio: 'inherit',
      },
    )
  }

  /** Copy a local directory to a remote path using rsync. */
  async rsyncTo(localPath: string, remotePath: string): Promise<void> {
    await execa(
      'rsync',
      ['-a', '-e', this.sshRsyncCmd, `${localPath}/`, `${this.loc.host}:${remotePath}/`],
      {
        stdio: 'inherit',
      },
    )
  }

  /**
   * Rsync the local project root to the remote workspace, excluding runtime
   * artifacts. The remote receives the full git object store so it can clone
   * locally without any external network access.
   */
  async syncProjectTo(localRoot: string, remotePath: string): Promise<void> {
    await execa('ssh', [...this.sshFlags, this.loc.host, `mkdir -p ${remotePath}`])
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
        '-e',
        this.sshRsyncCmd,
        `${localRoot}/`,
        `${this.loc.host}:${remotePath}/`,
      ],
      { stdio: 'inherit' },
    )
  }
}

export function getSSHTransport(location: SSHLocation): SSHTransport {
  return new SSHTransport(location)
}
