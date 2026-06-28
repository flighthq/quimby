import type { RuntimeAdapter, RuntimeContext, RuntimeType } from '@quimbyhq/types'

import { getWorkerDir, getWorkerRepoDir } from '../utils/paths'
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
  workerName: string,
  projectId: string,
  workerId: string,
): RuntimeContext {
  return {
    projectId,
    workerId,
    workerName,
    workerDir: getWorkerDir(repoRoot, workerName),
    repoDir: getWorkerRepoDir(repoRoot, workerName),
    repoRoot,
  }
}
