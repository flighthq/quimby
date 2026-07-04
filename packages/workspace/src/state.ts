import { getStatePath } from '@quimbyhq/paths'
import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { readYaml, writeYaml } from '@quimbyhq/utils'

export async function loadState(repoRoot: string): Promise<QuimbyState> {
  return readYaml<QuimbyState>(getStatePath(repoRoot))
}

export async function saveState(repoRoot: string, state: QuimbyState): Promise<void> {
  await writeYaml(getStatePath(repoRoot), state)
}

/**
 * Reconcile legacy schema keys in place so older state files load cleanly: the
 * `workers`→`agents` and `defaults.agent`→`defaults.entrypoint` renames, plus scrubbing the
 * dropped `subscriptions` map (status now mirrors to every agent, so subscriptions no longer
 * exist). Returns true when something was migrated (the caller persists the result).
 */
export function migrateState(state: QuimbyState): boolean {
  let dirty = false
  const loose = state as QuimbyState & {
    workers?: QuimbyState['agents']
    subscriptions?: Record<string, string[]>
  }

  if (loose.workers && !state.agents) {
    state.agents = loose.workers
    delete loose.workers
    dirty = true
  }

  if (loose.subscriptions !== undefined) {
    delete loose.subscriptions
    dirty = true
  }

  for (const agent of Object.values(state.agents ?? {})) {
    const looseAgent = agent as AgentState & {
      defaults?: { agent?: string }
    }
    if (looseAgent.defaults?.agent && !looseAgent.defaults.entrypoint) {
      looseAgent.defaults.entrypoint = looseAgent.defaults.agent
      delete looseAgent.defaults.agent
      dirty = true
    }
  }

  return dirty
}
