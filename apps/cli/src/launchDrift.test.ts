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
