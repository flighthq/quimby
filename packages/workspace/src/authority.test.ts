import type { AgentState, QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import {
  directsRecipient,
  escalationTargets,
  honorsEscalation,
  resolveAgentFocusPolicy,
  resolveConfiguredAgentEdges,
  resolveConfiguredAgentRole,
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

describe('resolveAgentFocusPolicy', () => {
  const chain = {
    agents: {
      principal: { name: 'principal', directs: ['manager'] },
      manager: { name: 'manager', directs: ['@builder'] },
      builder: { name: 'builder', role: 'builder' },
      'builder-2': { name: 'builder-2', role: 'builder' },
    },
  } as never

  it('holds only the agent nobody directs — "wake all but the one I talk to", from the graph', () => {
    expect(resolveAgentFocusPolicy({}, chain, 'principal')).toBe('hold')
    expect(resolveAgentFocusPolicy({}, chain, 'manager')).toBe('nudge')
    expect(resolveAgentFocusPolicy({}, chain, 'builder')).toBe('nudge')
    // reached through a @role slot, so the expansion has to be honored here too
    expect(resolveAgentFocusPolicy({}, chain, 'builder-2')).toBe('nudge')
  })

  it('holds every agent in a graph with no edges at all', () => {
    const flat = { agents: { a: { name: 'a' }, b: { name: 'b' } } } as never
    expect(resolveAgentFocusPolicy({}, flat, 'a')).toBe('hold')
  })

  it('lets an explicit workspace policy override the derivation in both directions', () => {
    expect(resolveAgentFocusPolicy({ whenFocused: 'nudge' }, chain, 'principal')).toBe('nudge')
    expect(resolveAgentFocusPolicy({ whenFocused: 'hold' }, chain, 'builder')).toBe('hold')
  })

  it("lets an agent's own stored policy beat the workspace default", () => {
    const pinned = {
      agents: { principal: { name: 'principal', directs: ['m'], whenFocused: 'nudge' } },
    } as never
    expect(resolveAgentFocusPolicy({ whenFocused: 'hold' }, pinned, 'principal')).toBe('nudge')
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

  it('carries `whenFocused` from the entry, overriding the role', () => {
    const withFocus: QuimbyConfig = {
      roles: { builder: { whenFocused: 'hold' } },
      presets: {
        fleet: {
          agents: {
            builder: { role: 'builder' },
            review: { role: 'builder', whenFocused: 'nudge' },
          },
        },
      },
    }
    expect(resolveConfiguredAgentEdges(withFocus, { name: 'builder' })).toEqual({
      whenFocused: 'hold',
    })
    expect(resolveConfiguredAgentEdges(withFocus, { name: 'review' })).toEqual({
      whenFocused: 'nudge',
    })
  })

  it('declares an agent whose role sets only `whenFocused` — not null, so the edge reaches it', () => {
    const roleOnly: QuimbyConfig = { roles: { builder: { whenFocused: 'nudge' } } }
    expect(resolveConfiguredAgentEdges(roleOnly, { name: 'b1', role: 'builder' })).toEqual({
      whenFocused: 'nudge',
    })
  })

  it('drops an unrecognized `whenFocused` rather than storing a value the guard would miss', () => {
    const bad: QuimbyConfig = {
      presets: { fleet: { agents: { review: { whenFocused: 'off' as 'hold' } } } },
    }
    expect(resolveConfiguredAgentEdges(bad, { name: 'review' })).toEqual({})
  })
})

describe('resolveConfiguredAgentRole', () => {
  const config: QuimbyConfig = {
    presets: {
      fleet: {
        agents: {
          builder2: { role: 'builder' },
          reviewer: 'review', // string shorthand is a role reference
          builder: { role: 'builder', count: 4 },
        },
      },
    },
  }

  it('reads the role config declares for an agent', () => {
    expect(resolveConfiguredAgentRole(config, 'builder2')).toBe('builder')
    expect(resolveConfiguredAgentRole(config, 'reviewer')).toBe('review')
  })

  it('covers a count-expanded replica', () => {
    expect(resolveConfiguredAgentRole(config, 'builder-3')).toBe('builder')
  })

  it('is undefined for an agent no preset declares, so a hand-set role survives', () => {
    expect(resolveConfiguredAgentRole(config, 'stray')).toBeUndefined()
  })
})

describe('resolveDirectedRecipients', () => {
  it('expands a @role slot to every instance of that role', () => {
    expect(resolveDirectedRecipients(state, 'manager').sort()).toEqual(['builder1', 'builder2'])
    expect(resolveDirectedRecipients(state, 'principal')).toEqual(['manager'])
    expect(resolveDirectedRecipients(state, 'builder1')).toEqual([])
  })
})
