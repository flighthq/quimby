import { getAgentDir, getAgentRepoDir } from '@quimbyhq/paths'
import type { RuntimeAdapter, RuntimeContext, RuntimeType } from '@quimbyhq/types'

import { local } from './local'
import { openshell } from './openshell'
import { sbx } from './sbx'

const adapters: Record<RuntimeType, RuntimeAdapter> = {
  local,
  sbx,
  openshell,
}

export const runtimeTypes = Object.keys(adapters) as RuntimeType[]

export function getRuntime(type: RuntimeType): RuntimeAdapter {
  const adapter = adapters[type]
  if (!adapter) {
    throw new Error(`Unknown runtime: ${type}. Available: ${runtimeTypes.join(', ')}`)
  }
  return adapter
}

export function buildContext(
  repoRoot: string,
  agentName: string,
  projectId: string,
  agentId: string,
): RuntimeContext {
  return {
    projectId,
    agentId,
    agentName,
    agentDir: getAgentDir(repoRoot, agentName),
    repoDir: getAgentRepoDir(repoRoot, agentName),
    repoRoot,
  }
}
