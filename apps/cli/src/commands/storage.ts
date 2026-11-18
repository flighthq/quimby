import { existsSync } from 'node:fs'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getStorageWorkspaceDir } from '@quimbyhq/paths'
import type { SandboxSweepResult } from '@quimbyhq/runtimes'
import {
  listQuimbySandboxes,
  removeQuimbySandboxes,
  sandboxRemoveCommand,
} from '@quimbyhq/runtimes'
import type { QuimbyConfig, SSHLocation } from '@quimbyhq/types'
import {
  formatByteSizeKb,
  formatDuration,
  logger,
  mapConcurrentInOrder,
  parseDuration,
} from '@quimbyhq/utils'
import type { RemoteDiskUsage, RemoteWorkspaceOwnership } from '@quimbyhq/workspace'
import {
  getRemoteDiskUsage,
  getRemoteHostOverview,
  getRemoteWorkspaceLabel,
  getRemoteWorkspaceLastActiveAt,
  getRemoteWorkspaceLiveCount,
  getRemoteWorkspaceReclaimableKb,
  getRemoteWorkspaceUnlandedWork,
  listRemoteAgentIds,
  listRemoteLiveSessions,
  listStorageWorkspaces,
  loadQuimbyConfig,
  loadState,
  pruneStorageWorkspaces,
  readStoredState,
  remoteDiskWarning,
  remoteSandboxShellRunner,
  removeRemoteReclaimableDirs,
  removeRemoteWorkspace,
  removeStorageWorkspace,
  resolveRemoteWorkspaceId,
  resolveWorkspace,
  scanRemoteWorkspaceUsage,
  selectOrphanSandboxes,
  selectRemoteWorkspacePruneCandidates,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { resolveSSHLocationInteractive } from '../hostAlias'

export default defineCommand({
  meta: {
    name: 'storage',
    description: 'Inspect and clean durable Quimby workspace storage',
  },
  subCommands: {
    path: defineCommand({
      meta: {
        name: 'path',
        description: 'Print the durable storage path for the current project',
      },
      run: runStoragePathCommand,
    }),
    list: defineCommand({
      meta: {
        name: 'list',
        description: 'List known durable Quimby workspaces',
      },
      run: runStorageListCommand,
    }),
    prune: defineCommand({
      meta: {
        name: 'prune',
        description: 'Remove unregistered durable workspace directories',
      },
      args: {
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Actually remove stale storage; without this, only preview',
        },
        stale: {
          type: 'boolean',
          default: false,
          description:
            'Also offer registered workspaces whose project directory is gone (review before forcing)',
        },
      },
      run: (ctx) => runStoragePruneCommand(ctx as never),
    }),
    'clean-remote': defineCommand({
      meta: {
        name: 'clean-remote',
        description:
          'Reclaim git-ignored build output (target/, node_modules/, obj/, …) in remote agent clones — never work',
      },
      args: {
        host: {
          type: 'string',
          description: 'Host alias to clean',
          required: true,
        },
        id: {
          type: 'string',
          description: 'Only this workspace id (default: every workspace on the host)',
        },
        'min-idle': {
          type: 'string',
          default: '1h',
          description:
            'Skip agents active more recently than this, even with no live session (default 1h; 0 disables)',
        },
        sandboxes: {
          type: 'boolean',
          default: false,
          description:
            'Also remove orphaned quimby sandboxes — ones no agent dir on the host owns and no live session uses',
        },
        'include-live': {
          type: 'boolean',
          default: false,
          description:
            'Also clean live and recently active agents (a build in progress will break; source and uncommitted changes are still kept)',
        },
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Actually delete; without this, only preview',
        },
      },
      run: (ctx) => runStorageCleanRemoteCommand(ctx as never),
    }),
    'prune-remote': defineCommand({
      meta: {
        name: 'prune-remote',
        description:
          "Remove whole remote workspaces: this repo's duplicates by default, or dormant ones with --idle/--gone/--unclaimed (never live or holding unlanded work)",
      },
      args: {
        host: {
          type: 'string',
          description: 'Host alias to prune on',
          required: true,
        },
        idle: {
          type: 'string',
          description: 'Workspaces whose agents have been inactive this long (30d, 72h, …)',
        },
        gone: {
          type: 'boolean',
          default: false,
          description: 'Workspaces whose local project checkout on this machine no longer exists',
        },
        unclaimed: {
          type: 'boolean',
          default: false,
          description: 'Workspaces no project on this machine has registered',
        },
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Actually remove; without this, only preview',
        },
      },
      run: (ctx) => runStoragePruneRemoteCommand(ctx as never),
    }),
    'list-remote': defineCommand({
      meta: {
        name: 'list-remote',
        description:
          'List every Quimby workspace on a remote host with size, reclaimable build output, activity and unlanded work',
      },
      args: {
        host: {
          type: 'string',
          description: 'Host alias to list workspaces on',
          required: true,
        },
        size: {
          type: 'boolean',
          default: true,
          description: 'Measure sizes (walks every build tree; --no-size for a fast listing)',
        },
      },
      run: (ctx) => runStorageListRemoteCommand(ctx as never),
    }),
    'remove-remote': defineCommand({
      meta: {
        name: 'remove-remote',
        description: 'Remove one remote workspace by project id',
      },
      args: {
        id: {
          type: 'positional',
          description: 'Project id to remove on the remote host',
          required: true,
        },
        host: {
          type: 'string',
          description: 'Host alias the workspace lives on',
          required: true,
        },
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Confirm permanent removal',
        },
        'discard-work': {
          type: 'boolean',
          default: false,
          description: 'Remove even though agents hold commits or uncommitted files nowhere else',
        },
      },
      run: (ctx) => runStorageRemoveRemoteCommand(ctx as never),
    }),
    remove: defineCommand({
      meta: {
        name: 'remove',
        description: 'Remove one durable workspace by project id',
      },
      args: {
        id: {
          type: 'positional',
          description: 'Project id to remove',
          required: true,
        },
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Confirm permanent removal',
        },
      },
      run: (ctx) => runStorageRemoveCommand(ctx as never),
    }),
  },
})

