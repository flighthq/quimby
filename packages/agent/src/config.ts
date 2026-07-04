import { QuimbyError } from '@quimbyhq/errors'
import type { AgentDefaults, AgentLocation } from '@quimbyhq/types'
import { loadState, saveState } from '@quimbyhq/workspace'

export async function setAgentCheckCommand(
  repoRoot: string,
  name: string,
  check: string | undefined,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  if (check) {
    state.agents[name].check = check
  } else {
    delete state.agents[name].check
  }
  await saveState(repoRoot, state)
}

export async function setAgentVerifyByDefault(
  repoRoot: string,
  name: string,
  verifyByDefault: boolean | undefined,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  if (verifyByDefault) {
    state.agents[name].verifyByDefault = true
  } else {
    delete state.agents[name].verifyByDefault
  }
  await saveState(repoRoot, state)
}

export async function setAgentDefaults(
  repoRoot: string,
  name: string,
  updates: AgentDefaults,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  const next = { ...(state.agents[name].defaults ?? {}) }
  for (const [key, value] of Object.entries(updates) as [
    keyof AgentDefaults,
    string | undefined,
  ][]) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  state.agents[name].defaults = next
  await saveState(repoRoot, state)
}

export async function setAgentLocation(
  repoRoot: string,
  name: string,
  location: AgentLocation,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].location = location
  await saveState(repoRoot, state)
}

/** Attach (or, with `""`, detach) the config role an agent resolves its launch config through. */
export async function setAgentRole(
  repoRoot: string,
  name: string,
  role: string | undefined,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  if (role) state.agents[name].role = role
  else delete state.agents[name].role
  await saveState(repoRoot, state)
}

export async function setAgentSyncRef(
  repoRoot: string,
  name: string,
  syncRef: string,
): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  state.agents[name].syncRef = syncRef
  await saveState(repoRoot, state)
}

export async function setAgentTmux(repoRoot: string, name: string, tmux: boolean): Promise<void> {
  const state = await loadState(repoRoot)
  if (!Object.hasOwn(state.agents, name)) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }
  if (tmux) {
    state.agents[name].tmux = true
  } else {
    delete state.agents[name].tmux
  }
  await saveState(repoRoot, state)
}
