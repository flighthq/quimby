const SUCCESS_QUIPS: readonly string[] = [
  "Congratulations, {agent}. I don't know how you did it, but once again you've saved the day.",
  'Good work, {agent}. I knew I could count on you.',
  'Excellent work, {agent}. Another case closed.',
  "Nice work, {agent}. I'm putting you in for a commendation.",
  'Mission accomplished, {agent}. The parcel is delivered.',
  "Well done, {agent}. I always said you were the best agent we've got.",
]

export function getQuimbySuccessQuip(agent: string): string {
  const quip = SUCCESS_QUIPS[Math.floor(Math.random() * SUCCESS_QUIPS.length)]
  return `"${quip.replaceAll('{agent}', agent)}"`
}