export async function runStoragePathCommand(): Promise<void> {
  const { state } = await resolveWorkspace()
  console.log(getStorageWorkspaceDir(state.id))
}

export async function runStorageListCommand(): Promise<void> {
  const workspaces = await listStorageWorkspaces()
  if (workspaces.length === 0) {
    logger.info('No durable Quimby workspaces found.')
    return
  }
  for (const workspace of workspaces) {
    const flags = [
      workspace.registered ? 'registered' : 'unregistered',
      workspace.exists ? 'present' : 'missing',
    ].join(', ')
    console.log(`${workspace.id}  ${flags}  ${workspace.path}`)
    if (workspace.repoRoot) console.log(`  repo: ${workspace.repoRoot}`)
    if (workspace.sourceRepo) console.log(`  source: ${workspace.sourceRepo}`)
  }
}

export async function runStoragePruneCommand({
  args,
}: {
  args: { force?: boolean; stale?: boolean }
}): Promise<void> {
  const stale = await pruneStorageWorkspaces({ force: args.force, stale: args.stale })
  if (stale.length === 0) {
    logger.success(
      args.stale
        ? 'No unregistered or stale durable workspaces found.'
        : 'No unregistered durable workspaces found.',
    )
    if (!args.stale) {
      logger.info('Anything that ran the real CLI is registered — `--stale` also offers those.')
    }
    return
  }
  for (const workspace of stale) {
    const why = workspace.registered ? `project gone: ${workspace.repoRoot}` : 'unregistered'
    logger.info(
      `${args.force ? 'removed' : 'would remove'} ${workspace.id}  (${why})  ${workspace.path}`,
    )
  }
  if (!args.force) logger.info('Review the list, then pass --force to remove them.')
}

export async function runStorageRemoveCommand({
  args,
}: {
  args: { id: string; force?: boolean }
}): Promise<void> {
  if (!args.force) {
    throw new QuimbyError(`Pass --force to remove durable workspace "${args.id}".`)
  }
  const { existed, sandboxes } = await removeStorageWorkspace(args.id)
  reportSandboxSweep(sandboxes, 'this machine')
  if (existed) logger.success(`Removed durable workspace "${args.id}".`)
  else logger.info(`Durable workspace "${args.id}" was not present.`)
}

