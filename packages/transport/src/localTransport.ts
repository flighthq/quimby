import { ensureDir, exists, readText, writeText } from '@quimbyhq/utils'
import { execa } from 'execa'
import { dirname } from 'pathe'

export interface Transport {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  /** Run a command and return stdout. Throws on non-zero exit. */
  /** `input` is piped to the command's stdin — the way to move a payload without putting it on
   * the command line, where it would end up in process listings and in execa's error messages. */
  exec(cmd: string, opts?: { cwd?: string; input?: string }): Promise<string>
  /** Run a command attached to the terminal (for interactive agents). */
  runInteractive(cmd: string, args: string[], cwd?: string): Promise<void>
}

export class LocalTransport implements Transport {
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

  async exec(cmd: string, opts?: { cwd?: string; input?: string }): Promise<string> {
    const { stdout } = await execa('sh', ['-c', cmd], {
      cwd: opts?.cwd,
      stripFinalNewline: false,
      ...(opts?.input === undefined ? {} : { input: opts.input }),
    })
    return stdout
  }

  async runInteractive(cmd: string, args: string[], cwd?: string): Promise<void> {
    await execa(cmd, args, { stdio: 'inherit', cwd })
  }
}
