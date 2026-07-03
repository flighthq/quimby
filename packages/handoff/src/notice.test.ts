import { describe, expect, it } from 'vitest'

import { inboxNoticeText } from './notice'

describe('inboxNoticeText', () => {
  it('leads with a review request and includes the note when one is given', () => {
    expect(inboxNoticeText('review-abc123', 'fix the null case')).toBe(
      'Please review: @handoff/in/received/review-abc123/\n\nfix the null case',
    )
  })

  it('uses the neutral inbox form for a note-less (data-only) parcel', () => {
    expect(inboxNoticeText('review-abc123')).toBe(
      'New handoff in your inbox: @handoff/in/received/review-abc123/ — please review.',
    )
  })

  it('treats an empty-string note as no note', () => {
    expect(inboxNoticeText('p', '')).toBe(
      'New handoff in your inbox: @handoff/in/received/p/ — please review.',
    )
  })
})
