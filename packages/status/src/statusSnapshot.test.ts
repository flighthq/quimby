import { describe, expect, it } from 'vitest'

import { formatStatusPlaceholder, formatStatusSnapshot } from './statusSnapshot'

describe('formatStatusPlaceholder', () => {
  it('renders a placeholder body with no Updated line, distinct from a real snapshot', () => {
    expect(formatStatusPlaceholder('builder')).toBe(
      '# Status: builder\n\n_No status reported yet._\n',
    )
  })
})

describe('formatStatusSnapshot', () => {
  it('renders the status routing payload with the source name and timestamp', () => {
    expect(formatStatusSnapshot('builder', 'body', '2026-07-02T00:00:00.000Z')).toBe(
      '# Status: builder\n\nUpdated: 2026-07-02T00:00:00.000Z\n\nbody\n',
    )
  })
})
