import { QuimbyError } from '@quimbyhq/errors'
import type { PoolInventory, PoolSession } from '@quimbyhq/pool'
import {
  getPoolCapacity,
  getPoolIdleTimeoutMs,
  getPoolInventory,
  prunePoolSessions,
  selectPrunablePoolSessions,
} from '@quimbyhq/pool'
import type { QuimbyState } from '@quimbyhq/types'
import { formatDuration, logger, parseDuration } from '@quimbyhq/utils'
import { loadQuimbyConfig, resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { bold, cyan, dim, green, yellow } from '../colors'

export default defineCommand({
  meta: {
    name: 'sessions',
    description: 'Show every live quimby tmux session across all projects (the agent pool)',
  },
  subCommands: {
    prune: defineCommand({
      meta: {
        name: 'prune',
        description: 'Close idle or orphaned agent sessions (attached sessions are never touched)',
      },
      args: {
        idle: {
          type: 'string',
          description: 'Close agent sessions idle at least this long (30s / 45m / 2h / 1d)',
        },
        orphans: {
          type: 'boolean',
          default: false,
          description: 'Close sessions no workspace claims, whatever their idle time',
        },
        here: {
          type: 'boolean',
          default: false,
          description: 'Restrict the sweep to this project (default: every project on the socket)',
        },
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Actually close them; without this, only preview',
        },
      },
      run: (ctx) => runSessionsPruneCommand(ctx as never),
    }),
  },
  run: (ctx) => runSessionsCommand(ctx as never),
})

export async function runSessionsCommand({ rawArgs }: { rawArgs?: string[] }) {
  // citty runs a parent's `run` *after* a matched subcommand, so the bare listing stands down
  // when the invocation was `quimby sessions prune …` — otherwise a sweep prints the roster twice.
  if ((rawArgs ?? []).some((arg) => arg === 'prune')) return
  const { inventory, state } = await readPool()

  if (inventory.totals.sessions === 0) {
    logger.info('No live quimby sessions.')
    return
  }

  const config = await loadQuimbyConfig(process.cwd()).catch(() => undefined)
  // Flag what a sweep would likely take: the configured auto-reap threshold when there is one,
  // else an hour — long enough that an agent you are working with never reads as abandoned.
  const idleMs = getPoolIdleTimeoutMs(config) ?? DEFAULT_IDLE_MARK_MS

  for (const project of inventory.projects) {
    const here = state && project.id === state.id ? `  ${dim('(this project)')}` : ''
    console.log(`${bold(project.label)}  ${dim(`${project.sessions.length} live`)}${here}`)
    for (const session of project.sessions) console.log(`  ${renderSession(session, idleMs)}`)
  }

  if (inventory.orphans.length > 0) {
    console.log(bold('orphaned'))
    for (const session of inventory.orphans) console.log(`  ${renderSession(session, idleMs)}`)
    console.log(dim('  No workspace claims these — close them with `quimby sessions prune --orphans --force`.')) // prettier-ignore
  }

  const { sessions, agents, attached, orphans } = inventory.totals
  const parts = [
    `${sessions} session${sessions === 1 ? '' : 's'}`,
    `${inventory.projects.length} project${inventory.projects.length === 1 ? '' : 's'}`,
    `${agents} agent${agents === 1 ? '' : 's'}`,
    `${attached} attached`,
  ]
  if (orphans > 0) parts.push(yellow(`${orphans} orphan${orphans === 1 ? '' : 's'}`))
  console.log()
  console.log(parts.join(dim(' · ')))

  const capacity = getPoolCapacity(inventory, config)
  if (capacity) {
    const line = `pool: ${capacity.live}/${capacity.maxLive} live agent sessions`
    console.log(capacity.live >= capacity.maxLive ? yellow(line) : dim(line))
  }
}

export async function runSessionsPruneCommand({
  args,
}: {
  args: { idle?: string; orphans?: boolean; here?: boolean; force?: boolean }
}) {
  const idleMs = resolveIdleFlag(args.idle)
  if (idleMs === null && !args.orphans) {
    throw new QuimbyError(
      'Nothing selected to close. Pass --idle <2h> to close idle agent sessions, --orphans to close unclaimed ones, or both.',
    )
  }

  const { inventory, state } = await readPool()
  if (args.here && !state) {
    throw new QuimbyError('--here needs a quimby workspace in the current directory.')
  }
  const opts = {
    ...(idleMs !== null ? { idleMs } : {}),
    ...(args.orphans ? { orphans: true } : {}),
    ...(args.here && state ? { projectId: state.id } : {}),
  }

  const selected = selectPrunablePoolSessions(inventory, opts)
  if (selected.length === 0) {
    logger.info('Nothing to close — no session matches.')
    return
  }

  if (!args.force) {
    logger.info(`Would close ${selected.length} session${selected.length === 1 ? '' : 's'}:`)
    for (const session of selected) console.log(`  ${renderSession(session, null)}`)
    logger.info('Re-run with --force to close them. Work on disk is untouched; only the live session ends.') // prettier-ignore
    return
  }

  const { killed, missed } = await prunePoolSessions(inventory, opts)
  for (const session of killed) logger.success(`Closed ${sessionLabel(session)}`)
  for (const session of missed) logger.warn(`${sessionLabel(session)} was already gone`)
  logger.info(`Closed ${killed.length} session${killed.length === 1 ? '' : 's'}.`)
}

// The pool is machine-wide, so it must read outside any workspace too — `quimby sessions` run
// from a random directory still answers "what is running on this machine".
async function readPool(): Promise<{ inventory: PoolInventory; state?: QuimbyState }> {
  const workspace = await resolveWorkspace().catch(() => null)
  const state = workspace?.state
  const inventory = await getPoolInventory(state ? { currentState: state } : {})
  return state ? { inventory, state } : { inventory }
}

function resolveIdleFlag(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = parseDuration(value)
  if (parsed === null) {
    throw new QuimbyError(`Could not read --idle "${value}" as a duration (try 30s, 45m, 2h, 1d).`)
  }
  return parsed
}

// An hour of silence is the default "probably done" mark when no `pool.idleTimeout` is set.
const DEFAULT_IDLE_MARK_MS = 3_600_000

function renderSession(session: Readonly<PoolSession>, idleThresholdMs: number | null): string {
  const label = (session.agentName ?? session.name).padEnd(14)
  const state = session.attached
    ? cyan('● attached')
    : session.kind === 'agent'
      ? green('● running')
      : dim(`○ ${session.kind}`)
  const idle = `idle ${formatDuration(session.idleMs)}`
  const flags = [
    session.orphan ? yellow('no workspace') : '',
    idleThresholdMs !== null && !session.attached && session.idleMs >= idleThresholdMs
      ? yellow('← idle')
      : '',
  ].filter(Boolean)
  return `${label} ${state}  ${dim(idle)}  ${dim(session.name)}${flags.length ? `  ${flags.join('  ')}` : ''}`
}

function sessionLabel(session: Readonly<PoolSession>): string {
  return session.agentName ? `${session.agentName} (${session.name})` : session.name
}
