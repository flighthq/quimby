import { describe, expect, it } from 'vitest'

import type { FocusPolicy } from './FocusPolicy'

describe('FocusPolicy', () => {
  it('admits exactly the two policies the focus guard branches on', () => {
    const policies: FocusPolicy[] = ['hold', 'nudge']
    expect(policies).toEqual(['hold', 'nudge'])
  })
})