export async function runStorageCleanRemoteCommand({
  args,
}: {
  args: {
    host: string
    id?: string
    'min-idle'?: string
    'include-live'?: boolean
    sandboxes?: boolean
    force?: boolean
  }
}): Promise<void> {
  const force = args.force === true
  const includeLive = args['include-live'] === true
  const minIdleMs = parseDuration(args['min-idle'] ?? '1h')
  if (minIdleMs === null) {
    throw new QuimbyError(`--min-idle "${args['min-idle']}" is not a duration (try 1h, 30m, 0).`)
  }
  const { location, config, agentNames } = await resolveRemoteStorageContext(args.host)
  // Said first and said plainly: whether this run deletes anything is the one fact the reader must
  // not have to infer from the wording of the summary at the end.
  logger.info(
    force
      ? `Cleaning build output on "${args.host}"…`
      : `Preview — nothing will be deleted (add --force to delete). Scanning "${args.host}"…`,
  )
  const overview = await getRemoteHostOverview(location)
  reportRemoteDisk(overview.disk, config, args.host)
  let targets = overview.workspaces
  if (args.id) {
    const resolved = resolveRemoteWorkspaceId(
      targets.map((w) => w.id),
      args.id,
    )
    if ('error' in resolved) throw new QuimbyError(resolved.error)
    targets = targets.filter((w) => w.id === resolved.id)
  }
  if (targets.length === 0) {
    logger.info(`No Quimby workspaces on "${args.host}".`)
    // Orphans are what deleted workspaces leave behind, so an empty host is where they matter most.
    if (args.sandboxes) await cleanOrphanSandboxes(location, args.host, force)
    return
  }
  logger.info(
    `Measuring build output in ${targets.length} workspace(s), ${SCAN_CONCURRENCY} at a time — ` +
      'each is printed as it lands.',
  )
  let freedKb = 0
  let skippedKb = 0
  await mapConcurrentInOrder(
    targets,
    SCAN_CONCURRENCY,
    async (workspace) => {
      const usage = await scanRemoteWorkspaceUsage(location, workspace.id, {
        sizes: true,
        liveSessions: overview.liveSessions,
      })
      let workspaceKb = 0
      let workspaceSkippedKb = 0
      const lines: string[] = []
      for (const agent of usage.agents) {
        const kb = agent.reclaimable.reduce((sum, dir) => sum + dir.sizeKb, 0)
        if (kb === 0) continue
        const name = describeRemoteAgent(agent, agentNames)
        // An in-flight agent is never cleaned by default: not one with a session, and not one that
        // was active moments ago without one (a session that just ended, a build run some other
        // way). Build output is cheap to keep for a while; a tree vanishing mid-compile is not.
        const recentMs =
          agent.lastActiveAt === undefined ? undefined : Date.now() - agent.lastActiveAt
        let skip = includeLive
          ? undefined
          : agent.live
            ? 'live session'
            : recentMs !== undefined && recentMs < minIdleMs
              ? `active ${formatDuration(recentMs)} ago (--min-idle ${formatDuration(minIdleMs)})`
              : undefined
        if (!skip && force) {
          // Re-checked on the host at the moment of deletion, so an agent that started since the
          // scan is still left alone.
          const { live } = await removeRemoteReclaimableDirs(
            location,
            workspace.id,
            agent.id,
            agent.reclaimable.map((dir) => dir.path),
            { includeLive },
          )
          if (live) skip = 'started a session during the sweep'
        }
        if (skip) {
          workspaceSkippedKb += kb
          lines.push(`  ${name}  ${formatByteSizeKb(kb)}  skipped — ${skip}`)
          continue
        }
        const top = agent.reclaimable
          .slice(0, 3)
          .map((dir) => `${dir.path} ${formatByteSizeKb(dir.sizeKb)}`)
          .join(', ')
        const more = agent.reclaimable.length > 3 ? `, +${agent.reclaimable.length - 3} more` : ''
        workspaceKb += kb
        lines.push(`  ${name}  ${formatByteSizeKb(kb)}  ${top}${more}`)
      }
      return { workspace, workspaceKb, workspaceSkippedKb, lines }
    },
    ({ workspace, workspaceKb, workspaceSkippedKb, lines }) => {
      freedKb += workspaceKb
      skippedKb += workspaceSkippedKb
      if (lines.length === 0) return
      console.log(
        `${describeRemoteWorkspace(workspace)}  ${force ? 'freed' : 'would free'} ${formatByteSizeKb(workspaceKb)}` +
          (workspaceSkippedKb > 0 ? `, ${formatByteSizeKb(workspaceSkippedKb)} in use (kept)` : ''),
      )
      for (const line of lines) console.log(line)
    },
  )
  if (skippedKb > 0) {
    logger.info(
      `${formatByteSizeKb(skippedKb)} belongs to agents that are live or were active within ` +
        `${formatDuration(minIdleMs)} and was kept (stop them and wait, or pass --include-live).`,
    )
  }
  if (!force) {
    // What --force deletes and what it keeps are two separate sentences on purpose: folded into one
    // list ("…, uncommitted work, … are never touched") the kept items read as the deleted ones.
    if (freedKb > 0) {
      logger.info(
        `Preview only — nothing was deleted. --force would delete ${formatByteSizeKb(freedKb)} of ` +
          'build output: the git-ignored directories listed above (target/, node_modules/, …).',
      )
      logger.info(
        'It keeps everything else: source files, commits, uncommitted changes, ignored files like ' +
          '.env and keys, and nested repositories.',
      )
    } else {
      logger.info('Preview only — nothing was deleted, and there is no idle build output to free.')
    }
  } else if (freedKb === 0) {
    logger.success('Nothing deleted — no idle build output found.')
  } else {
    // The measured `df` before and after, beside the size of what was deleted, so the result is a
    // reading of the disk and not just the sum of what the scan expected to remove.
    const after = await getRemoteDiskUsage(location).catch(() => null)
    const delta =
      overview.disk && after
        ? ` "${args.host}" free space: ${formatByteSizeKb(overview.disk.availKb)} → ${formatByteSizeKb(after.availKb)}.`
        : ''
    logger.success(`Freed ${formatByteSizeKb(freedKb)} of build output.${delta}`)
    logger.info(
      'Agents rebuild it on their next build. Source files, commits and uncommitted changes were kept.',
    )
  }
  if (args.sandboxes) await cleanOrphanSandboxes(location, args.host, force)
}

