import { QuimbyError } from '@quimbyhq/errors'
import {
  remoteProjectRoot,
  remoteWorkerDir,
  remoteWorkerRepoDir,
  tmuxSessionName,
} from '@quimbyhq/paths'
import { buildContext, getRuntime, runtimeTypes } from '@quimbyhq/runtimes'
import { renderWorkerClaudeMd } from '@quimbyhq/template'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { RuntimeType } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { configureRemoteWorkerIdentity } from '@quimbyhq/worker'
import { resolveWorkspace, saveState } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

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
    agent: {
      type: 'string',
      alias: 'a',
      description: 'Agent override for this run',
    },
    runtime: {
      type: 'string',
      alias: 'r',
      description: `Runtime override for this run (${runtimeTypes.join(', ')})`,
    },
  },
  run: runRunCommand,
})

export async function runRunCommand({
  args,
}: {
  args: { name: string; agent?: string; runtime?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.name]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  // ── SSH worker ──────────────────────────────────────────────────────────────
  if (isSSH(worker.location)) {
    const loc = worker.location
    const transport = getSSHTransport(loc)
    const rRoot = remoteProjectRoot(state.id, loc.base)
    const rWorkerDir = remoteWorkerDir(state.id, args.name, loc.base)
    const rRepoDir = remoteWorkerRepoDir(state.id, args.name, loc.base)

    logger.start(`Syncing project to ${loc.host}...`)
    await transport.syncProjectTo(repoRoot, rRoot)

    // Lazy remote init: set up worker dirs and clone if this is the first run.
    const repoReady = await transport.fileExists(`${rRepoDir}/.git`)
    if (!repoReady) {
      await transport.checkCapabilities(['git', 'rsync', 'tmux'])
      logger.start('Initializing remote worker...')
      await transport.ensureDir(`${rWorkerDir}/inbox/packs`)
      await transport.ensureDir(`${rWorkerDir}/inbox/status`)
      await transport.exec(`git clone ${rRoot} ${rRepoDir}`)
      await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
      await configureRemoteWorkerIdentity(transport, rRepoDir, args.name)
      const seedCommit = (await transport.exec(`git rev-parse HEAD`, { cwd: rRepoDir })).trim()
      await transport.writeFile(`${rWorkerDir}/assignment.md`, '')
      await transport.writeFile(`${rWorkerDir}/status.md`, 'idle')
      const claudeMd = renderWorkerClaudeMd({ workerName: args.name })
      await transport.writeFile(`${rWorkerDir}/CLAUDE.md`, claudeMd)

      state.workers[args.name].seedCommit = seedCommit
      await saveState(repoRoot, state)
      logger.success('Remote worker initialized')
    }

    const runtime =
      (args.runtime as RuntimeType | undefined) ??
      (worker.defaults?.runtime as RuntimeType | undefined) ??
      'local'
    const agentCmd = args.agent ?? worker.defaults?.agent ?? 'claude'

    if (!runtimeTypes.includes(runtime)) {
      throw new QuimbyError(`Unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`)
    }

    // Build the shell command for the remote machine using the runtime adapter.
    // For sbx: 'sbx run claude', for openshell: 'openshell sandbox create -- claude', etc.
    // cwd is handled by tmux -c, so we pass remote paths but don't use spec.cwd.
    const adapter = getRuntime(runtime)
    const spec = await adapter.runSpec(
      {
        projectId: state.id,
        workerId: worker.id,
        workerName: args.name,
        workerDir: rWorkerDir,
        repoDir: rRepoDir,
        repoRoot: rRoot,
      },
      agentCmd,
    )
    // Quote the user-supplied agentCmd wherever it appears in the args; leave
    // the runtime's own static tokens (e.g. 'run', 'sandbox') unquoted.
    const remoteCmd = [spec.command, ...spec.args.map((a) => (a === agentCmd ? sq(a) : a))].join(
      ' ',
    )

    const sessionName = tmuxSessionName(state.id, worker.id)
    const runtimeLabel = runtime !== 'local' ? ` [${runtime}]` : ''
    logger.success(`Attaching to tmux session "${sessionName}" on ${loc.host}${runtimeLabel}`)
    // CWD is rWorkerDir (parent of repo/) so the agent sees assignment.md, inbox/, etc.
    // tmux -A: attach to existing session or create a new one.
    // bash -l: login shell so PATH includes user-installed tools like claude / sbx.
    await transport.runInteractive('tmux', [
      'new-session',
      '-A',
      '-s',
      sessionName,
      '-c',
      rWorkerDir, // unquoted so the remote shell expands ~
      'bash',
      '-l',
      '-c',
      sq(remoteCmd),
    ])
    return
  }

  // ── Local worker ────────────────────────────────────────────────────────────
  const saved = worker.defaults
  const runtime =
    (args.runtime as RuntimeType | undefined) ?? (saved?.runtime as RuntimeType) ?? 'local'
  const agentCmd = args.agent ?? saved?.agent ?? 'claude'

  if (!runtimeTypes.includes(runtime)) {
    throw new QuimbyError(`Unknown runtime "${runtime}". Available: ${runtimeTypes.join(', ')}`)
  }

  const adapter = getRuntime(runtime)
  const ctx = buildContext(repoRoot, args.name, state.id, worker.id)
  const spec = await adapter.runSpec(ctx, agentCmd)

  const runtimeLabel = runtime !== 'local' ? ` [${runtime}]` : ''

  // Opt-in tmux for local workers: run the agent inside a named, reattachable
  // session (the persistence SSH workers always get). `-A` attaches to an
  // existing session or creates one; `-e` carries any runtime env into it.
  if (worker.tmux) {
    const sessionName = tmuxSessionName(state.id, worker.id)
    const envArgs = Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ])
    logger.success(`Attaching to tmux session "${sessionName}"${runtimeLabel}`)
    try {
      await execa(
        'tmux',
        [
          'new-session',
          '-A',
          '-s',
          sessionName,
          '-c',
          spec.cwd ?? repoRoot,
          ...envArgs,
          spec.command,
          ...spec.args,
        ],
        { stdio: 'inherit' },
      )
    } catch (err) {
      const e = err as { exitCode?: number }
      if (e.exitCode !== undefined && e.exitCode !== 0) {
        process.exit(e.exitCode)
      }
    }
    return
  }

  logger.start(`Running "${agentCmd}" in worker "${args.name}"${runtimeLabel}`)

  try {
    await execa(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit' })
  } catch (err) {
    const e = err as { exitCode?: number }
    if (e.exitCode !== undefined && e.exitCode !== 0) {
      process.exit(e.exitCode)
    }
  }
}
