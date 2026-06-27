import { defineCommand } from 'citty'
import { execa } from 'execa'
import { resolveWorkspace } from '../core/workspace.js'
import { getWorkerDir } from '../utils/paths.js'
import { QuimbyError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'run',
    description: 'Launch an agent interactively in a worker',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
    cmd: {
      type: 'string',
      alias: 'c',
      description: 'Command to run (default: claude)',
    },
  },
  async run({ args }) {
    const { state, repoRoot } = await resolveWorkspace()

    if (!state.workers[args.name]) {
      throw new QuimbyError(`Worker "${args.name}" not found`)
    }

    const workerDir = getWorkerDir(repoRoot, args.name)
    const command = args.cmd ?? 'claude'
    const parts = command.split(/\s+/)
    const [cmd, ...cmdArgs] = parts

    logger.start(`Running "${command}" in worker "${args.name}"`)

    try {
      await execa(cmd, cmdArgs, {
        cwd: workerDir,
        stdio: 'inherit',
      })
    } catch (err) {
      const e = err as { exitCode?: number }
      if (e.exitCode !== undefined && e.exitCode !== 0) {
        process.exit(e.exitCode)
      }
    }
  },
})
