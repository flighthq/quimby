import type { SSHLocation } from '@quimbyhq/types'
import { exists } from '@quimbyhq/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getSSHTransport, sp, sq, SSHTransport, toRsyncExcludeList } from './sshTransport'

const execa = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa }))

// A port pins the -p/-P flag and a ControlPath suffix; using one throughout lets each
// test assert the exact flag vector the wire format depends on.
const LOC: SSHLocation = { type: 'ssh', host: 'user@box', port: 2222 }
const CONTROL_PATH = 'ControlPath=/tmp/qb_user@box_2222'

/** The ssh/scp calls made to a given binary, in order. */
function callsTo(bin: string): unknown[][] {
  return execa.mock.calls.filter((c) => c[0] === bin)
}

beforeEach(() => {
  execa.mockReset()
  execa.mockResolvedValue({ stdout: '' })
})

describe('getSSHTransport', () => {
  it('returns an SSHTransport for a given SSH location', () => {
    const transport = getSSHTransport({ type: 'ssh', host: 'user@box' })
    expect(transport).toBeDefined()
    expect(typeof transport.readFile).toBe('function')
    expect(typeof transport.exec).toBe('function')
  })

  it('throws on an unresolved alias-only location (no host)', () => {
    expect(() => getSSHTransport({ type: 'ssh', alias: 'remote' })).toThrow(/unresolved/)
  })
})

describe('sp', () => {
  it('quotes absolute paths', () => {
    expect(sp('/remote dir/f.txt')).toBe("'/remote dir/f.txt'")
  })

  it('preserves leading tilde expansion while quoting the rest as one legible unit', () => {
    expect(sp('~/work spaces/proj')).toBe("~/'work spaces/proj'")
  })
})

