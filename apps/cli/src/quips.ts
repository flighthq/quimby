// Chief Quimby sign-off lines, shown after a pack lands. The agent delivered the
// package; the Chief takes the credit. Picked at random so repeat applies stay fun.
const SUCCESS_QUIPS: readonly string[] = [
  "Congratulations, Gadget. I don't know how you did it, but once again you've saved the day.",
  'Good work, Gadget. I knew I could count on you.',
  'Excellent work, Gadget. Another case closed.',
  "Nice work, Gadget. I'm putting you in for a commendation.",
  'Mission accomplished, Gadget. The pack is delivered.',
  "Well done, Gadget. I always said you were the best agent we've got.",
]

export function getQuimbySuccessQuip(): string {
  return SUCCESS_QUIPS[Math.floor(Math.random() * SUCCESS_QUIPS.length)]
}
