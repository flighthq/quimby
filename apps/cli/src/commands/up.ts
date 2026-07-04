import { addAgent } from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { logger } from '@quimbyhq/utils'
import {
  addSubscriptionToState,
  ensureWorkspace,
  loadQuimbyConfig,
  loadState,
  normalizeCheck,
  resolveAgentRoleConfig,
  resolveConfiguredAgent,
  resolveHostAlias,
  resolveRecipe,
  saveState,
} from '@quimbyhq/workspace'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Create missing agents and subscriptions from a configured recipe',
  },
  args: {
    recipe: {
      type: 'positional',
      description: 'Recipe name from quimby.yaml',
      required: true,
    },
  },
  run: runUpCommand,
})

export async function runUpCommand({ args }: { args: { recipe: string } }) {
  const repoRoot = await git.findRoot(process.cwd())
  if (!repoRoot) throw new QuimbyError('Not inside a git repository.')

  await ensureWorkspace(repoRoot)
  const config = await loadQuimbyConfig(repoRoot)
  const recipe = resolveRecipe(config, args.recipe)

  for (const [name, rawAgent] of Object.entries(recipe.agents ?? {})) {
    const state = await loadState(repoRoot)
    if (state.agents[name]) {
      logger.info(`Agent "${name}" already exists`)
      continue
    }
    const configured = resolveConfiguredAgent(config, rawAgent)
    const role = resolveAgentRoleConfig(config, configured)
    const check = normalizeCheck(role.check)
    // Assert the alias is declared, then store the reference (resolved to a concrete
    // host at launch) rather than a flattened address, keeping the address out of state.
    if (configured.hostAlias) resolveHostAlias(config, configured.hostAlias)
    const location =
      configured.location ??
      (configured.hostAlias ? { type: 'ssh' as const, alias: configured.hostAlias } : undefined)
    await addAgent(repoRoot, name, {
      defaults:
        role.runtimeProfile || role.runtime || role.entrypoint
          ? {
              ...(role.runtimeProfile ? { runtimeProfile: role.runtimeProfile } : {}),
              runtime: role.runtime,
              entrypoint: role.entrypoint,
            }
          : undefined,
      ...(location ? { location } : {}),
      ...(role.syncRef ? { syncRef: role.syncRef } : {}),
      ...(role.tmux ? { tmux: true } : {}),
      ...(check?.command ? { check: check.command } : {}),
      ...((check?.verifyByDefault ?? role.verifyByDefault) ? { verifyByDefault: true } : {}),
    })
    logger.success(`Agent "${name}" created${configured.role ? ` (${configured.role})` : ''}`)
  }

  const state = await loadState(repoRoot)
  let changed = false
  for (const [subscriber, targets] of Object.entries(recipe.subscriptions ?? {})) {
    if (!state.agents[subscriber]) throw new QuimbyError(`Agent "${subscriber}" not found`)
    for (const target of targets) {
      if (!state.agents[target]) throw new QuimbyError(`Agent "${target}" not found`)
      if (subscriber === target) continue
      changed = addSubscriptionToState(state, subscriber, target) || changed
    }
  }
  if (changed) {
    await saveState(repoRoot, state)
    logger.success(`Subscriptions updated for recipe "${args.recipe}"`)
  }
}
