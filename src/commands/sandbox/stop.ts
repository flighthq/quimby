import { defineCommand } from 'citty'
import {
  resolveWorkspace,
  saveWorkspaceState,
} from '../../core/workspace.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

export default defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop a running sandbox',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Sandbox name',
      required: true,
    },
  },
  async run({ args }) {
    const { state, workspacePath } = await resolveWorkspace()
    const sandboxState = state.sandboxes[args.name]

    if (!sandboxState) {
      throw new AoError(`Sandbox "${args.name}" not found`)
    }

    if (sandboxState.status !== 'running' || !sandboxState.pid) {
      throw new AoError(`Sandbox "${args.name}" is not running`)
    }

    logger.start(`Stopping sandbox "${args.name}" (PID: ${sandboxState.pid})`)

    try {
      process.kill(sandboxState.pid, 'SIGTERM')
    } catch {
      logger.warn(`Process ${sandboxState.pid} not found — may have already exited`)
    }

    // Wait briefly for graceful shutdown, then force kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          process.kill(sandboxState.pid!, 'SIGKILL')
        } catch {
          // already gone
        }
        resolve()
      }, 10_000)

      const check = setInterval(() => {
        try {
          process.kill(sandboxState.pid!, 0)
        } catch {
          clearInterval(check)
          clearTimeout(timeout)
          resolve()
        }
      }, 500)
    })

    sandboxState.status = 'stopped'
    sandboxState.pid = undefined
    sandboxState.lastStoppedAt = new Date().toISOString()
    await saveWorkspaceState(workspacePath, state)

    logger.success(`Sandbox "${args.name}" stopped`)
  },
})
