import type { AgentState, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const saveState = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@quimbyhq/workspace', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  saveState,
}))

import {
  currentLaunchFingerprint,
  hasLaunchDrifted,
  launchDrift,
  recordLaunchFingerprint,
  warnIfLaunchDrifted,
} from './launchDrift'

// A plain local agent resolves to the built-in `local claude`; `defaults` overrides that.
function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'builder',
    seedCommit: 'seed',
    createdAt: '2025-01-01',
    location: { type: 'local' },
    ...overrides,
  } as AgentState
}

const noConfig: QuimbyConfig = {} as QuimbyConfig

afterEach(() => {
  vi.restoreAllMocks()
  saveState.mockClear()
})

describe('currentLaunchFingerprint', () => {
  it('fingerprints a plain agent as the built-in `local claude`', () => {
    expect(currentLaunchFingerprint(agent(), noConfig)).toBe('local claude')
  })

  it('reflects the agent stored defaults (runtime + entrypoint)', () => {
    const fp = currentLaunchFingerprint(
      agent({ defaults: { runtime: 'sbx', entrypoint: 'codex' } }),
      noConfig,
    )
    expect(fp).toBe('sbx codex')
  })

  it('tracks the resolved command, not the role name (two role names, same command, one fingerprint)', () => {
    const a = currentLaunchFingerprint(
      agent({ defaults: { runtime: 'sbx', entrypoint: 'claude' } }),
      noConfig,
    )
    const b = currentLaunchFingerprint(
      agent({ defaults: { runtime: 'sbx', entrypoint: 'claude' } }),
      noConfig,
    )
    expect(a).toBe(b)
  })
})

describe('hasLaunchDrifted', () => {
  it('returns true when the recorded launch differs from current config', () => {
    expect(
      hasLaunchDrifted(
        agent({ launchedWith: 'local claude', defaults: { runtime: 'sbx', entrypoint: 'codex' } }),
        noConfig,
      ),
    ).toBe(true)
  })
})

describe('launchDrift', () => {
  it('detects stale stored defaults when a role now resolves to a different profile', () => {
    const config = {
      roles: { review2: { runtimeProfile: 'sbx-codex' } },
      runtimeProfiles: { 'sbx-codex': { runtime: 'sbx', entrypoint: 'codex' } },
    } as QuimbyConfig
    const drift = launchDrift(
      agent({
        name: 'review2',
        role: 'review2',
        defaults: { runtimeProfile: 'sbx-claude', runtime: 'sbx', entrypoint: 'claude' },
      }),
      config,
    )
    expect(drift).toEqual({ actual: 'sbx claude', desired: 'sbx codex' })
  })

  it('detects stale stored defaults through a same-named role when no role is stored', () => {
    const config = {
      roles: { review2: { runtimeProfile: 'sbx-codex' } },
      runtimeProfiles: { 'sbx-codex': { runtime: 'sbx', entrypoint: 'codex' } },
    } as QuimbyConfig
    const drift = launchDrift(
      agent({
        name: 'review2',
        defaults: { runtimeProfile: 'sbx-claude', runtime: 'sbx', entrypoint: 'claude' },
      }),
      config,
    )
    expect(drift).toEqual({ actual: 'sbx claude', desired: 'sbx codex' })
  })

  it('treats a missing stored profile as stale state instead of throwing', () => {
    const config = {
      defaults: { runtimeProfile: 'claude-sbx' },
      roles: { review: {} },
      runtimeProfiles: {
        'claude-sbx': { runtime: 'sbx', entrypoint: 'claude' },
        'codex-sbx': { runtime: 'sbx', entrypoint: 'codex' },
      },
      presets: {
        default: {
          agents: {
            review2: { role: 'review', runtimeProfile: 'codex-sbx' },
          },
        },
      },
      default: 'default',
    } as QuimbyConfig
    const drift = launchDrift(
      agent({
        name: 'review2',
        role: 'review2',
        defaults: { runtimeProfile: 'sbx-codex' },
      }),
      config,
    )
    expect(drift).toEqual({
      actual: 'missing runtime profile sbx-codex',
      desired: 'sbx codex',
    })
  })
})

describe('recordLaunchFingerprint', () => {
  it('records the resolved fingerprint and persists when it was previously unset', async () => {
    const state = {
      agents: { builder: agent({ defaults: { runtime: 'sbx', entrypoint: 'codex' } }) },
    } as unknown as QuimbyState
    await recordLaunchFingerprint('/repo', state, 'builder', noConfig)
    expect(state.agents.builder.launchedWith).toBe('sbx codex')
    expect(saveState).toHaveBeenCalledWith('/repo', state)
  })

  it('does not save when the stored fingerprint already matches (no redundant write)', async () => {
    const state = {
      agents: { builder: agent({ launchedWith: 'local claude' }) },
    } as unknown as QuimbyState
    await recordLaunchFingerprint('/repo', state, 'builder', noConfig)
    expect(state.agents.builder.launchedWith).toBe('local claude')
    expect(saveState).not.toHaveBeenCalled()
  })

  it('overwrites and persists a stale stored fingerprint', async () => {
    const state = {
      agents: {
        builder: agent({
          defaults: { runtime: 'sbx', entrypoint: 'codex' },
          launchedWith: 'local claude',
        }),
      },
    } as unknown as QuimbyState
    await recordLaunchFingerprint('/repo', state, 'builder', noConfig)
    expect(state.agents.builder.launchedWith).toBe('sbx codex')
    expect(saveState).toHaveBeenCalledOnce()
  })

  it('records one-shot launch overrides instead of the saved defaults', async () => {
    const state = {
      agents: { builder: agent({ defaults: { runtime: 'local', entrypoint: 'claude' } }) },
    } as unknown as QuimbyState
    await recordLaunchFingerprint('/repo', state, 'builder', noConfig, {
      runtime: 'sbx',
      cmd: 'codex',
    })
    expect(state.agents.builder.launchedWith).toBe('sbx codex')
  })
})

describe('warnIfLaunchDrifted', () => {
  it('warns when the live command differs from what config now resolves to', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    // Launched with `local claude`, but defaults now resolve to `sbx codex`.
    warnIfLaunchDrifted(
      agent({ launchedWith: 'local claude', defaults: { runtime: 'sbx', entrypoint: 'codex' } }),
      noConfig,
    )
    expect(warn).toHaveBeenCalledOnce()
    const msg = warn.mock.calls[0][0] as string
    expect(msg).toContain('local claude')
    expect(msg).toContain('sbx codex')
    expect(msg).toContain('quimby restart builder')
  })

  it('stays silent when the live command matches the resolved command', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    warnIfLaunchDrifted(agent({ launchedWith: 'local claude' }), noConfig)
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays silent when the agent has no recorded launch fingerprint (never started)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    warnIfLaunchDrifted(agent({ defaults: { runtime: 'sbx', entrypoint: 'codex' } }), noConfig)
    expect(warn).not.toHaveBeenCalled()
  })
})
