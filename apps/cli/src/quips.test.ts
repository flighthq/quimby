import { describe, expect, it } from 'vitest'

import { getQuimbySuccessQuip } from './quips'

describe('getQuimbySuccessQuip', () => {
  it('returns a quoted string containing the agent name', () => {
    for (let i = 0; i < 50; i++) {
      const quip = getQuimbySuccessQuip('backend')
      expect(quip).toBeTypeOf('string')
      expect(quip.length).toBeGreaterThan(0)
      expect(quip).toContain('backend')
      expect(quip).toMatch(/^".*"$/)
    }
  })
})
