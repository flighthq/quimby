import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getQuimbyDir } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  loadQuimbyConfig,
  reconstructRemoteWorkspace,
  restoreWorkspaceLink,
  scanRemoteProjects,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

import { resolveSSHLocationInteractive } from '../hostAlias'

export default defineCommand({
  meta: {
    name: 'restore',
    description: 'Reconnect durable Quimby workspace storage after local .quimby is lost',
  },
  args: {
    id: {
      type: 'string',
      description: 'Project id to restore when multiple candidates exist',
    },
    host: {
      type: 'string',
      description: 'Host alias to reconstruct state from remote durable storage',
    },
    preset: {
      type: 'string',
      description: 'Preset to use when reconstructing agent roles from a remote host',
    },
  },
  run: runRestoreCommand,
})

export async function runRestoreCommand({
  args,
}: {
  args: { id?: string; host?: string; preset?: string }
}): Promise<void> {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')

  const sourceRepo = (await git.getRemoteUrl(repoRoot)) ?? repoRoot
  const local = await restoreWorkspaceLink(repoRoot, { id: args.id, sourceRepo })
  if (local) {
    logger.success(`Restored quimby workspace "${local.id}" at ${getQuimbyDir(repoRoot)}`)
    return
  }

  if (!args.host) {
    throw new QuimbyError(
      'No registered durable workspace matched this repository. Use `quimby restore --host <alias>` to reconstruct from a remote host.',
    )
  }

  const state = await restoreFromRemote(repoRoot, {
    projectId: args.id,
    hostAlias: args.host,
    presetName: args.preset ?? args.host,
    sourceRepo,
  })
  logger.success(`Restored quimby workspace "${state.id}" from host alias "${args.host}"`)
}

async function restoreFromRemote(
  repoRoot: string,
  opts: Readonly<{ projectId?: string; hostAlias: string; presetName: string; sourceRepo: string }>,
): Promise<QuimbyState> {
  const config = await loadQuimbyConfig(repoRoot)
  // Resolve (and, if needed, prompt for + persist) the alias's address before we scan —
  // restore's own SSH connection needs a concrete host just like a launch does.
  const location = await resolveSSHLocationInteractive(repoRoot, config, {
    type: 'ssh',
    alias: opts.hostAlias,
  })
  const remoteProjects = await scanRemoteProjects(location)
  const candidates = opts.projectId
    ? remoteProjects.filter((p) => p.id === opts.projectId)
    : remoteProjects.filter((p) => p.sourceRepo === opts.sourceRepo)
  if (candidates.length === 0) {
    throw new QuimbyError(
      `No remote quimby workspace matched ${opts.projectId ? `project "${opts.projectId}"` : `source "${opts.sourceRepo}"`}.`,
    )
  }
  if (candidates.length > 1) {
    throw new QuimbyError(
      `Multiple remote quimby workspaces match: ${candidates.map((p) => p.id).join(', ')}. Run \`quimby restore --host ${opts.hostAlias} --id <id>\`.`,
    )
  }

  return reconstructRemoteWorkspace(repoRoot, location, config, candidates[0], {
    presetName: opts.presetName,
    fallbackAlias: opts.hostAlias,
    sourceRepo: opts.sourceRepo,
  })
}
