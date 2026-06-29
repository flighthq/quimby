import { describe, expect, it } from 'vitest'

import { getQuimbyBanner } from './banner'

describe('getQuimbyBanner', () => {
  it('renders the wordmark across eight lines', () => {
    expect(getQuimbyBanner().split('\n')).toHaveLength(8)
  })

  it('contains the glyph strokes of the wordmark', () => {
    // Assert on the art itself rather than ANSI codes, which consola strips
    // in non-TTY environments.
    expect(getQuimbyBanner()).toContain('88888')
  })
})
