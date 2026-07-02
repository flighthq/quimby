import type { AgentState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { resolveRuntimeSelection } from './runtime'

function agent(defaults?: { runtime?: string; entrypoint?: string }): AgentState {
  return { id: 'a1', name: 'builder', location: { type: 'local' }, defaults } as AgentState
}

describe('resolveRuntimeSelection', () => {
  it('defaults to the local runtime and claude entrypoint with no overrides or saved defaults', () => {
    const sel = resolveRuntimeSelection({ agent: agent() })
    expect(sel).toEqual({ runtime: 'local', entrypoint: 'claude', runtimeLabel: '' })
  })

  it('prefers explicit overrides over saved defaults', () => {
    const sel = resolveRuntimeSelection({
      agent: agent({ runtime: 'local', entrypoint: 'saved' }),
      runtime: 'sbx',
      cmd: 'claude --resume',
    })
    expect(sel).toMatchObject({ runtime: 'sbx', entrypoint: 'claude --resume' })
  })

  it('falls back to saved defaults when no override is given', () => {
    const sel = resolveRuntimeSelection({ agent: agent({ runtime: 'sbx', entrypoint: 'saved' }) })
    expect(sel).toMatchObject({ runtime: 'sbx', entrypoint: 'saved' })
  })

  it('adds a runtime label only for a non-default runtime', () => {
    expect(resolveRuntimeSelection({ agent: agent(), runtime: 'sbx' }).runtimeLabel).toBe(' [sbx]')
    expect(resolveRuntimeSelection({ agent: agent(), runtime: 'local' }).runtimeLabel).toBe('')
  })

  it('throws on an unknown runtime before any launch work', () => {
    expect(() => resolveRuntimeSelection({ agent: agent(), runtime: 'bogus' })).toThrow(
      /Unknown runtime/,
    )
  })
})