export async function runStorageListRemoteCommand({
  args,
}: {
  args: { host: string; size?: boolean }
}): Promise<void> {
  const { location, config, ownership, agentNames } = await resolveRemoteStorageContext(args.host)
  const sizes = args.size !== false
  logger.info(`Reading "${args.host}"…`)
  const overview = await getRemoteHostOverview(location)
  reportRemoteDisk(overview.disk, config, args.host)
  const workspaces = overview.workspaces
  if (workspaces.length === 0) {
    logger.info(`No Quimby workspaces on "${args.host}".`)
    return
  }
  logger.info(
    sizes
      ? `Measuring ${workspaces.length} workspace(s), ${SCAN_CONCURRENCY} at a time — sizes walk every ` +
          'build tree, so a large host takes a while; each is printed as it lands (--no-size is fast).'
      : `Checking ${workspaces.length} workspace(s), ${SCAN_CONCURRENCY} at a time…`,
  )
  const now = Date.now()
  let totalKb = 0
  let reclaimableKb = 0
  let unclaimedKb = 0
  const dormant: string[] = []
  await mapConcurrentInOrder(
    workspaces,
    SCAN_CONCURRENCY,
    (workspace) =>
      scanRemoteWorkspaceUsage(location, workspace.id, {
        sizes,
        liveSessions: overview.liveSessions,
      }),
    (usage, workspace) => {
      if (!usage.present) return
      const owner = describeRemoteOwner(workspace.id, ownership)
      const reclaim = getRemoteWorkspaceReclaimableKb(usage)
      const liveCount = getRemoteWorkspaceLiveCount(usage)
      const work = getRemoteWorkspaceUnlandedWork(usage)
      const lastActive = getRemoteWorkspaceLastActiveAt(usage)
      totalKb += usage.sizeKb ?? 0
      reclaimableKb += reclaim
      if (!ownership.claimed.has(workspace.id) && workspace.id !== ownership.activeId) {
        unclaimedKb += usage.sizeKb ?? 0
      }
      if (
        workspace.id !== ownership.activeId &&
        liveCount === 0 &&
        (lastActive === undefined || now - lastActive >= DORMANT_HINT_MS)
      ) {
        dormant.push(workspace.id)
      }
      const flags = [
        owner,
        workspace.agents === undefined ? 'no agents dir' : `${workspace.agents} agent(s)`,
        ...(liveCount > 0 ? [`${liveCount} live`] : []),
      ].join(', ')
      const size = sizes
        ? `  ${formatByteSizeKb(usage.sizeKb)}` +
          (reclaim > 0 ? ` (${formatByteSizeKb(reclaim)} build output)` : '')
        : ''
      console.log(`${describeRemoteWorkspace(workspace)}  ${flags}${size}`)
      if (usage.agents.length > 0) {
        const names = usage.agents.map(
          (agent) => `${describeRemoteAgent(agent, agentNames)}${agent.live ? '*' : ''}`,
        )
        console.log(`  agents: ${names.join(', ')}${liveCount > 0 ? '  (* live)' : ''}`)
      }
      console.log(
        `  last active: ${lastActive === undefined ? 'never' : `${formatDuration(now - lastActive)} ago`}` +
          `  unlanded: ${describeUnlandedWork(work)}`,
      )
    },
  )
  if (sizes) {
    logger.info(
      `${formatByteSizeKb(totalKb)} in ${workspaces.length} workspace(s); ` +
        `${formatByteSizeKb(reclaimableKb)} is git-ignored build output.`,
    )
  }
  if (reclaimableKb > 0) {
    logger.info(
      `Reclaim build output without touching work: \`quimby storage clean-remote --host ${args.host}\` (previews first).`,
    )
  }
  if (dormant.length > 0) {
    logger.info(
      `${dormant.length} workspace(s) have been inactive ${formatDuration(DORMANT_HINT_MS)}+ — ` +
        `review with \`quimby storage prune-remote --host ${args.host} --idle ${formatDuration(DORMANT_HINT_MS)}\`.`,
    )
  }
  const orphans = await countOrphanSandboxes(location, overview.liveSessions).catch(() => 0)
  if (orphans > 0) {
    logger.info(
      `${orphans} sandbox(es) on "${args.host}" belong to no agent there (left by an earlier teardown) — ` +
        `review with \`quimby storage clean-remote --host ${args.host} --sandboxes\`.`,
    )
  }
  if (unclaimedKb > 0) {
    logger.info(
      `${formatByteSizeKb(unclaimedKb)} in workspaces no local project claims (another machine may) — ` +
        `review with \`quimby storage prune-remote --host ${args.host} --unclaimed\`.`,
    )
  }
}

