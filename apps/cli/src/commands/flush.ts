import { readdir, rm } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import {
  getWorkerDir,
  getWorkerOutboxDir,
  getWorkerOutboxFile,
  remoteWorkerDir,
} from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import { isSSH } from '@quimbyhq/types'
import { exists, readText, writeText } from '@quimbyhq/utils'
import { logger } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { basename, join } from 'pathe'

export default defineCommand({
  meta: {
    name: 'flush',
    description: "Dispatch a worker's outbox as assignments to target workers",
  },
  args: {
    worker: {
      type: 'positional',
      description: 'Worker whose outbox to flush',
      required: true,
    },
    target: {
      type: 'positional',
      description: 'Dispatch only the draft for this target worker (optional)',
      required: false,
    },
  },
  run,
})

export async function run({ args }: { args: { worker: string; target?: string } }): Promise<void> {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.worker]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.worker}" not found`)
  }

  const outboxDir = getWorkerOutboxDir(repoRoot, args.worker)

  // Collect the set of outbox files to dispatch.
  let files: string[]
  if (args.target) {
    const file = getWorkerOutboxFile(repoRoot, args.worker, args.target)
    if (!(await exists(file))) {
      throw new QuimbyError(`No outbox draft for "${args.target}" in worker "${args.worker}"`)
    }
    files = [file]
  } else {
    if (!(await exists(outboxDir))) {
      logger.info(`Worker "${args.worker}" has no outbox.`)
      return
    }
    const entries = await readdir(outboxDir)
    files = entries.filter((e) => e.endsWith('.md')).map((e) => join(outboxDir, e))
    if (files.length === 0) {
      logger.info(`Worker "${args.worker}" outbox is empty.`)
      return
    }
  }

  for (const file of files) {
    const targetName = basename(file, '.md')
    const target = state.workers[targetName]
    if (!target) {
      logger.warn(`Skipping "${targetName}" — no such worker`)
      continue
    }

    const content = await readText(file)

    if (isSSH(target.location)) {
      const transport = getSSHTransport(target.location)
      const rWorkerDir = remoteWorkerDir(state.id, targetName, target.location.base)
      await transport.writeFile(`${rWorkerDir}/assignment.md`, content)
    } else {
      const workerDir = getWorkerDir(repoRoot, targetName)
      await writeText(join(workerDir, 'assignment.md'), content)
    }

    await rm(file)
    logger.success(`Dispatched assignment to "${targetName}"`)
  }
}
