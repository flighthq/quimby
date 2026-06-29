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
 * Rename legacy schema keys in place so state files predating the `workers`→`agents`,
 * `defaults.agent`→`defaults.entrypoint`, and `check`→`guard` renames load cleanly.
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
    }
    if (looseAgent.defaults?.agent && !looseAgent.defaults.entrypoint) {
      looseAgent.defaults.entrypoint = looseAgent.defaults.agent
      delete looseAgent.defaults.agent
      dirty = true
    }
    if (looseAgent.check && !looseAgent.guard) {
      looseAgent.guard = looseAgent.check
      delete looseAgent.check
      dirty = true
    }
  }

  return dirty
}
