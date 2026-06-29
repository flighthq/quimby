import { QuimbyError } from '@quimbyhq/errors'
import { logger } from '@quimbyhq/utils'
import {
  setWorkerCheck,
  setWorkerDefaults,
  setWorkerLocation,
  setWorkerSyncRef,
  setWorkerTmux,
} from '@quimbyhq/worker'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { runWorkerWalkthrough } from '../walkthrough'

export default defineCommand({
  meta: {
    name: 'config',
    description: 'Configure a worker interactively (runtime, agent, location, …)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Worker name',
      required: true,
    },
  },
  run: runConfigCommand,
})

export async function runConfigCommand({ args }: { args: { name: string } }) {
  const { state, repoRoot } = await resolveWorkspace()

  const worker = state.workers[args.name]
  if (!worker) {
    throw new QuimbyError(`Worker "${args.name}" not found`)
  }

  const config = await runWorkerWalkthrough(args.name, {
    runtime: worker.defaults?.runtime,
    agent: worker.defaults?.agent,
    location: worker.location,
    syncRef: worker.syncRef,
    check: worker.check,
  })
  if (!config) return

  await setWorkerDefaults(repoRoot, args.name, { runtime: config.runtime, agent: config.agent })
  await setWorkerLocation(repoRoot, args.name, config.location ?? { type: 'local' })
  await setWorkerCheck(repoRoot, args.name, config.check ?? '')
  await setWorkerTmux(repoRoot, args.name, config.tmux ?? false)
  if (config.syncRef) {
    await setWorkerSyncRef(repoRoot, args.name, config.syncRef)
  }

  logger.success(`Worker "${args.name}" configured`)
}
