/**
 * Explain a delivered parcel that did NOT wake its recipient. Silence here is the failure mode that
 * sends the operator back to hand-carrying: the parcel arrives, nobody stirs, and nothing says
 * whether that was by design (an advisory note) or a missing edge (an escalation the graph refused).
 */
export function passiveDeliveryNotice(
  sender: string,
  result: Readonly<{ recipient: string; downgraded?: 'escalation' | 'reply' }>,
): string {
  if (result.downgraded === 'escalation') {
    return (
      `"${sender}" asked to escalate to "${result.recipient}", which its graph doesn't permit — ` +
      `delivered as an advisory, so "${result.recipient}" was NOT woken. Give "${sender}" an ` +
      `\`escalatesTo\` including "${result.recipient}" (or have "${result.recipient}" \`directs\` it), ` +
      `then \`quimby sync ${sender}\` to apply it.`
    )
  }
  if (result.downgraded === 'reply') {
    return (
      `"${sender}" marked this a reply, but the parcel it answers isn't in its inbox — delivered ` +
      `as an advisory, so "${result.recipient}" was NOT woken.`
    )
  }
  return `advisory — landed in "${result.recipient}"'s inbox, read on its own turn (no nudge)`
}