export async function runStoragePruneRemoteCommand({
  args,
}: {
  args: { host: string; idle?: string; gone?: boolean; unclaimed?: boolean; force?: boolean }
}): Promise<void> {
  const idleMs = args.idle === undefined ? undefined : parseDuration(args.idle)
  if (args.idle !== undefined && (idleMs === null || idleMs === undefined || idleMs <= 0)) {
    throw new QuimbyError(`--idle "${args.idle}" is not a duration (try 30d, 72h, 90m).`)
  }
  const sweeping = idleMs !== undefined || args.gone || args.unclaimed
  const { location, ownership, repoRoot } = await resolveRemoteStorageContext(args.host)

  // The duplicate sweep keys on THIS repo's identity and keeps its workspace, so without a local
  // workspace there is nothing to tell the live lane from its copies — refuse rather than guess.
  let duplicatesOf: { sourceRepo: string } | undefined
  if (!sweeping) {
    if (!ownership.activeId) {
      throw new QuimbyError(
        'No local workspace here to protect. Run `quimby up`/`quimby run` (or `quimby restore`) to adopt one first, then prune — ' +
          'or sweep the whole host with --idle <30d>, --gone or --unclaimed.',
      )
    }
    duplicatesOf = { sourceRepo: (await git.getRemoteUrl(repoRoot)) ?? repoRoot }
  }

  logger.info(
    args.force
      ? `Reading "${args.host}"…`
      : `Preview — nothing will be deleted (add --force to delete). Reading "${args.host}"…`,
  )
  const overview = await getRemoteHostOverview(location)
  logger.info(
    `Checking ${overview.workspaces.length} workspace(s) for activity and unlanded work, ` +
      `${SCAN_CONCURRENCY} at a time…`,
  )
  const entries = await mapConcurrentInOrder(
    overview.workspaces,
    SCAN_CONCURRENCY,
    async (workspace) => ({
      id: workspace.id,
      ...(workspace.sourceRepo ? { sourceRepo: workspace.sourceRepo } : {}),
      usage: await scanRemoteWorkspaceUsage(location, workspace.id, {
        liveSessions: overview.liveSessions,
      }),
    }),
    () => {},
  )
  const candidates = selectRemoteWorkspacePruneCandidates(entries, ownership, {
    now: Date.now(),
    ...(idleMs ? { idleMs } : {}),
    ...(args.gone ? { gone: true } : {}),
    ...(args.unclaimed ? { unclaimed: true } : {}),
    ...(duplicatesOf ? { duplicatesOf } : {}),
  })
  if (candidates.length === 0) {
    logger.success(
      sweeping
        ? `No remote workspaces on "${args.host}" match.`
        : `No orphaned remote workspaces for this repo on "${args.host}".`,
    )
    return
  }

  let removed = 0
  let removedKb = 0
  // Measure only what is offered — sizing the whole host is the slow part of every listing. A kept
  // one is measured too: its size is what tells you whether it is worth a closer look.
  await mapConcurrentInOrder(
    candidates,
    SCAN_CONCURRENCY,
    async (candidate) =>
      (
        await scanRemoteWorkspaceUsage(location, candidate.id, {
          sizes: true,
          liveSessions: overview.liveSessions,
        })
      ).sizeKb,
    async (sizeKb, candidate) => {
      const label = `${describeRemoteWorkspace(candidate)}  ${formatByteSizeKb(sizeKb)}`
      if (candidate.blocked) {
        logger.warn(
          `keeping ${label}\n  ${candidate.reasons.join('; ')} — but ${candidate.blocked}`,
        )
        return
      }
      if (args.force) {
        const { sandboxes } = await removeRemoteWorkspace(location, candidate.id)
        reportSandboxSweep(sandboxes, `"${args.host}"`)
        removed++
        removedKb += sizeKb ?? 0
      }
      logger.info(
        `${args.force ? 'removed' : 'would remove'} ${label}\n  ${candidate.reasons.join('; ')}`,
      )
    },
  )
  const blocked = candidates.filter((c) => c.blocked).length
  if (blocked > 0) {
    logger.info(
      `${blocked} kept: removing them would end a live session or lose work that exists nowhere else. ` +
        'Stop live agents from their project first; for one holding work, merge it from its project, or ' +
        `after inspecting it remove it deliberately with \`quimby storage remove-remote <id> --host ${args.host} --force --discard-work\`.`,
    )
  }
  if (!args.force) {
    if (candidates.length > blocked) {
      logger.info(
        'Preview only — nothing was deleted. Review the list, then pass --force to remove them.',
      )
    }
  } else {
    logger.success(`Removed ${removed} remote workspace(s), ${formatByteSizeKb(removedKb)}.`)
  }
}

