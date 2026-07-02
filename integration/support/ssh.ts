import { execa } from 'execa'

/**
 * Whether a passwordless SSH connection to `localhost` succeeds — the gate for Suite C. Dev
 * machines vary (many have no sshd), so the SSH suite self-skips when this is false rather than
 * failing the run; CI provisions sshd so it runs there.
 */
export async function isSshLoopbackAvailable(): Promise<boolean> {
  try {
    await execa('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'localhost', 'true'])
    return true
  } catch {
    return false
  }
}

/** The `user@localhost` spec Suite C hands to `quimby add --host`. */
export function sshLoopbackHost(): string {
  const user = process.env.USER || process.env.LOGNAME || 'root'
  return `${user}@localhost`
}

/** Run a command on the SSH host and return trimmed stdout (throws on non-zero exit). */
export async function sshExec(host: string, cmd: string): Promise<string> {
  const { stdout } = await execa('ssh', ['-o', 'BatchMode=yes', host, cmd])
  return stdout.trim()
}

/** Whether a remote `test` predicate (e.g. `test -d ~/foo/.git`) succeeds. */
export async function sshPathExists(host: string, remotePath: string): Promise<boolean> {
  try {
    await execa('ssh', ['-o', 'BatchMode=yes', host, `test -e ${remotePath}`])
    return true
  } catch {
    return false
  }
}
