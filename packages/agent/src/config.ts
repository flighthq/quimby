import { QuimbyError } from '@quimbyhq/errors'
import type { AgentLocation } from '@quimbyhq/types'
import { loadState, saveState } from '@quimbyhq/workspace'

export async function setAgentDefaults(
  repoRoot: string,
  name: string,
  updates: { runtime?: string; entrypoint?: string },
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].defaults = { ...state.agents[name].defaults, ...updates }
  await saveState(repoRoot, state)
}

export async function setAgentLocation(
  repoRoot: string,
  name: string,
  location: AgentLocation,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].location = location
  await saveState(repoRoot, state)
}

export async function setAgentSyncRef(
  repoRoot: string,
  name: string,
  syncRef: string,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].syncRef = syncRef
  await saveState(repoRoot, state)
}

export async function setAgentTmux(repoRoot: string, name: string, tmux: boolean): Promise<void> {
  const state = await loadState(repoRoot)
  if (!state.agents[name]) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  if (tmux) {
    state.agents[name].tmux = true
  } else {
    delete state.agents[name].tmux
  }
  await saveState(repoRoot, state)
}
