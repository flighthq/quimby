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
 * `workers`→`agents` and `defaults.agent`→`defaults.entrypoint` renames, plus
 * dropping the removed per-agent guard (and its even older `check` alias) — guards
 * were retired because quimby runs on the host, outside the agent's sandbox, so it
 * could never run the guard in the environment where deps were installed.
 * Returns true when something was migrated (the caller persists the result).
 */
export function migrateState(state: QuimbyState): boolean {
  let dirty = false
  const loose = state as QuimbyState & {
    workers?: QuimbyState['agents']
  }

  if (loose.workers && !state.agents) {
    state.agents = loose.workers
    delete loose.workers
    dirty = true
  }

  for (const agent of Object.values(state.agents ?? {})) {
    const looseAgent = agent as AgentState & {
      defaults?: { agent?: string }
      check?: string
      guard?: string
    }
    if (looseAgent.defaults?.agent && !looseAgent.defaults.entrypoint) {
      looseAgent.defaults.entrypoint = looseAgent.defaults.agent
      delete looseAgent.defaults.agent
      dirty = true
    }
    if (looseAgent.guard !== undefined || looseAgent.check !== undefined) {
      delete looseAgent.guard
      delete looseAgent.check
      dirty = true
    }
  }

  return dirty
}
