import { existsSync } from 'node:fs'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getStorageWorkspaceDir } from '@quimbyhq/paths'
import type { QuimbyConfig, SSHLocation } from '@quimbyhq/types'
import { formatByteSizeKb, formatDuration, logger, parseDuration } from '@quimbyhq/utils'
import type { RemoteWorkspaceOwnership } from '@quimbyhq/workspace'
import {
  getRemoteDiskUsage,
  getRemoteWorkspaceLastActiveAt,
  getRemoteWorkspaceLiveCount,
  getRemoteWorkspaceReclaimableKb,
  getRemoteWorkspaceUnlandedWork,
  listRemoteLiveSessions,
  listRemoteWorkspaces,
  listStorageWorkspaces,
  loadQuimbyConfig,
  loadState,
  pruneStorageWorkspaces,
  remoteDiskWarning,
  removeRemoteReclaimableDirs,
  removeRemoteWorkspace,
  removeStorageWorkspace,
  resolveWorkspace,
  scanRemoteWorkspaceUsage,
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
        'include-live': {
          type: 'boolean',
          default: false,
          description: 'Also clean agents with a live session (a build in progress will break)',
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
  const removed = await removeStorageWorkspace(args.id)
  if (removed) logger.success(`Removed durable workspace "${args.id}".`)
  else logger.info(`Durable workspace "${args.id}" was not present.`)
}

export async function runStorageCleanRemoteCommand({
  args,
}: {
  args: { host: string; id?: string; 'include-live'?: boolean; force?: boolean }
}): Promise<void> {
  const { location, config } = await resolveRemoteStorageContext(args.host)
  const ids = args.id
    ? [args.id]
    : (await listRemoteWorkspaces(location, { sizes: false })).map((w) => w.id)
  if (ids.length === 0) {
    logger.info(`No Quimby workspaces on "${args.host}".`)
    return
  }
  await reportRemoteDisk(location, config, args.host)
  logger.info(
    `Measuring build output in ${ids.length} workspace(s) — each is reported as it is measured.`,
  )
  let reclaimedKb = 0
  let skippedLiveKb = 0
  for (const id of ids) {
    // Re-read live sessions per workspace: on a long sweep an agent can start mid-run, and that
    // is exactly the one whose build directory must not vanish under it.
    const live = await listRemoteLiveSessions(location)
    const usage = await scanRemoteWorkspaceUsage(location, id, { sizes: true, liveSessions: live })
    if (!usage.present) continue
    let workspaceKb = 0
    let workspaceSkippedKb = 0
    const lines: string[] = []
    for (const agent of usage.agents) {
      const kb = agent.reclaimable.reduce((sum, dir) => sum + dir.sizeKb, 0)
      if (kb === 0) continue
      if (agent.live && !args['include-live']) {
        skippedLiveKb += kb
        workspaceSkippedKb += kb
        lines.push(`  ${agent.id.slice(0, 8)}  ${formatByteSizeKb(kb)}  skipped — live session`)
        continue
      }
      const top = agent.reclaimable
        .slice(0, 3)
        .map((dir) => `${dir.path} ${formatByteSizeKb(dir.sizeKb)}`)
        .join(', ')
      const more = agent.reclaimable.length > 3 ? `, +${agent.reclaimable.length - 3} more` : ''
      if (args.force) {
        await removeRemoteReclaimableDirs(
          location,
          id,
          agent.id,
          agent.reclaimable.map((dir) => dir.path),
        )
      }
      workspaceKb += kb
      lines.push(`  ${agent.id.slice(0, 8)}  ${formatByteSizeKb(kb)}  ${top}${more}`)
    }
    if (lines.length === 0) continue
    reclaimedKb += workspaceKb
    console.log(
      `${id}  ${args.force ? 'reclaimed' : 'reclaimable'} ${formatByteSizeKb(workspaceKb)}` +
        (workspaceSkippedKb > 0 ? `, ${formatByteSizeKb(workspaceSkippedKb)} skipped (live)` : ''),
    )
    for (const line of lines) console.log(line)
  }
  if (skippedLiveKb > 0) {
    logger.info(
      `${formatByteSizeKb(skippedLiveKb)} belongs to agents with a live session and was left alone ` +
        '(stop them first, or pass --include-live).',
    )
  }
  if (reclaimedKb === 0) {
    logger.success('No reclaimable build output found.')
  } else if (args.force) {
    logger.success(
      `Reclaimed ${formatByteSizeKb(reclaimedKb)}. Agents rebuild it on their next build; ` +
        'their commits and uncommitted work were not touched.',
    )
    await reportRemoteDisk(location, config, args.host)
  } else {
    logger.info(
      `${formatByteSizeKb(reclaimedKb)} reclaimable — git-ignored directories only; tracked files, ` +
        'uncommitted work, ignored files (.env, keys) and nested repositories are never touched. ' +
        'Pass --force to delete.',
    )
  }
}

export async function runStorageListRemoteCommand({
  args,
}: {
  args: { host: string; size?: boolean }
}): Promise<void> {
  const { location, config, ownership } = await resolveRemoteStorageContext(args.host)
  const sizes = args.size !== false
  await reportRemoteDisk(location, config, args.host)
  const workspaces = await listRemoteWorkspaces(location, { sizes: false })
  if (workspaces.length === 0) {
    logger.info(`No Quimby workspaces on "${args.host}".`)
    return
  }
  if (sizes) {
    logger.info(
      `Measuring ${workspaces.length} workspace(s) — sizes walk every build tree, so a large host ` +
        'takes a while; each is printed as it lands (--no-size for a fast listing).',
    )
  }
  const live = await listRemoteLiveSessions(location)
  const now = Date.now()
  let totalKb = 0
  let reclaimableKb = 0
  let unclaimedKb = 0
  const dormant: string[] = []
  for (const workspace of workspaces) {
    const usage = await scanRemoteWorkspaceUsage(location, workspace.id, {
      sizes,
      liveSessions: live,
    })
    if (!usage.present) continue
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
    console.log(`${workspace.id}  ${flags}${size}`)
    if (workspace.sourceRepo) {
      console.log(
        `  source: ${workspace.sourceRepo}${workspace.sourceRef ? ` (${workspace.sourceRef})` : ''}`,
      )
    }
    console.log(
      `  last active: ${lastActive === undefined ? 'never' : `${formatDuration(now - lastActive)} ago`}` +
        `  unlanded: ${describeUnlandedWork(work)}`,
    )
  }
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

  const workspaces = await listRemoteWorkspaces(location, { sizes: false })
  const live = await listRemoteLiveSessions(location)
  const entries = []
  for (const workspace of workspaces) {
    entries.push({
      id: workspace.id,
      ...(workspace.sourceRepo ? { sourceRepo: workspace.sourceRepo } : {}),
      usage: await scanRemoteWorkspaceUsage(location, workspace.id, { liveSessions: live }),
    })
  }
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
  for (const candidate of candidates) {
    // Measure only what is offered — sizing the whole host is the slow part of every listing. A
    // kept one is measured too: its size is what tells you whether it is worth a closer look.
    const { sizeKb } = await scanRemoteWorkspaceUsage(location, candidate.id, {
      sizes: true,
      liveSessions: live,
    })
    const label = `${candidate.id}  ${formatByteSizeKb(sizeKb)}  ${candidate.sourceRepo ?? '(no source)'}`
    if (candidate.blocked) {
      logger.warn(`keeping ${label}\n  ${candidate.reasons.join('; ')} — but ${candidate.blocked}`)
      continue
    }
    if (args.force) {
      await removeRemoteWorkspace(location, candidate.id)
      removed++
      removedKb += sizeKb ?? 0
    }
    logger.info(
      `${args.force ? 'removed' : 'would remove'} ${label}\n  ${candidate.reasons.join('; ')}`,
    )
  }
  const blocked = candidates.filter((c) => c.blocked).length
  if (blocked > 0) {
    logger.info(
      `${blocked} kept: removing them would end a live session or lose work that exists nowhere else. ` +
        'Stop live agents from their project first; for one holding work, merge it from its project, or ' +
        `after inspecting it remove it deliberately with \`quimby storage remove-remote <id> --host ${args.host} --force --discard-work\`.`,
    )
  }
  if (!args.force) {
    if (candidates.length > blocked)
      logger.info('Review the list, then pass --force to remove them.')
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
  // Refuse the live one outright rather than trusting the operator to have read the listing: it
  // holds this project's agent repos, mailboxes and assignments, and nothing here is recoverable.
  if (args.id === ownership.activeId) {
    throw new QuimbyError(
      `"${args.id}" is the workspace this repo is using on "${args.host}" — refusing to remove it. ` +
        'Use `quimby remove <agent> --force` for one agent, or run this from a different project.',
    )
  }
  const usage = await scanRemoteWorkspaceUsage(location, args.id)
  if (!usage.present) {
    logger.info(`Remote workspace "${args.id}" was not present on "${args.host}".`)
    return
  }
  // Deleting a directory a running agent is working in leaves a session with no repo under it —
  // stopping it belongs to the project that owns it, so this refuses rather than offering a flag.
  const liveCount = getRemoteWorkspaceLiveCount(usage)
  if (liveCount > 0) {
    throw new QuimbyError(
      `"${args.id}" has ${liveCount} agent(s) with a live session on "${args.host}". ` +
        'Stop them first (`quimby stop <agent>` from that project, or `quimby sessions prune`), then retry.',
    )
  }
  const work = getRemoteWorkspaceUnlandedWork(usage)
  if ((work.unknown || work.commits > 0 || work.dirtyFiles > 0) && !args['discard-work']) {
    throw new QuimbyError(
      `"${args.id}" holds work that exists nowhere else: ${describeUnlandedWork(work)}. ` +
        'Merge it from that project first, or pass --discard-work to delete it anyway.',
    )
  }
  const removed = await removeRemoteWorkspace(location, args.id)
  if (removed) logger.success(`Removed remote workspace "${args.id}" on "${args.host}".`)
  else logger.info(`Remote workspace "${args.id}" was not present on "${args.host}".`)
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
async function reportRemoteDisk(
  location: Readonly<SSHLocation & { host: string }>,
  config: Readonly<QuimbyConfig>,
  host: string,
): Promise<void> {
  const disk = await getRemoteDiskUsage(location).catch(() => null)
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

// The host connection plus what this machine knows about ownership: the id this repo is using (when
// there is a local workspace), and every id a local project registered with whether that project's
// checkout still exists — a deleted checkout is the strongest hint a remote lane was temporary.
async function resolveRemoteStorageContext(host: string): Promise<{
  location: SSHLocation & { host: string }
  config: QuimbyConfig
  ownership: RemoteWorkspaceOwnership
  repoRoot: string
}> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')
  const config = await loadQuimbyConfig(repoRoot)
  const location = await resolveSSHLocationInteractive(repoRoot, config, {
    type: 'ssh',
    alias: host,
  })
  const state = await loadState(repoRoot).catch(() => undefined)
  const claimed = new Map(
    (await listStorageWorkspaces())
      .filter((w) => w.registered)
      .map((w) => [
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
  }
}

// When `list-remote` starts pointing at dormant lanes. A hint threshold, not a policy — the
// sweep itself always takes an explicit --idle.
const DORMANT_HINT_MS = 30 * 86_400_000
