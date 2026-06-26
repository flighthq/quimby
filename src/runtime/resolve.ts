import type { RuntimeAdapter } from './types.js'
import { dockerSandboxAdapter } from './docker-sandbox.js'
import { openshellAdapter } from './openshell.js'
import { remoteAdapter } from './remote.js'
import { AoError } from '../utils/errors.js'

const builtinAdapters: Record<string, RuntimeAdapter> = {
  'docker-sandbox': dockerSandboxAdapter,
  'openshell': openshellAdapter,
  'remote': remoteAdapter,
}

export function resolveAdapter(type: string): RuntimeAdapter {
  const adapter = builtinAdapters[type]
  if (!adapter) {
    throw new AoError(
      `Unknown runtime type "${type}". Available: ${Object.keys(builtinAdapters).join(', ')}`,
    )
  }
  return adapter
}
