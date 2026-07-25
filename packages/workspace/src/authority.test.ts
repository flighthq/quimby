import type { AgentState, QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import {
  directsRecipient,
  escalationTarget,
  honorsEscalation,
  resolveDirectedRecipients,
} from './authority'

function fleet(agents: Record<string, Partial<AgentState>>): QuimbyState {
  const full: Record<string, AgentState> = {}
  for (const [name, a] of Object.entries(agents)) {
    full[name] = { id: name, name, seedCommit: 's', createdAt: 't', ...a } as AgentState
  }
  return { id: 'p', agents: full } as unknown as QuimbyState
}

// principal → manager → @builder; builder2 escalates to critic instead of its director.
const state = fleet({
  principal: { directs: ['manager'] },
  manager: { directs: ['@builder'] },
  builder1: { role: 'builder' },
  builder2: { role: 'builder', escalatesTo: 'critic' },
  critic: {},
})

describe('directsRecipient', () => {
  it('is true along a declared edge (name or @role) and false otherwise', () => {
    expect(directsRecipient(state, 'principal', 'manager')).toBe(true)
    expect(directsRecipient(state, 'manager', 'builder1')).toBe(true)
    expect(directsRecipient(state, 'builder1', 'manager')).toBe(false)
    expect(directsRecipient(state, 'manager', 'critic')).toBe(false)
  })
})

describe('escalationTarget', () => {
  it('defaults to the inverse of directs and honors an escalatesTo override', () => {
    expect(escalationTarget(state, 'builder1')).toBe('manager')
    expect(escalationTarget(state, 'manager')).toBe('principal')
    expect(escalationTarget(state, 'builder2')).toBe('critic')
    expect(escalationTarget(state, 'principal')).toBeUndefined()
  })
})

describe('honorsEscalation', () => {
  it('permits an escalation only to the sender’s escalation target', () => {
    expect(honorsEscalation(state, 'builder1', 'manager')).toBe(true)
    expect(honorsEscalation(state, 'builder1', 'principal')).toBe(false)
    expect(honorsEscalation(state, 'builder2', 'critic')).toBe(true)
  })
})

describe('resolveDirectedRecipients', () => {
  it('expands a @role slot to every instance of that role', () => {
    expect(resolveDirectedRecipients(state, 'manager').sort()).toEqual(['builder1', 'builder2'])
    expect(resolveDirectedRecipients(state, 'principal')).toEqual(['manager'])
    expect(resolveDirectedRecipients(state, 'builder1')).toEqual([])
  })
})
