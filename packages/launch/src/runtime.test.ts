import type { AgentState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { launchFingerprint, resolveAgentLaunchDefaults, resolveRuntimeSelection } from './runtime'

function agent(
  defaults?: {
    runtimeProfile?: string
    runtime?: string
    entrypoint?: string
  },
  role?: string,
): AgentState {
  return { id: 'a1', name: 'builder', location: { type: 'local' }, defaults, role } as AgentState
}

const roleConfig = {
  roles: { builder: { runtimeProfile: 'sbx-codex' } },
  runtimeProfiles: { 'sbx-codex': { runtime: 'sbx', entrypoint: 'codex' } },
}

describe('launchFingerprint', () => {
  it('is stable for the same resolved command and differs when it changes', () => {
    expect(launchFingerprint({ runtime: 'sbx', entrypoint: 'codex' })).toBe('sbx codex')
    expect(launchFingerprint({ runtime: 'sbx', entrypoint: 'codex' })).toBe(
      launchFingerprint({ runtime: 'sbx', entrypoint: 'codex' }),
    )
    expect(launchFingerprint({ runtime: 'sbx', entrypoint: 'codex' })).not.toBe(
      launchFingerprint({ runtime: 'local', entrypoint: 'claude' }),
    )
  })
})

describe('resolveAgentLaunchDefaults', () => {
  it('prefers role-resolved defaults, including a same-named role for older state without `role`', () => {
    expect(resolveAgentLaunchDefaults(agent({ runtime: 'sbx' }, 'builder'), roleConfig)).toEqual({
      runtimeProfile: 'sbx-codex',
    })
    expect(resolveAgentLaunchDefaults(agent({ runtime: 'sbx' }), roleConfig)).toEqual({
      runtimeProfile: 'sbx-codex',
    })
  })

  it('falls back to stored defaults without a matching role', () => {
    expect(
      resolveAgentLaunchDefaults(
        { ...agent({ runtime: 'sbx' }), name: 'review2' } as AgentState,
        roleConfig,
      ),
    ).toEqual({
      runtime: 'sbx',
    })
  })
})

describe('resolveRuntimeSelection', () => {
  it('defaults to the local runtime and claude entrypoint with no overrides or saved defaults', () => {
    const sel = resolveRuntimeSelection({ agent: agent() })
    expect(sel).toMatchObject({ runtime: 'local', entrypoint: 'claude', runtimeLabel: '' })
    expect(sel.requiredTools).toEqual([])
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

  it('resolves a saved runtime profile from config', () => {
    const sel = resolveRuntimeSelection({
      agent: agent({ runtimeProfile: 'ollama' }),
      config: {
        runtimeProfiles: {
          ollama: {
            runtime: 'openshell',
            entrypoint: 'codex',
            provider: 'ollama',
            ollama: { host: 'http://gpu:11434' },
          },
        },
      },
    })
    expect(sel).toMatchObject({
      runtime: 'openshell',
      entrypoint: 'codex',
      env: { OLLAMA_HOST: 'http://gpu:11434' },
      requiredTools: ['openshell', 'ollama'],
    })
  })

  it('resolves role-fresh from config, ignoring a stale flattened profile name', () => {
    // The agent stores a now-renamed profile in `defaults`, but its `role` resolves to the
    // current profile — so the launch tracks config, not the frozen name.
    const sel = resolveRuntimeSelection({
      agent: agent({ runtimeProfile: 'sbx-codex-OLD' }, 'builder'),
      config: roleConfig,
    })
    expect(sel).toMatchObject({ runtime: 'sbx', entrypoint: 'codex' })
  })

  it('resolves a same-named role for older agents missing a stored role reference', () => {
    const sel = resolveRuntimeSelection({
      agent: agent({ runtimeProfile: 'sbx-claude', runtime: 'sbx', entrypoint: 'claude' }),
      config: roleConfig,
    })
    expect(sel).toMatchObject({ runtime: 'sbx', entrypoint: 'codex' })
  })

  it('falls back to stored defaults when the role no longer resolves', () => {
    const sel = resolveRuntimeSelection({
      agent: agent({ runtime: 'sbx', entrypoint: 'saved' }, 'deleted-role'),
      config: roleConfig,
    })
    expect(sel).toMatchObject({ runtime: 'sbx', entrypoint: 'saved' })
  })
})
