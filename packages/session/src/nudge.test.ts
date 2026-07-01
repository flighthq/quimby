import type { AgentState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { hasAgentSession, nudgeAgentSession } from './nudge'

const localNoTmux: AgentState = {
  id: 'a1',
  name: 'builder',
  location: { type: 'local' },
} as AgentState

const localWithTmux: AgentState = {
  id: 'a2',
  name: 'reviewer',
  location: { type: 'local' },
  tmux: true,
} as AgentState

describe('hasAgentSession', () => {
  it('is false for a local agent without tmux', async () => {
    expect(await hasAgentSession(localNoTmux)).toBe(false)
  })

  it('attempts tmux has-session for a tmux-enabled local agent', async () => {
    // No quimby tmux server is running in test, so has-session returns false
    expect(await hasAgentSession(localWithTmux)).toBe(false)
  })
})

describe('nudgeAgentSession', () => {
  it('no-ops for a local agent without tmux', async () => {
    await expect(
      nudgeAgentSession({ agent: localNoTmux, displayName: 'builder', text: 'continue' }),
    ).resolves.toBeUndefined()
  })

  it('warns gracefully when the tmux session is not running', async () => {
    // No quimby tmux server in test — the nudge should warn but not throw
    await expect(
      nudgeAgentSession({ agent: localWithTmux, displayName: 'reviewer', text: 'continue' }),
    ).resolves.toBeUndefined()
  })
})
