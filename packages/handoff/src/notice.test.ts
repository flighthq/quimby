import { describe, expect, it } from 'vitest'

import { inboxNoticeText } from './notice'

describe('inboxNoticeText', () => {
  it('leads with the agent.sh inbox command and includes the note when one is given', () => {
    expect(inboxNoticeText('review-abc123', 'fix the null case')).toBe(
      'Run `./agent.sh inbox show review-abc123`.\n\nfix the null case',
    )
  })

  it('uses a default review request when no note is given', () => {
    expect(inboxNoticeText('review-abc123')).toBe(
      'Run `./agent.sh inbox show review-abc123`.\n\nplease review',
    )
  })

  it('treats an empty-string note as no note', () => {
    expect(inboxNoticeText('p', '')).toBe('Run `./agent.sh inbox show p`.\n\nplease review')
  })
})
