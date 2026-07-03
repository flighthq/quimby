/**
 * The wake-up text pointing a recipient at a freshly delivered parcel. A note (the
 * instruction half) leads with an explicit review request; a note-less parcel — pure
 * data — gets the neutral "there's something in your inbox" form. Shared by the direct
 * carry (`handoffWork`) and outbox dispatch so both wake recipients identically.
 */
export function inboxNoticeText(parcelName: string, note?: string): string {
  return note
    ? `Please review: @handoff/in/received/${parcelName}/\n\n${note}`
    : `New handoff in your inbox: @handoff/in/received/${parcelName}/ — please review.`
}
