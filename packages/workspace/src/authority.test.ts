import type { AgentState, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import {
  directsRecipient,
  escalationTargets,
  honorsEscalation,
  resolveConfiguredAgentEdges,
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

describe('escalationTargets', () => {
  it('defaults to the inverse of directs — every agent that directs you', () => {
    expect(escalationTargets(state, 'builder1')).toEqual(['manager'])
    expect(escalationTargets(state, 'manager')).toEqual(['principal'])
  })

  it('is empty for an agent nothing directs', () => {
    expect(escalationTargets(state, 'principal')).toEqual([])
  })

  it('honors an explicit override, as a bare string or an allow-list', () => {
    expect(escalationTargets(state, 'builder2')).toEqual(['critic'])
    const listed = fleet({
      manager: { directs: ['@builder'] },
      builder1: { role: 'builder', escalatesTo: ['manager', 'critic', 'integration'] },
      critic: {},
      integration: {},
    })
    expect(escalationTargets(listed, 'builder1')).toEqual(['manager', 'critic', 'integration'])
  })

  it('expands a @role slot in the allow-list', () => {
    const listed = fleet({
      review1: { role: 'review' },
      review2: { role: 'review' },
      builder1: { role: 'builder', escalatesTo: ['@review', 'integration'] },
      integration: {},
    })
    expect(escalationTargets(listed, 'builder1').sort()).toEqual([
      'integration',
      'review1',
      'review2',
    ])
  })

  it('falls back to the directors when the override list is empty', () => {
    const listed = fleet({ boss: { directs: ['worker'] }, worker: { escalatesTo: [] } })
    expect(escalationTargets(listed, 'worker')).toEqual(['boss'])
  })
})

describe('honorsEscalation', () => {
  it('permits an escalation only to a permitted target', () => {
    expect(honorsEscalation(state, 'builder1', 'manager')).toBe(true)
    expect(honorsEscalation(state, 'builder1', 'principal')).toBe(false)
    expect(honorsEscalation(state, 'builder2', 'critic')).toBe(true)
  })

  it('permits any member of an allow-list — one per escalation, never all at once', () => {
    const listed = fleet({
      review1: { directs: ['@builder'] },
      review2: {},
      integration: {},
      builder1: { role: 'builder', escalatesTo: ['review1', 'review2', 'integration'] },
    })
    expect(honorsEscalation(listed, 'builder1', 'review2')).toBe(true)
    expect(honorsEscalation(listed, 'builder1', 'integration')).toBe(true)
    // and the asymmetry holds: receiving an escalation grants no authority back
    expect(directsRecipient(listed, 'review2', 'builder1')).toBe(false)
  })
})

describe('resolveConfiguredAgentEdges', () => {
  const config: QuimbyConfig = {
    roles: { builder: { directs: ['@tester'] } },
    presets: {
      fleet: {
        agents: {
          manager: { role: 'manager', directs: ['@builder'], escalatesTo: 'principal' },
          builder: { role: 'builder', count: 3 },
          critic: { role: 'critic' },
        },
      },
    },
  }

  it('reads the edges off an agent’s own preset entry', () => {
    expect(resolveConfiguredAgentEdges(config, { name: 'manager' })).toEqual({
      directs: ['@builder'],
      escalatesTo: 'principal',
    })
  })

  it('falls back to the role’s edges for a replica the entry expanded', () => {
    expect(resolveConfiguredAgentEdges(config, { name: 'builder-3' })).toEqual({
      directs: ['@tester'],
    })
    // beyond the declared count, so no entry claims it — but its stored role still does
    expect(resolveConfiguredAgentEdges(config, { name: 'builder-9', role: 'builder' })).toEqual({
      directs: ['@tester'],
    })
  })

  it('returns an empty object for a declared agent with no edges, so a removed edge clears', () => {
    expect(resolveConfiguredAgentEdges(config, { name: 'critic' })).toEqual({})
  })

  it('returns null when nothing in config declares the agent', () => {
    expect(resolveConfiguredAgentEdges(config, { name: 'stray' })).toBeNull()
    expect(resolveConfiguredAgentEdges({}, { name: 'manager' })).toBeNull()
  })
})

describe('resolveDirectedRecipients', () => {
  it('expands a @role slot to every instance of that role', () => {
    expect(resolveDirectedRecipients(state, 'manager').sort()).toEqual(['builder1', 'builder2'])
    expect(resolveDirectedRecipients(state, 'principal')).toEqual(['manager'])
    expect(resolveDirectedRecipients(state, 'builder1')).toEqual([])
  })
})