describe('sq', () => {
  it('wraps a simple string in single quotes', () => {
    expect(sq('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(sq("it's here")).toBe("'it'\"'\"'s here'")
  })

  it('handles empty string', () => {
    expect(sq('')).toBe("''")
  })

  it('handles strings with spaces', () => {
    expect(sq('hello world')).toBe("'hello world'")
  })
})

describe('SSHTransport', () => {
  it('readFile ssh-cats the path through the ControlMaster flags', async () => {
    execa.mockResolvedValueOnce({ stdout: 'file body' })
    const out = await new SSHTransport(LOC).readFile('/remote/f.txt')
    expect(out).toBe('file body')
    const [, args] = callsTo('ssh')[0] as [string, string[]]
    expect(args).toEqual(
      expect.arrayContaining([
        '-o',
        'ControlMaster=auto',
        '-o',
        CONTROL_PATH,
        '-o',
        'ControlPersist=60s',
        '-o',
        'ConnectTimeout=5',
      ]),
    )
    // The remote command and host are the final two positionals.
    expect(args[args.length - 1]).toBe("cat '/remote/f.txt'")
    expect(args[args.length - 2]).toBe('user@box')
  })

  it('writeFile ensures the parent dir and pipes content via stdin', async () => {
    await new SSHTransport(LOC).writeFile('/remote/dir/f.txt', 'hello')
    const [, args, opts] = callsTo('ssh')[0] as [string, string[], { input?: string }]
    expect(args[args.length - 1]).toBe("mkdir -p '/remote/dir' && cat > '/remote/dir/f.txt'")
    expect(opts).toEqual(expect.objectContaining({ input: 'hello' }))
  })

  it('fileExists returns true when the remote test succeeds', async () => {
    expect(await new SSHTransport(LOC).fileExists('/remote/f')).toBe(true)
    const [, args] = callsTo('ssh')[0] as [string, string[]]
    expect(args[args.length - 1]).toBe("test -e '/remote/f'")
  })

  it('fileExists returns false when the remote test fails', async () => {
    execa.mockRejectedValueOnce(new Error('exit 1'))
    expect(await new SSHTransport(LOC).fileExists('/remote/nope')).toBe(false)
  })

  it('ensureDir mkdir -p the remote path', async () => {
    await new SSHTransport(LOC).ensureDir('/remote/deep/dir')
    const [, args] = callsTo('ssh')[0] as [string, string[]]
    expect(args[args.length - 1]).toBe("mkdir -p '/remote/deep/dir'")
  })

  it('exec prefixes cwd and passes the large maxBuffer without stripping newlines', async () => {
    execa.mockResolvedValueOnce({ stdout: 'result\n' })
    const out = await new SSHTransport(LOC).exec('ls -la', { cwd: '/work' })
    expect(out).toBe('result\n')
    const [, args, opts] = callsTo('ssh')[0] as [string, string[], object]
    expect(args[args.length - 1]).toBe("cd '/work' && ls -la")
    expect(opts).toEqual(
      expect.objectContaining({
        maxBuffer: 256 * 1024 * 1024,
        stripFinalNewline: false,
        all: true,
      }),
    )
  })

  it('exec surfaces the failed remote command output instead of the generic exec message', async () => {
    // git often writes its real complaint to stdout, captured by execa as `all` when all:true.
    execa.mockRejectedValueOnce(
      Object.assign(new Error('Command failed with exit code 1'), {
        shortMessage: 'Command failed with exit code 1: ssh ... git stash',
        all: 'No local changes to save',
        exitCode: 1,
      }),
    )
    await expect(new SSHTransport(LOC).exec('git stash', { cwd: '/work' })).rejects.toThrow(
      'SSH command failed for user@box: No local changes to save',
    )
  })

  it('exec runs the raw command when no cwd is given', async () => {
    await new SSHTransport(LOC).exec('whoami')
    const [, args] = callsTo('ssh')[0] as [string, string[]]
    expect(args[args.length - 1]).toBe('whoami')
  })

  it('exec reports a missing local SSH client clearly', async () => {
    execa.mockRejectedValueOnce(Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }))

    await expect(new SSHTransport(LOC).exec('whoami')).rejects.toThrow(
      'SSH client not found locally',
    )
  })

  it('readFile reports SSH reachability failures with the host name', async () => {
    execa.mockRejectedValueOnce(
      Object.assign(new Error('connect timed out'), { stderr: 'ssh: connect timed out' }),
    )

    await expect(new SSHTransport(LOC).readFile('/remote/f')).rejects.toThrow(
      'Could not reach SSH host user@box',
    )
  })

  it('scpTo uses the -P (uppercase) port flag and host:path target', async () => {
    await new SSHTransport(LOC).scpTo('/local/f', '/remote/f')
    const [bin, args] = callsTo('scp')[0] as [string, string[]]
    expect(bin).toBe('scp')
    expect(args).toContain('-P')
    expect(args).not.toContain('-p')
    expect(args).toEqual(expect.arrayContaining(['-P', '2222', CONTROL_PATH]))
    expect(args[args.length - 1]).toBe("user@box:'/remote/f'")
    expect(args[args.length - 2]).toBe('/local/f')
  })

  it('exec uses the -p (lowercase) port flag — distinct from scp', async () => {
    await new SSHTransport(LOC).exec('whoami')
    const [, args] = callsTo('ssh')[0] as [string, string[]]
    expect(args).toContain('-p')
    expect(args).toContain('2222')
    expect(args).not.toContain('-P')
  })

  it('rsyncFrom pulls remote→local with trailing-slash paths and -e ssh', async () => {
    await new SSHTransport(LOC).rsyncFrom('/remote/src', '/local/dst')
    const [bin, args] = callsTo('rsync')[0] as [string, string[]]
    expect(bin).toBe('rsync')
    expect(args).toContain('--protect-args')
    const eIdx = args.indexOf('-e')
    expect(eIdx).toBeGreaterThanOrEqual(0)
    // The -e value is a single shell string carrying the ControlPath and port.
    expect(args[eIdx + 1]).toContain('ssh ')
    expect(args[eIdx + 1]).toContain('/tmp/qb_user@box_2222')
    expect(args[eIdx + 1]).toContain('-p 2222')
    expect(args).toEqual(expect.arrayContaining(['user@box:/remote/src/', '/local/dst/']))
  })

  it('rsyncFrom does not shell-quote absolute remote source paths', async () => {
    await new SSHTransport(LOC).rsyncFrom('/tmp/quimby-handoff-abc', '/local/dst')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args).toEqual(expect.arrayContaining(['user@box:/tmp/quimby-handoff-abc/']))
    expect(args).not.toEqual(expect.arrayContaining(["user@box:'/tmp/quimby-handoff-abc'/"]))
  })

  it('rsyncFrom preserves remote paths with spaces through protected args', async () => {
    await new SSHTransport(LOC).rsyncFrom('/remote src', '/local/dst')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args).toContain('--protect-args')
    expect(args).toEqual(expect.arrayContaining(['user@box:/remote src/']))
  })

  it('rsyncFrom maps tilde paths to home-relative protected args', async () => {
    await new SSHTransport(LOC).rsyncFrom('~/.quimby/workspaces/proj', '/local/dst')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args).toContain('--protect-args')
    expect(args).toEqual(expect.arrayContaining(['user@box:.quimby/workspaces/proj/']))
  })

  it('rsyncTo pushes local→remote with trailing-slash paths', async () => {
    await new SSHTransport(LOC).rsyncTo('/local/src', '/remote/dst')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args).toContain('--protect-args')
    expect(args).toEqual(expect.arrayContaining(['/local/src/', 'user@box:/remote/dst/']))
  })

  it('rsyncTo maps tilde destinations to home-relative protected args', async () => {
    await new SSHTransport(LOC).rsyncTo('/local/src', '~/.quimby/workspaces/proj')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args).toContain('--protect-args')
    expect(args).toEqual(
      expect.arrayContaining(['/local/src/', 'user@box:.quimby/workspaces/proj/']),
    )
  })

  it('rsyncFrom reports a missing local rsync clearly', async () => {
    execa.mockRejectedValueOnce(Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' }))

    await expect(new SSHTransport(LOC).rsyncFrom('/remote/src', '/local/dst')).rejects.toThrow(
      'rsync not found locally',
    )
  })

  it('checkCapabilities probes each tool and throws when any are missing', async () => {
    execa.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[args.length - 1] === 'command -v rsync') throw new Error('not found')
      return { stdout: '' }
    })
    await expect(new SSHTransport(LOC).checkCapabilities(['git', 'rsync'])).rejects.toThrow(
      /missing required tools: rsync/,
    )
    const probes = callsTo('ssh').map((c) => (c[1] as string[])[(c[1] as string[]).length - 1])
    expect(probes).toContain('command -v git')
    expect(probes).toContain('command -v rsync')
  })

  it('checkCapabilities resolves when every tool is present', async () => {
    await expect(new SSHTransport(LOC).checkCapabilities(['git'])).resolves.toBeUndefined()
  })

  it('checkCapabilities reports a missing local SSH client instead of remote tools', async () => {
    execa.mockRejectedValueOnce(Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }))

    await expect(new SSHTransport(LOC).checkCapabilities(['git'])).rejects.toThrow(
      'SSH client not found locally',
    )
  })

  it('checkCapabilities reports unreachable SSH hosts instead of remote tools', async () => {
    execa.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { stderr: 'Permission denied (publickey).' }),
    )

    await expect(new SSHTransport(LOC).checkCapabilities(['git'])).rejects.toThrow(
      'Could not reach SSH host user@box',
    )
  })

  it('syncProjectTo wires the exclude plumbing and cleans up its temp file', async () => {
    // git lists an ignored dir, so an --exclude-from temp file is threaded into rsync.
    execa.mockImplementation(async (bin: string) => {
      if (bin === 'git') return { stdout: 'node_modules/\0dist/\0' }
      return { stdout: '' }
    })
    await new SSHTransport(LOC).syncProjectTo('/local/root', '/remote/root')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args).toEqual(
      expect.arrayContaining([
        '-av',
        '--delete',
        // No trailing slash: the local `.quimby` is a symlink to durable storage,
        // and a dir-only rule would ship it and clobber the remote `.quimby/` tree.
        '--exclude=.quimby',
        '--exclude=node_modules/',
        '--exclude=dist/',
        '--exclude=.git/hooks/',
        '--exclude=flight/',
        '--from0',
      ]),
    )
    const excludeArg = args.find((a) => a.startsWith('--exclude-from='))
    expect(excludeArg).toBeDefined()
    // `--from0` must precede `--exclude-from`, or rsync reads the NUL-separated
    // file as one newline-delimited (over-long, discarded) rule and excludes nothing.
    expect(args.indexOf('--from0')).toBeLessThan(args.indexOf(excludeArg!))
    expect(args).toContain('--protect-args')
    expect(args[args.length - 1]).toBe('user@box:/remote/root/')
    // The temp exclude file is removed in the finally block.
    const excludeFile = excludeArg!.slice('--exclude-from='.length)
    expect(await exists(excludeFile)).toBe(false)
    // The remote target dir is created before the rsync.
    const mkdir = callsTo('ssh').map((c) => (c[1] as string[])[(c[1] as string[]).length - 1])
    expect(mkdir).toContain("mkdir -p '/remote/root'")
  })

  it('syncProjectTo omits the exclude-from plumbing when git is unavailable', async () => {
    execa.mockImplementation(async (bin: string) => {
      if (bin === 'git') throw new Error('git not found')
      return { stdout: '' }
    })
    await new SSHTransport(LOC).syncProjectTo('/local/root', '/remote/root')
    const [, args] = callsTo('rsync')[0] as [string, string[]]
    expect(args.some((a) => a.startsWith('--exclude-from='))).toBe(false)
    expect(args).not.toContain('--from0')
    // The explicit excludes still apply as the fallback.
    expect(args).toContain('--exclude=node_modules/')
  })
})

describe('toRsyncExcludeList', () => {
  it('returns an empty string for empty input', () => {
    expect(toRsyncExcludeList('')).toBe('')
  })

  it('anchors a single ignored file to the transfer root', () => {
    expect(toRsyncExcludeList('build/app\0')).toBe('/build/app')
  })

  it('preserves a directory entry trailing slash', () => {
    expect(toRsyncExcludeList('build/\0')).toBe('/build/')
  })

  it('anchors each path and rejoins them NUL-separated', () => {
    expect(toRsyncExcludeList('target/\0bin/tool\0a.o\0')).toBe('/target/\0/bin/tool\0/a.o')
  })

  it('ignores empty entries from a trailing or doubled NUL', () => {
    expect(toRsyncExcludeList('x.o\0\0y.o\0')).toBe('/x.o\0/y.o')
  })

  it('keeps paths with spaces intact', () => {
    expect(toRsyncExcludeList('build output/big.bin\0')).toBe('/build output/big.bin')
  })
})
