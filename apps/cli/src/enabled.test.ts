import { QuimbyError } from '@quimbyhq/errors'
import type { AgentState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { assertAgentEnabled } from './enabled'

function agent(enabled?: boolean): AgentState {
  return { id: 'a1', name: 'builder', enabled } as AgentState
}

describe('assertAgentEnabled', () => {
  // `run`/`start`/`restart` name an agent directly and consulted nothing, so the session came
  // straight back while `quimby list` still reported the agent as shelved.
  it('refuses a disabled agent and names the way back', () => {
    expect(() => assertAgentEnabled(agent(false), 'builder')).toThrow(QuimbyError)
    expect(() => assertAgentEnabled(agent(false), 'builder')).toThrow(/quimby enable builder/)
  })

  it('allows an agent with the flag absent, which is the default', () => {
    expect(() => assertAgentEnabled(agent(), 'builder')).not.toThrow()
  })

  it('allows an explicitly enabled agent', () => {
    expect(() => assertAgentEnabled(agent(true), 'builder')).not.toThrow()
  })
})