export async function runStorageRemoveRemoteCommand({
  args,
}: {
  args: { id: string; host: string; force?: boolean; 'discard-work'?: boolean }
}): Promise<void> {
  if (!args.force) {
    throw new QuimbyError(`Pass --force to remove remote workspace "${args.id}" on "${args.host}".`)
  }
  const { location, ownership } = await resolveRemoteStorageContext(args.host)
  const overview = await getRemoteHostOverview(location)
  const resolved = resolveRemoteWorkspaceId(
    overview.workspaces.map((w) => w.id),
    args.id,
  )
  if ('error' in resolved) {
    if (resolved.error.startsWith('No workspace')) {
      logger.info(`Remote workspace "${args.id}" was not present on "${args.host}".`)
      return
    }
    throw new QuimbyError(resolved.error)
  }
  const id = resolved.id
  const workspace = overview.workspaces.find((w) => w.id === id)!
  // Refuse the live one outright rather than trusting the operator to have read the listing: it
  // holds this project's agent repos, mailboxes and assignments, and nothing here is recoverable.
  if (id === ownership.activeId) {
    throw new QuimbyError(
      `"${id}" is the workspace this repo is using on "${args.host}" — refusing to remove it. ` +
        'Use `quimby remove <agent> --force` for one agent, or run this from a different project.',
    )
  }
  const usage = await scanRemoteWorkspaceUsage(location, id, {
    liveSessions: overview.liveSessions,
  })
  if (!usage.present) {
    logger.info(`Remote workspace "${id}" was not present on "${args.host}".`)
    return
  }
  // Deleting a directory a running agent is working in leaves a session with no repo under it —
  // stopping it belongs to the project that owns it, so this refuses rather than offering a flag.
  const liveCount = getRemoteWorkspaceLiveCount(usage)
  if (liveCount > 0) {
    throw new QuimbyError(
      `${describeRemoteWorkspace(workspace)} has ${liveCount} agent(s) with a live session on "${args.host}". ` +
        'Stop them first (`quimby stop <agent>` from that project, or `quimby sessions prune`), then retry.',
    )
  }
  const work = getRemoteWorkspaceUnlandedWork(usage)
  if ((work.unknown || work.commits > 0 || work.dirtyFiles > 0) && !args['discard-work']) {
    throw new QuimbyError(
      `${describeRemoteWorkspace(workspace)} holds work that exists nowhere else: ${describeUnlandedWork(work)}. ` +
        'Merge it from that project first, or pass --discard-work to delete it anyway.',
    )
  }
  const { removed, sandboxes } = await removeRemoteWorkspace(location, id)
  reportSandboxSweep(sandboxes, `"${args.host}"`)
  if (removed) logger.success(`Removed ${describeRemoteWorkspace(workspace)} on "${args.host}".`)
  else logger.info(`Remote workspace "${id}" was not present on "${args.host}".`)
}

