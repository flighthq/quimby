import { describe, expect, it } from 'vitest'

import { passiveDeliveryNotice } from './dispatchNotice'

describe('passiveDeliveryNotice', () => {
  it('names the missing edge and the fix when an escalation was refused', () => {
    const out = passiveDeliveryNotice('builder1', { recipient: 'review', downgraded: 'escalation' })
    expect(out).toContain('escalatesTo')
    expect(out).toContain('quimby sync builder1')
    expect(out).toContain('NOT woken')
  })

  it('explains an uncorrelated reply', () => {
    const out = passiveDeliveryNotice('builder1', { recipient: 'review', downgraded: 'reply' })
    expect(out).toContain("isn't in its inbox")
  })

  it('states plainly that an ordinary advisory is passive by design', () => {
    const out = passiveDeliveryNotice('builder1', { recipient: 'review' })
    expect(out).toContain('advisory')
    expect(out).toContain('no nudge')
  })
})
