const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Render a span the way a roster column wants it: `45s`, `14m`, `3h12m`, `2d4h` — the two
 * coarsest non-zero units, so an age is scannable at a glance without a units legend.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/**
 * Parse a human duration (`30s`, `45m`, `2h`, `1d`, or a bare number of minutes) to milliseconds,
 * returning `null` for anything unparseable — a config or flag value is user input, so a bad one
 * is an expected failure the caller reports, not a throw.
 */
export function parseDuration(value: string | number | undefined): number | null {
  if (value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * 60_000 : null
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  // A bare number is minutes — the unit anyone types when they mean "how long has it sat idle".
  return amount * (match[2] ? UNIT_MS[match[2].toLowerCase()] : UNIT_MS.m)
}
