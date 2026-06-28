import { defineCommand } from 'citty'
import { execa } from 'execa'

import { renderWorkerClaudeMd } from '../core/template'
import { getSSHTransport, syncToRemote } from '../core/transport'
import { resolveWorkspace, saveState } from '../core/workspace'
import { buildContext, getRuntime, runtimeTypes } from '../runtimes/index'
import { isSSH } from '../types/location'
import type { RuntimeType } from '../types/runtime'
import { QuimbyError } from '../utils/errors'
import { logger } from '../utils/logger'
import {
  remoteProjectRoot,
  remoteWorkerDir,
  remoteWorkerRepoDir,
  tmuxSessionName,
} from '../utils/paths'

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
  run,
})

async function run({ args }: { args: { name: string; agent?: string; runtime?: string } }) {
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
    await syncToRemote(repoRoot, rRoot, loc)

    // Lazy remote init: set up worker dirs and clone if this is the first run.
    const repoReady = await transport.fileExists(`${rRepoDir}/.git`)
    if (!repoReady) {
      logger.start('Initializing remote worker...')
      await transport.ensureDir(`${rWorkerDir}/inbox/packs`)
      await transport.ensureDir(`${rWorkerDir}/inbox/status`)
      await transport.exec(`git clone ${rRoot} ${rRepoDir}`)
      await transport.exec(`git tag quimby/seed`, { cwd: rRepoDir })
      const seedCommit = (await transport.exec(`git rev-parse HEAD`, { cwd: rRepoDir })).trim()
      await transport.writeFile(`${rWorkerDir}/assignment.md`, '')
      await transport.writeFile(`${rWorkerDir}/status.md`, 'idle')
      const claudeMd = renderWorkerClaudeMd({ workerName: args.name })
      await transport.writeFile(`${rWorkerDir}/CLAUDE.md`, claudeMd)

      state.workers[args.name].seedCommit = seedCommit
      await saveState(repoRoot, state)
      logger.success('Remote worker initialized')
    }

    const agentCmd = args.agent ?? worker.defaults?.agent ?? 'claude'
    const sessionName = tmuxSessionName(state.id, worker.id)
    const sshFlags = loc.port ? ['-p', String(loc.port)] : []

    logger.success(`Attaching to tmux session "${sessionName}" on ${loc.host}`)
    // CWD is rWorkerDir (parent of repo/) so the agent sees assignment.md, inbox/, etc.
    // tmux -A: attach to existing session or create a new one.
    const tmuxCmd = `tmux new-session -A -s ${sessionName} -c ${rWorkerDir} ${agentCmd}`
    await execa('ssh', ['-t', ...sshFlags, loc.host, tmuxCmd], { stdio: 'inherit' })
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
  const ctx = buildContext(repoRoot, args.name)
  const spec = await adapter.runSpec(ctx, agentCmd)

  const runtimeLabel = runtime !== 'local' ? ` [${runtime}]` : ''
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
