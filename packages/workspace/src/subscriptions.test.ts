import type { QuimbyState } from '@quimbyhq/types'
import { describe, expect, it } from 'vitest'

import { addSubscriptionToState, removeSubscriptionFromState } from './subscriptions'

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