// Opt-in: an orphan is inferred, not known — see selectOrphanSandboxes for the one case it misreads.
async function cleanOrphanSandboxes(
  location: Readonly<SSHLocation & { host: string }>,
  host: string,
  force: boolean,
): Promise<void> {
  const run = remoteSandboxShellRunner(location)
  const { clis, sandboxes } = await listQuimbySandboxes(run)
  if (clis.length === 0) {
    logger.info(`No sandbox CLI (sbx/openshell) on "${host}" — no sandboxes to check.`)
    return
  }
  const orphans = selectOrphanSandboxes(
    sandboxes,
    await listRemoteAgentIds(location),
    await listRemoteLiveSessions(location),
  )
  if (orphans.length === 0) {
    logger.success(
      `No orphaned sandboxes on "${host}" (${sandboxes.length} quimby sandbox(es), all owned).`,
    )
    return
  }
  if (!force) {
    for (const sandbox of orphans)
      console.log(`would remove ${sandbox.cli} sandbox ${sandbox.name}`)
    logger.info(
      `${orphans.length} sandbox(es) belong to no agent dir under ~/.quimby/workspaces and no live ` +
        'session. An agent provisioned under a custom --host base path would also look like this — ' +
        'pass --force once you are sure none is yours.',
    )
    return
  }
  reportSandboxSweep({ clis, ...(await removeQuimbySandboxes(run, orphans)) }, `"${host}"`)
}

async function countOrphanSandboxes(
  location: Readonly<SSHLocation & { host: string }>,
  liveSessions: ReadonlySet<string>,
): Promise<number> {
  const { sandboxes } = await listQuimbySandboxes(remoteSandboxShellRunner(location))
  if (sandboxes.length === 0) return 0
  return selectOrphanSandboxes(sandboxes, await listRemoteAgentIds(location), liveSessions).length
}

// A sandbox removed is worth one line each; one the CLI refused is worth naming with the command to
// finish the job, since nothing else will ever point at it again once its workspace is gone.
function reportSandboxSweep(sandboxes: Readonly<SandboxSweepResult>, where: string): void {
  for (const sandbox of sandboxes.removed) {
    logger.info(`Removed ${sandbox.cli} sandbox ${sandbox.name} on ${where}`)
  }
  if (sandboxes.failed.length > 0) {
    logger.warn(
      `Couldn't remove ${sandboxes.failed.length} sandbox(es) on ${where}: ` +
        sandboxes.failed.map((s) => `\`${sandboxRemoveCommand(s)}\``).join(', '),
    )
  }
}

