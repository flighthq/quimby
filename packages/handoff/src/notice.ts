/**
 * The wake-up text pointing a recipient at a freshly delivered parcel. The parcel
 * reference leads, followed by either the caller's note or a default review request.
 * Shared by the direct carry (`handoffWork`) and outbox dispatch so both wake
 * recipients identically.
 */
export function inboxNoticeText(parcelName: string, note?: string): string {
  return `@handoff/in/received/${parcelName}/\n\n${note || 'please review'}`
}
