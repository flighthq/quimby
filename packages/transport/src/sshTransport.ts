import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type { SSHLocation } from '@quimbyhq/types'
import { execa } from 'execa'
import { dirname, join } from 'pathe'

import type { Transport } from './localTransport'

/** POSIX single-quote escaping — safe for any string content in SSH commands. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

/** Quote a remote shell path while preserving leading ~/ expansion on the remote host. */
export function sp(path: string): string {
  if (path === '~') return '~'
  if (path.startsWith('~/')) return `~/${path.slice(2).split('/').map(sq).join('/')}`
  return sq(path)
}

function rsyncRemoteSpec(host: string, remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '')
  const path =
    trimmed === '' || trimmed === '/'
      ? '/'
      : trimmed === '~'
        ? '.'
        : trimmed.startsWith('~/')
          ? trimmed.slice(2)
          : trimmed
  return `${host}:${path}/`
}

/**
 * Convert `git ls-files -z --others --ignored` output into an anchored,
 * NUL-separated rsync exclude list. Each path is prefixed with `/` so it
 * anchors to the rsync transfer root (the project root) rather than matching
 * a same-named file at any depth; directory entries keep their trailing slash,
 * which limits the rsync rule to a directory. Empty input yields an empty
 * string (no exclusions).
 */
export function toRsyncExcludeList(gitLsFilesZ: string): string {
  return gitLsFilesZ
    .split('\0')
    .filter(Boolean)
    .map((p) => `/${p}`)
    .join('\0')
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
    const { stdout } = await execa('ssh', [...this.sshFlags, this.loc.host, `cat ${sp(path)}`])
    return stdout
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Ensure parent dir exists, then pipe content via stdin to avoid escaping issues.
    const dir = dirname(path)
    await execa(
      'ssh',
      [...this.sshFlags, this.loc.host, `mkdir -p ${sp(dir)} && cat > ${sp(path)}`],
      {
        input: content,
      },
    )
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await execa('ssh', [...this.sshFlags, this.loc.host, `test -e ${sp(path)}`])
      return true
    } catch {
      return false
    }
  }

  async ensureDir(path: string): Promise<void> {
    await execa('ssh', [...this.sshFlags, this.loc.host, `mkdir -p ${sp(path)}`])
  }

  async exec(cmd: string, opts?: { cwd?: string }): Promise<string> {
    const remoteCmd = opts?.cwd ? `cd ${sp(opts.cwd)} && ${cmd}` : cmd
    const { stdout } = await execa('ssh', [...this.sshFlags, this.loc.host, remoteCmd], {
      maxBuffer: 256 * 1024 * 1024,
      stripFinalNewline: false,
    })
    return stdout
  }

  async runInteractive(cmd: string, args: string[], cwd?: string): Promise<void> {
    const parts = [cmd, ...args].join(' ')
    const remoteCmd = cwd ? `cd ${sp(cwd)} && ${parts}` : parts
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
    await execa('scp', [...this.scpFlags, localPath, `${this.loc.host}:${sp(remotePath)}`])
  }

  /** Copy a directory from remote to local using rsync. */
  async rsyncFrom(remotePath: string, localPath: string): Promise<void> {
    await execa(
      'rsync',
      [
        '-a',
        '--protect-args',
        '-e',
        this.sshRsyncCmd,
        rsyncRemoteSpec(this.loc.host, remotePath),
        `${localPath}/`,
      ],
      {
        stdio: 'inherit',
      },
    )
  }

  /** Copy a local directory to a remote path using rsync. */
  async rsyncTo(localPath: string, remotePath: string): Promise<void> {
    await execa(
      'rsync',
      [
        '-a',
        '--protect-args',
        '-e',
        this.sshRsyncCmd,
        `${localPath}/`,
        rsyncRemoteSpec(this.loc.host, remotePath),
      ],
      {
        stdio: 'inherit',
      },
    )
  }

  /**
   * Rsync the local project root to the remote workspace, excluding runtime
   * artifacts and everything git ignores. The remote reconstructs tracked
   * source by cloning the rsynced `.git`, so git-ignored build output (compiled
   * binaries, caches) is never needed there — shipping it wastes bandwidth and
   * disk on every sync. We derive the exclude set from git itself
   * (`git ls-files --others --ignored --exclude-standard`) rather than a fixed
   * denylist, so nested `.gitignore`, `.git/info/exclude`, and the global
   * gitignore are all honored exactly as git sees them. The explicit excludes
   * below remain as a fast path and cover `.git/hooks/` (git never lists its
   * own dir) and `flight/` (a sibling repo that may not be ignored).
   */
  async syncProjectTo(localRoot: string, remotePath: string): Promise<void> {
    await execa('ssh', [...this.sshFlags, this.loc.host, `mkdir -p ${sp(remotePath)}`])
    const excludeFile = await this.writeGitignoreExcludeFile(localRoot)
    try {
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
          ...(excludeFile ? [`--exclude-from=${excludeFile}`, '--from0'] : []),
          '--protect-args',
          '-e',
          this.sshRsyncCmd,
          `${localRoot}/`,
          rsyncRemoteSpec(this.loc.host, remotePath),
        ],
        { stdio: 'inherit' },
      )
    } finally {
      if (excludeFile) await rm(dirname(excludeFile), { recursive: true, force: true })
    }
  }

  /**
   * Write git's ignored-file list to a temp file for rsync's `--exclude-from`,
   * returning its path (or null when nothing is ignored or git is unavailable —
   * the sync then falls back to just the explicit excludes). `--directory`
   * collapses a wholly-ignored directory to a single entry instead of listing
   * every file inside it; `-z` keeps paths with spaces or newlines intact.
   */
  private async writeGitignoreExcludeFile(localRoot: string): Promise<string | null> {
    let list: string
    try {
      const { stdout } = await execa(
        'git',
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        { cwd: localRoot, stripFinalNewline: false },
      )
      list = toRsyncExcludeList(stdout)
    } catch {
      return null
    }
    if (!list) return null
    const dir = await mkdtemp(join(tmpdir(), 'qb-rsync-'))
    const file = join(dir, 'exclude')
    await writeFile(file, list)
    return file
  }
}

export function getSSHTransport(location: SSHLocation): SSHTransport {
  return new SSHTransport(location)
}