function describeRemoteOwner(id: string, ownership: Readonly<RemoteWorkspaceOwnership>): string {
  // Say what each lane IS before saying what it costs: `active` is the one this repo uses, and
  // `unclaimed here` means no project registered on THIS machine owns it — which is evidence,
  // not proof, since another machine may share the host.
  if (id === ownership.activeId) return 'active'
  const owner = ownership.claimed.get(id)
  if (!owner) return 'unclaimed here'
  return owner.projectPresent ? 'claimed' : 'claimed, project gone'
}

function describeUnlandedWork(work: {
  commits: number
  dirtyFiles: number
  unknown: boolean
}): string {
  if (work.unknown) return 'unknown (an agent repo could not be read)'
  if (work.commits === 0 && work.dirtyFiles === 0) return 'none'
  return `${work.commits} commit(s), ${work.dirtyFiles} dirty file(s)`
}

// Best-effort: a host whose `df` cannot be read still lists, it just has no header.
function reportRemoteDisk(
  disk: Readonly<RemoteDiskUsage> | null,
  config: Readonly<QuimbyConfig>,
  host: string,
): void {
  if (!disk) return
  const warning = remoteDiskWarning(disk, config, host)
  if (warning) {
    logger.warn(warning)
    return
  }
  logger.info(
    `"${host}": ${formatByteSizeKb(disk.availKb)} free of ${formatByteSizeKb(disk.totalKb)} ` +
      `(${Math.round((disk.usedKb / disk.totalKb) * 100)}% used)`,
  )
}

// A workspace is named by its repository and told apart by a short id — the prefix that `--id` and
// `remove-remote` accept, so what a listing prints is also what a command takes.
function describeRemoteWorkspace(workspace: { id: string; sourceRepo?: string }): string {
  return `${getRemoteWorkspaceLabel(workspace.sourceRepo) ?? '(no origin)'} [${workspace.id.slice(0, 8)}]`
}

// This machine's state knows the current name (a rename only re-renders the host's copy on the next
// launch); the host's own record covers a workspace this machine never registered.
function describeRemoteAgent(
  agent: { id: string; name?: string },
  names: ReadonlyMap<string, string>,
): string {
  return names.get(agent.id) ?? agent.name ?? agent.id.slice(0, 8)
}

// The host connection plus what this machine knows about ownership: the id this repo is using (when
// there is a local workspace), and every id a local project registered with whether that project's
// checkout still exists — a deleted checkout is the strongest hint a remote lane was temporary.
async function resolveRemoteStorageContext(host: string): Promise<{
  location: SSHLocation & { host: string }
  config: QuimbyConfig
  ownership: RemoteWorkspaceOwnership
  repoRoot: string
  agentNames: Map<string, string>
}> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')
  const config = await loadQuimbyConfig(repoRoot)
  const location = await resolveSSHLocationInteractive(repoRoot, config, {
    type: 'ssh',
    alias: host,
  })
  const state = await loadState(repoRoot).catch(() => undefined)
  const registered = (await listStorageWorkspaces()).filter((w) => w.registered)
  // Agent names live only in each project's state on this machine, so read them from storage —
  // local files, no round trip. A workspace that cannot be read just falls back to the host's copy.
  const agentNames = new Map<string, string>()
  for (const workspace of registered) {
    const stored = await readStoredState(workspace.id).catch(() => undefined)
    for (const [name, agent] of Object.entries(stored?.agents ?? {})) {
      if (agent?.id) agentNames.set(agent.id, name)
    }
  }
  const claimed = new Map(
    registered.map((w) => [
      w.id,
      {
        ...(w.repoRoot ? { repoRoot: w.repoRoot } : {}),
        // Unknown root reads as present: absence of a record is not evidence of deletion.
        projectPresent: w.repoRoot ? existsSync(w.repoRoot) : true,
      },
    ]),
  )
  return {
    location,
    config,
    ownership: { ...(state ? { activeId: state.id } : {}), claimed },
    repoRoot,
    agentNames,
  }
}

// Workspaces scanned at once. Each scan is one SSH invocation (all sharing one connection, whose
// channel budget the transport's own gate enforces); three keeps the first rows arriving early
// without piling `du` walks onto a host whose disk is the bottleneck.
const SCAN_CONCURRENCY = 3

// When `list-remote` starts pointing at dormant lanes. A hint threshold, not a policy — the
// sweep itself always takes an explicit --idle.
const DORMANT_HINT_MS = 30 * 86_400_000
