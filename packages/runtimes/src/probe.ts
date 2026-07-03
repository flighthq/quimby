import { QuimbyError } from '@quimbyhq/errors'
import { execa } from 'execa'

/**
 * Fail fast with a clear error if a runtime's CLI isn't installed, so a launch dies here — before
 * any tmux/SSH work — instead of the agent's tmux pane vanishing when `exec` can't find the binary.
 * Only a missing binary (`ENOENT`) is treated as "not installed"; any other failure (an unsupported
 * `--version`, a non-zero exit) is taken as "present" so a quirky CLI isn't wrongly rejected.
 */
export async function requireRuntimeCli(cli: string, runtime: string): Promise<void> {
  try {
    await execa(cli, ['--version'])
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new QuimbyError(
        `The "${runtime}" runtime needs \`${cli}\`, which isn't on your PATH. Install it, or ` +
          `launch with \`-r local\`.`,
      )
    }
    // Present but `--version` misbehaved — assume installed rather than block the launch.
  }
}

/** Best-effort cleanup command: run it, swallowing any failure (a missing sandbox is fine). */
export async function bestEffortExec(cli: string, args: readonly string[]): Promise<void> {
  try {
    await execa(cli, args as string[])
  } catch {
    // Sandbox already gone, CLI missing, or unsupported verb — teardown is advisory, so ignore.
  }
}
