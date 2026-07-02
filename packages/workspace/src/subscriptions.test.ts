import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import {
  addSubscriptionToState,
  removeAgentFromSubscriptions,
  removeSubscriptionFromState,
  renameAgentInSubscriptions,
} from './subscriptions'

function state(subscriptions: Record<string, string[]> = {}): QuimbyState {
  return { id: 'p', agents: {}, subscriptions } as unknown as QuimbyState
}

describe('addSubscriptionToState', () => {
  it('adds a new target and reports the change', () => {
    const s = state()
    expect(addSubscriptionToState(s, 'reviewer', 'backend')).toBe(true)
    expect(s.subscriptions).toEqual({ reviewer: ['backend'] })
  })

  it('is a no-op when already subscribed', () => {
    const s = state({ reviewer: ['backend'] })
    expect(addSubscriptionToState(s, 'reviewer', 'backend')).toBe(false)
    expect(s.subscriptions!.reviewer).toEqual(['backend'])
  })

  it('appends a second distinct target', () => {
    const s = state({ reviewer: ['backend'] })
    expect(addSubscriptionToState(s, 'reviewer', 'frontend')).toBe(true)
    expect(s.subscriptions!.reviewer).toEqual(['backend', 'frontend'])
  })
})

describe('removeAgentFromSubscriptions', () => {
  it('drops the removed agent as a subscriber key', () => {
    const s = state({ backend: ['db'], reviewer: ['frontend'] })
    expect(removeAgentFromSubscriptions(s, 'backend')).toBe(true)
    expect(s.subscriptions).toEqual({ reviewer: ['frontend'] })
  })

  it('removes the agent as a target from every other list', () => {
    const s = state({ reviewer: ['backend', 'frontend'], lead: ['backend'] })
    expect(removeAgentFromSubscriptions(s, 'backend')).toBe(true)
    expect(s.subscriptions).toEqual({ reviewer: ['frontend'] })
  })

  it('prunes a list that empties and clears both roles at once', () => {
    // `backend` is both a subscriber (to db) and the sole target of `reviewer`.
    const s = state({ backend: ['db'], reviewer: ['backend'] })
    expect(removeAgentFromSubscriptions(s, 'backend')).toBe(true)
    expect(s.subscriptions).toEqual({})
  })

  it('is a no-op when the agent appears nowhere', () => {
    const s = state({ reviewer: ['backend'] })
    expect(removeAgentFromSubscriptions(s, 'ghost')).toBe(false)
    expect(s.subscriptions).toEqual({ reviewer: ['backend'] })
  })
})

describe('removeSubscriptionFromState', () => {
  it('removes a target and reports the change', () => {
    const s = state({ reviewer: ['backend', 'frontend'] })
    expect(removeSubscriptionFromState(s, 'reviewer', 'backend')).toBe(true)
    expect(s.subscriptions!.reviewer).toEqual(['frontend'])
  })

  it('prunes the subscriber key when its last target is removed', () => {
    const s = state({ reviewer: ['backend'] })
    expect(removeSubscriptionFromState(s, 'reviewer', 'backend')).toBe(true)
    expect(s.subscriptions).toEqual({})
  })

  it('is a no-op when not subscribed', () => {
    const s = state({ reviewer: ['backend'] })
    expect(removeSubscriptionFromState(s, 'reviewer', 'frontend')).toBe(false)
    expect(removeSubscriptionFromState(s, 'ghost', 'backend')).toBe(false)
  })
})

describe('renameAgentInSubscriptions', () => {
  it('moves the subscriber key to the new name', () => {
    const s = state({ backend: ['db'] })
    expect(renameAgentInSubscriptions(s, 'backend', 'api')).toBe(true)
    expect(s.subscriptions).toEqual({ api: ['db'] })
  })

  it('rewrites the agent wherever it appears as a target', () => {
    const s = state({ reviewer: ['backend', 'frontend'], lead: ['backend'] })
    expect(renameAgentInSubscriptions(s, 'backend', 'api')).toBe(true)
    expect(s.subscriptions).toEqual({ reviewer: ['api', 'frontend'], lead: ['api'] })
  })

  it('rewrites both the key and target refs together, including a self-subscription', () => {
    const s = state({ backend: ['backend', 'db'] })
    expect(renameAgentInSubscriptions(s, 'backend', 'api')).toBe(true)
    expect(s.subscriptions).toEqual({ api: ['api', 'db'] })
  })

  it('is a no-op when the agent appears nowhere', () => {
    const s = state({ reviewer: ['frontend'] })
    expect(renameAgentInSubscriptions(s, 'backend', 'api')).toBe(false)
    expect(s.subscriptions).toEqual({ reviewer: ['frontend'] })
  })
})
