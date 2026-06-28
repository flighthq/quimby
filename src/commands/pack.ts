import { defineCommand } from 'citty'
import { execa } from 'execa'

import { createPack, createRemotePack } from '../core/pack'
import { getSSHTransport, sq } from '../core/transport'
import { resolveWorkspace } from '../core/workspace'
import { isSSH } from '../types/location'
import { QuimbyError } from '../utils/errors'
import * as git from '../utils/git'
import { logger } from '../utils/logger'
import { getWorkerRepoDir, remoteWorkerRepoDir } from '../utils/paths'

export default defineCommand({
  meta: {
    name: 'pack',
    description: "Package a worker's work into a pack",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Pack name (auto-generated if omitted)',
    },
    description: {
      type: 'string',
      alias: 'd',
      description: 'Pack description (inferred from commits if omitted)',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Commit message for uncommitted work + suggested apply message',
    },
    'skip-check': {
      type: 'boolean',
      description: "Skip the worker's configured verification command",
      default: false,
    },
  },
  run,
})

async function run({
  args,
}: {
  args: {
    worker: string
    name?: string
    description?: string
    message?: string
    'skip-check': boolean
  }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.worker]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.worker}" not found`)
  }

  const commitMessage = args.message ?? args.description ?? `Work by ${args.worker}`

  if (isSSH(worker.location)) {
    const transport = getSSHTransport(worker.location)
    const rRepoDir = remoteWorkerRepoDir(state.id, args.worker, worker.location.base)

    const dirty = (await transport.exec(`git status --porcelain`, { cwd: rRepoDir })).trim()
    if (dirty) {
      await transport.exec(`git add -A && git commit -m ${sq(commitMessage)}`, { cwd: rRepoDir })
      logger.info(`Committed working tree on "${args.worker}": "${commitMessage}"`)
    }

    if (worker.check && !args['skip-check']) {
      logger.start(`Running check on "${args.worker}": ${worker.check}`)
      try {
        await transport.runInteractive('bash', ['-lc', sq(worker.check)], rRepoDir)
      } catch {
        throw new QuimbyError(
          `Check failed for "${args.worker}" — fix it in the worker and re-pack (or pass --skip-check)`,
        )
      }
      logger.success('Check passed')
    }

    const meta = await createRemotePack({
      repoRoot,
      workerName: args.worker,
      workerLocation: worker.location,
      projectId: state.id,
      packName: args.name,
      description: args.description,
      suggestedMessage: args.message,
    })
    reportPack(meta.name, meta.commits.length)
    return
  }

  const repoDir = getWorkerRepoDir(repoRoot, args.worker)

  if (!(await git.isClean(repoDir))) {
    await git.addAll(repoDir)
    await git.commit(repoDir, commitMessage)
    logger.info(`Committed working tree on "${args.worker}": "${commitMessage}"`)
  }

  if (worker.check && !args['skip-check']) {
    logger.start(`Running check on "${args.worker}": ${worker.check}`)
    try {
      await execa(worker.check, { cwd: repoDir, stdio: 'inherit', shell: true })
    } catch {
      throw new QuimbyError(
        `Check failed for "${args.worker}" — fix it in the worker and re-pack (or pass --skip-check)`,
      )
    }
    logger.success('Check passed')
  }

  const meta = await createPack({
    repoRoot,
    workerName: args.worker,
    packName: args.name,
    description: args.description,
    suggestedMessage: args.message,
  })
  reportPack(meta.name, meta.commits.length)
}

function reportPack(name: string, commitCount: number): void {
  logger.success(`Pack "${name}" created (${commitCount} commit${commitCount === 1 ? '' : 's'})`)
}
