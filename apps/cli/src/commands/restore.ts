import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getQuimbyDir, remoteProjectRoot } from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import {
  ensureDurableWorkspace,
  loadQuimbyConfig,
  normalizeCheck,
  resolveAgentRoleConfig,
  resolveConfiguredAgent,
  resolveHostAlias,
  resolveRecipe,
  restoreWorkspaceLink,
  saveState,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { execa } from 'execa'

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
    recipe: {
      type: 'string',
      description: 'Recipe to use when reconstructing agent roles from a remote host',
    },
  },
  run: runRestoreCommand,
})

export async function runRestoreCommand({
  args,
}: {
  args: { id?: string; host?: string; recipe?: string }
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
    recipeName: args.recipe ?? args.host,
    sourceRepo,
  })
  logger.success(`Restored quimby workspace "${state.id}" from host alias "${args.host}"`)
}

async function restoreFromRemote(
  repoRoot: string,
  opts: Readonly<{ projectId?: string; hostAlias: string; recipeName: string; sourceRepo: string }>,
): Promise<QuimbyState> {
  const config = await loadQuimbyConfig(repoRoot)
  const alias = resolveHostAlias(config, opts.hostAlias)
  if (!alias) throw new QuimbyError(`Host alias "${opts.hostAlias}" not found in quimby config`)
  const location = aliasToLocation(alias)
  const transport = getSSHTransport(location)
  const remoteProjects = parseRemoteProjects(await transport.exec(remoteProjectScanScript()))
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

  const project = candidates[0]
  const remoteAgents = parseRemoteAgents(
    await transport.exec(remoteAgentScanScript(remoteProjectRoot(project.id, alias.base))),
  )
  if (remoteAgents.length === 0) {
    throw new QuimbyError(`Remote workspace "${project.id}" has no recoverable agents.`)
  }

  const recipe = config.recipes?.[opts.recipeName] ? resolveRecipe(config, opts.recipeName) : {}
  const sourceRef = await getCurrentBranch(repoRoot)
  const snapshot = await git.getCurrentRef(repoRoot)
  const now = new Date().toISOString()
  const agents: Record<string, AgentState> = {}
  for (const remoteAgent of remoteAgents) {
    const raw = recipe.agents?.[remoteAgent.name]
    const configured = resolveConfiguredAgent(config, raw)
    const role = resolveAgentRoleConfig(config, configured)
    const check = normalizeCheck(role.check)
    const agentAlias = resolveHostAlias(config, configured.hostAlias ?? opts.hostAlias)
    agents[remoteAgent.name] = {
      id: remoteAgent.id,
      name: remoteAgent.name,
      seedCommit: remoteAgent.seedCommit || snapshot,
      syncRef: sourceRef,
      createdAt: now,
      location: configured.location ?? aliasToLocation(agentAlias ?? alias),
      ...(role.runtimeProfile || role.runtime || role.entrypoint
        ? {
            defaults: {
              ...(role.runtimeProfile ? { runtimeProfile: role.runtimeProfile } : {}),
              ...(role.runtime ? { runtime: role.runtime } : {}),
              ...(role.entrypoint ? { entrypoint: role.entrypoint } : {}),
            },
          }
        : {}),
      ...(role.tmux ? { tmux: true } : {}),
      ...(check?.command ? { check: check.command } : {}),
      ...((check?.verifyByDefault ?? role.verifyByDefault) ? { verifyByDefault: true } : {}),
    }
  }

  const state: QuimbyState = {
    id: project.id,
    sourceRepo: opts.sourceRepo,
    sourceRef,
    snapshot,
    createdAt: now,
    agents,
    ...(recipe.subscriptions ? { subscriptions: recipe.subscriptions } : {}),
  }

  await ensureDurableWorkspace(repoRoot, state)
  await saveState(repoRoot, state)
  return state
}

function remoteProjectScanScript(): string {
  return [
    'for p in ~/.quimby/workspaces/*; do',
    '[ -d "$p/.quimby/agents" ] || continue;',
    'id=${p##*/};',
    'source=$(git -C "$p" remote get-url origin 2>/dev/null || true);',
    'branch=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null || true);',
    'printf "PROJECT\\t%s\\t%s\\t%s\\n" "$id" "$source" "$branch";',
    'done',
  ].join(' ')
}

function remoteAgentScanScript(remoteRoot: string): string {
  return [
    remoteRootAssignment(remoteRoot),
    'for a in "$root"/.quimby/agents/*; do',
    '[ -d "$a" ] || continue;',
    'id=${a##*/};',
    'name=$(sed -n "s/^You are the \\*\\*\\(.*\\)\\*\\* agent\\.$/\\1/p" "$a/CLAUDE.md" 2>/dev/null | head -n 1);',
    '[ -n "$name" ] || name="$id";',
    'seed=$(git -C "$a/repo" rev-parse quimby/seed 2>/dev/null || git -C "$a/repo" rev-parse HEAD 2>/dev/null || true);',
    'printf "AGENT\\t%s\\t%s\\t%s\\n" "$id" "$name" "$seed";',
    'done',
  ].join(' ')
}

function remoteRootAssignment(remoteRoot: string): string {
  if (remoteRoot === '~') return 'root=$HOME;'
  if (remoteRoot.startsWith('~/')) {
    return `root=$HOME/${remoteRoot.slice(2).split('/').map(shellQuote).join('/')};`
  }
  return `root=${shellQuote(remoteRoot)};`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function parseRemoteProjects(output: string): RemoteProject[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('PROJECT\t'))
    .map((line) => {
      const [, id, sourceRepo, sourceRef] = line.split('\t')
      return { id, sourceRepo, sourceRef }
    })
}

function parseRemoteAgents(output: string): RemoteAgent[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('AGENT\t'))
    .map((line) => {
      const [, id, name, seedCommit] = line.split('\t')
      return { id, name, seedCommit }
    })
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
    return stdout.trim()
  } catch {
    return 'main'
  }
}

function aliasToLocation(alias: NonNullable<ReturnType<typeof resolveHostAlias>>): SSHLocation {
  return {
    type: 'ssh',
    host: alias.host,
    ...(alias.port ? { port: alias.port } : {}),
    ...(alias.base ? { base: alias.base } : {}),
  }
}

interface RemoteProject {
  id: string
  sourceRepo: string
  sourceRef?: string
}

interface RemoteAgent {
  id: string
  name: string
  seedCommit: string
}
