import { describe, expect, it } from 'vitest'

import { inboxNoticeText } from './notice'

describe('inboxNoticeText', () => {
  it('leads with the handoff reference and includes the note when one is given', () => {
    expect(inboxNoticeText('review-abc123', 'fix the null case')).toBe(
      '@handoff/in/received/review-abc123/\n\nfix the null case',
    )
  })

  it('uses a default review request when no note is given', () => {
    expect(inboxNoticeText('review-abc123')).toBe(
      '@handoff/in/received/review-abc123/\n\nplease review',
    )
  })

  it('treats an empty-string note as no note', () => {
    expect(inboxNoticeText('p', '')).toBe('@handoff/in/received/p/\n\nplease review')
  })
})
