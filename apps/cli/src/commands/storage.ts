import { QuimbyError } from '@quimbyhq/errors'
import { getStorageWorkspaceDir } from '@quimbyhq/paths'
import { logger } from '@quimbyhq/utils'
import {
  listStorageWorkspaces,
  pruneStorageWorkspaces,
  removeStorageWorkspace,
  resolveWorkspace,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

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
      },
      run: (ctx) => runStoragePruneCommand(ctx as never),
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
  args: { force?: boolean }
}): Promise<void> {
  const stale = await pruneStorageWorkspaces({ force: args.force })
  if (stale.length === 0) {
    logger.success('No stale durable workspaces found.')
    return
  }
  for (const workspace of stale) {
    logger.info(`${args.force ? 'removed' : 'would remove'} ${workspace.id}  ${workspace.path}`)
  }
  if (!args.force) logger.info('Pass --force to remove these stale workspaces.')
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
