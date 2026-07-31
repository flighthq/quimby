import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getStorageWorkspaceDir } from '@quimbyhq/paths'
import type { SSHLocation } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  listRemoteWorkspaces,
  listStorageWorkspaces,
  loadQuimbyConfig,
  loadState,
  pruneRemoteWorkspaces,
  pruneStorageWorkspaces,
  removeRemoteWorkspace,
  removeStorageWorkspace,
  resolveWorkspace,
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
    'prune-remote': defineCommand({
      meta: {
        name: 'prune-remote',
        description:
          'Remove orphaned remote workspaces for this repo on a host (keeps the active one)',
      },
      args: {
        host: {
          type: 'string',
          description: 'Host alias to prune orphaned remote workspaces on',
          required: true,
        },
        force: {
          type: 'boolean',
          alias: 'f',
          default: false,
          description: 'Actually remove the orphaned remote workspaces; without this, only preview',
        },
      },
      run: (ctx) => runStoragePruneRemoteCommand(ctx as never),
    }),
    'list-remote': defineCommand({
      meta: {
        name: 'list-remote',
        description: 'List every Quimby workspace on a remote host',
      },
      args: {
        host: {
          type: 'string',
          description: 'Host alias to list workspaces on',
          required: true,
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

export async function runStoragePruneRemoteCommand({
  args,
}: {
  args: { host: string; force?: boolean }
}): Promise<void> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')

  // The active workspace is the one to keep; without it we cannot tell which remote lane
  // is the live one, so refuse rather than risk deleting it.
  const state = await loadState(repoRoot).catch(() => undefined)
  if (!state) {
    throw new QuimbyError(
      'No local workspace here to protect. Run `quimby up`/`quimby run` (or `quimby restore`) to adopt one first, then prune.',
    )
  }
  const sourceRepo = (await git.getRemoteUrl(repoRoot)) ?? repoRoot
  const config = await loadQuimbyConfig(repoRoot)
  const location = await resolveSSHLocationInteractive(repoRoot, config, {
    type: 'ssh',
    alias: args.host,
  })

  const stale = await pruneRemoteWorkspaces(location, {
    sourceRepo,
    keepId: state.id,
    force: args.force,
  })
  if (stale.length === 0) {
    logger.success(`No orphaned remote workspaces for this repo on "${args.host}".`)
    return
  }
  for (const workspace of stale) {
    logger.info(`${args.force ? 'removed' : 'would remove'} ${workspace.id}  (on ${args.host})`)
  }
  if (!args.force) logger.info('Pass --force to remove these orphaned remote workspaces.')
  else logger.success(`Removed ${stale.length} orphaned remote workspace(s); kept "${state.id}".`)
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

export async function runStorageListRemoteCommand({
  args,
}: {
  args: { host: string }
}): Promise<void> {
  const { location, activeId, claimed } = await resolveRemoteStorageContext(args.host)
  const workspaces = await listRemoteWorkspaces(location)
  if (workspaces.length === 0) {
    logger.info(`No Quimby workspaces on "${args.host}".`)
    return
  }
  for (const workspace of workspaces) {
    // Say what each lane IS before saying what it costs: `active` is the one this repo uses, and
    // `unclaimed here` means no project registered on THIS machine owns it — which is evidence,
    // not proof, since another machine may share the host.
    const flags = [
      workspace.id === activeId
        ? 'active'
        : claimed.has(workspace.id)
          ? 'claimed'
          : 'unclaimed here',
      workspace.agents === undefined ? 'no agents dir' : `${workspace.agents} agent(s)`,
    ].join(', ')
    console.log(`${workspace.id}  ${flags}  ${formatKb(workspace.sizeKb)}`)
    if (workspace.sourceRepo) console.log(`  source: ${workspace.sourceRepo}`)
    if (workspace.sourceRef) console.log(`  ref: ${workspace.sourceRef}`)
  }
  const reclaimable = workspaces
    .filter((w) => w.id !== activeId && !claimed.has(w.id))
    .reduce((sum, w) => sum + (w.sizeKb ?? 0), 0)
  if (reclaimable > 0) {
    logger.info(
      `${formatKb(reclaimable)} in workspaces no local project claims — ` +
        `remove one with \`quimby storage remove-remote <id> --host ${args.host} --force\`.`,
    )
  }
}

export async function runStorageRemoveRemoteCommand({
  args,
}: {
  args: { id: string; host: string; force?: boolean }
}): Promise<void> {
  if (!args.force) {
    throw new QuimbyError(`Pass --force to remove remote workspace "${args.id}" on "${args.host}".`)
  }
  const { location, activeId } = await resolveRemoteStorageContext(args.host)
  // Refuse the live one outright rather than trusting the operator to have read the listing: it
  // holds this project's agent repos, mailboxes and assignments, and nothing here is recoverable.
  if (args.id === activeId) {
    throw new QuimbyError(
      `"${args.id}" is the workspace this repo is using on "${args.host}" — refusing to remove it. ` +
        'Use `quimby remove <agent> --force` for one agent, or run this from a different project.',
    )
  }
  const removed = await removeRemoteWorkspace(location, args.id)
  if (removed) logger.success(`Removed remote workspace "${args.id}" on "${args.host}".`)
  else logger.info(`Remote workspace "${args.id}" was not present on "${args.host}".`)
}

// The host connection plus what this machine knows about ownership: the id this repo is using (when
// there is a local workspace) and every id any local project has registered.
async function resolveRemoteStorageContext(
  host: string,
): Promise<{ location: SSHLocation & { host: string }; activeId?: string; claimed: Set<string> }> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')
  const config = await loadQuimbyConfig(repoRoot)
  const location = await resolveSSHLocationInteractive(repoRoot, config, {
    type: 'ssh',
    alias: host,
  })
  const state = await loadState(repoRoot).catch(() => undefined)
  const claimed = new Set(
    (await listStorageWorkspaces()).filter((w) => w.registered).map((w) => w.id),
  )
  return { location, ...(state ? { activeId: state.id } : {}), claimed }
}

function formatKb(kb: number | undefined): string {
  if (kb === undefined) return '(size unknown)'
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}M`
  return `${kb}K`
}
