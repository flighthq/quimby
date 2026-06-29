import { describe, expect, it } from 'vitest'

import { getQuimbySuccessQuip } from './quips'

describe('getQuimbySuccessQuip', () => {
  it('returns a non-empty string that addresses Gadget', () => {
    for (let i = 0; i < 50; i++) {
      const quip = getQuimbySuccessQuip()
      expect(quip).toBeTypeOf('string')
      expect(quip.length).toBeGreaterThan(0)
      expect(quip).toContain('Gadget')
    }
  })
})
