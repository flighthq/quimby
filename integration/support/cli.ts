import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execa } from 'execa'

/** Absolute path to the built CLI entry (`npm run build` produces this; `test:integration` builds first). */
export const CLI_PATH = fileURLToPath(new URL('../../apps/cli/dist/cli.js', import.meta.url))

export interface RunResult {
  stdout: string
  stderr: string
  /** stdout and stderr joined — the CLI narrates via consola on stderr, so most assertions want both. */
  output: string
  exitCode: number
}

/**
 * Invoke the real built `quimby` binary in `cwd` and capture its result without throwing on a
 * non-zero exit (integration tests assert on exit codes and output). Colors are disabled so
 * assertions match plain text.
 *
 * Output is captured via **shell redirection to temp files**, not pipes. The CLI ends commands
 * with `process.exit()`, which truncates buffered *pipe* writes (consola writes asynchronously);
 * redirecting to a regular file makes fd 1/2 synchronous so the exit can't drop output. The
 * redirection is done by the shell (`> "$OUT"`) rather than by passing execa a file fd, because
 * fd-passing through execa proved unreliable for some commands under the vitest worker — letting
 * the shell own the child's stdout/stderr sidesteps that entirely.
 */
export async function runQuimby(
  cwd: string,
  args: readonly string[],
  opts?: { env?: Record<string, string>; input?: string },
): Promise<RunResult> {
  const capture = await mkdtemp(join(tmpdir(), 'qb-out-'))
  const outPath = join(capture, 'stdout')
  const errPath = join(capture, 'stderr')
  try {
    // `$0` is the CLI path and `$@` the args, so nothing is re-parsed by the shell; `exec`
    // replaces the shell with node so the exit code propagates. Redirection targets come from
    // the env to avoid any quoting of the temp paths.
    const result = await execa(
      'sh',
      // NODE_ENV is forced to production inside the shell (not just via execa's env) because the
      // vitest worker's NODE_ENV=test otherwise reaches the child and silences the CLI's consola
      // `logger`, and execa's env override proved unreliable to land under the worker.
      [
        '-c',
        'exec env NODE_ENV=production node "$0" "$@" > "$QB_OUT" 2> "$QB_ERR"',
        CLI_PATH,
        ...args,
      ],
      {
        cwd,
        reject: false,
        input: opts?.input,
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          // The vitest worker sets NODE_ENV=test, which lowers consola's log level and silences
          // the CLI's `logger` (e.g. merge's success/quip lines). Override it so the child
          // narrates exactly as it would for a real user invocation.
          NODE_ENV: 'production',
          QB_OUT: outPath,
          QB_ERR: errPath,
          ...opts?.env,
        },
      },
    )
    const stdout = stripAnsi(await readFile(outPath, 'utf-8'))
    const stderr = stripAnsi(await readFile(errPath, 'utf-8'))
    return { stdout, stderr, output: `${stdout}\n${stderr}`, exitCode: result.exitCode ?? 0 }
  } finally {
    await rm(capture, { recursive: true, force: true })
  }
}

const ANSI = /\[[0-9;]*m/g

function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}
