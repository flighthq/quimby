import { describe, expect, it } from 'vitest'

import { classifyOutboxDraft, createOutboxDispatchTracker } from './autodispatch'

describe('classifyOutboxDraft', () => {
  it('waits on the first sighting (could still be mid-write)', () => {
    const tracker = createOutboxDispatchTracker()
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('wait')
  })

  it('dispatches once the mtime is unchanged across a cycle, then never again', () => {
    const tracker = createOutboxDispatchTracker()
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('wait')
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('dispatch')
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('wait')
  })

  it('resets to waiting when the draft changes (still being authored)', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'review/builder', 100)
    expect(classifyOutboxDraft(tracker, 'review/builder', 200)).toBe('wait')
    expect(classifyOutboxDraft(tracker, 'review/builder', 200)).toBe('dispatch')
  })

  it('re-dispatches a recipient re-authored at a new mtime after delivery', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'review/builder', 100)
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('dispatch')
    classifyOutboxDraft(tracker, 'review/builder', 300)
    expect(classifyOutboxDraft(tracker, 'review/builder', 300)).toBe('dispatch')
  })

  it('tracks independent sender/recipient pairs separately', () => {
    const tracker = createOutboxDispatchTracker()
    classifyOutboxDraft(tracker, 'review/builder', 100)
    classifyOutboxDraft(tracker, 'review/integration', 200)
    expect(classifyOutboxDraft(tracker, 'review/builder', 100)).toBe('dispatch')
    expect(classifyOutboxDraft(tracker, 'review/integration', 200)).toBe('dispatch')
  })
})

describe('createOutboxDispatchTracker', () => {
  it('starts with empty maps', () => {
    const tracker = createOutboxDispatchTracker()
    expect(tracker.seen.size).toBe(0)
    expect(tracker.done.size).toBe(0)
  })
})
