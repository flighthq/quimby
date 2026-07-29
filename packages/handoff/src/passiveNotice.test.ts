import { describe, expect, it } from 'vitest'

import { passiveDeliveryNotice } from './passiveNotice'

describe('passiveDeliveryNotice', () => {
  it('names the missing edge and the fix when an escalation was refused', () => {
    const out = passiveDeliveryNotice('builder1', { recipient: 'review', downgraded: 'escalation' })
    expect(out).toContain('escalatesTo')
    expect(out).toContain('quimby sync builder1')
    expect(out).toContain('NOT woken')
  })

  it('names the parcel an uncorrelated reply aimed at, and both ways that happens', () => {
    const out = passiveDeliveryNotice('builder1', {
      recipient: 'review',
      downgraded: 'reply',
      replyTo: 'review-abc123',
    })
    expect(out).toContain('review-abc123')
    expect(out).toContain('not in its inbox')
    expect(out).toContain('quimby sync')
  })

  it('states plainly that an ordinary advisory is passive by design', () => {
    const out = passiveDeliveryNotice('builder1', { recipient: 'review' })
    expect(out).toContain('advisory')
    expect(out).toContain('no nudge')
  })
})
