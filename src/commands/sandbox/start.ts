import { defineCommand } from 'citty'
import { execa } from 'execa'
import { join } from 'pathe'
import { createWriteStream } from 'node:fs'
import {
  resolveWorkspace,
  saveWorkspaceState,
} from '../../core/workspace.js'
import { loadConfig } from '../../core/config.js'
import { resolveAdapter } from '../../runtime/resolve.js'
import { getSandboxPath, getSandboxRepoPath } from '../../utils/paths.js'
import { AoError } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'
import type { LaunchContext } from '../../types/config.js'

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start a sandbox runtime',
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

    if (sandboxState.status === 'running') {
      throw new AoError(`Sandbox "${args.name}" is already running`)
    }

    const config = await loadConfig(state.sourceRepo)
    const sandboxConfig = config.sandboxes[args.name]

    if (!sandboxConfig) {
      throw new AoError(
        `Sandbox "${args.name}" not found in ao.config.ts. ` +
        `It was added dynamically — define a launch function in config to start it.`,
      )
    }

    const sandboxPath = getSandboxPath(workspacePath, args.name)
    const repoPath = getSandboxRepoPath(workspacePath, args.name)

    const ctx: LaunchContext = {
      sandbox: {
        name: args.name,
        path: sandboxPath,
        repoPath,
      },
      source: {
        repo: state.sourceRepo,
        ref: state.sourceRef,
        snapshot: state.snapshot,
      },
      workspace: {
        name: state.name,
        path: workspacePath,
      },
    }

    const configArgv = sandboxConfig.runtime.launch(ctx)
    const adapter = resolveAdapter(sandboxConfig.runtime.type)
    const spec = adapter.buildLaunchSpec(configArgv, sandboxPath)

    logger.start(
      `Starting sandbox "${args.name}" (${spec.command} ${spec.args.join(' ')})`,
    )

    const stdoutStream = spec.stdoutLog
      ? createWriteStream(spec.stdoutLog, { flags: 'a' })
      : 'ignore'
    const stderrStream = spec.stderrLog
      ? createWriteStream(spec.stderrLog, { flags: 'a' })
      : 'ignore'

    const child = execa(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: spec.detached ?? true,
      stdio: ['ignore', stdoutStream, stderrStream],
    })

    child.unref()

    sandboxState.status = 'running'
    sandboxState.pid = child.pid
    sandboxState.lastStartedAt = new Date().toISOString()
    await saveWorkspaceState(workspacePath, state)

    logger.success(`Sandbox "${args.name}" started (PID: ${child.pid})`)
  },
})
