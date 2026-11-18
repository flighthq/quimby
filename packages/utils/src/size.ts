const UNIT_KB: Record<string, number> = {
  k: 1,
  m: 1024,
  g: 1024 * 1024,
  t: 1024 * 1024 * 1024,
}

/**
 * Render a size in KB the way a listing wants it: `512K`, `3.4M`, `631.8G`, `1.4T`. KB is the
 * unit `du -sk` and `df -Pk` both report, so remote measurements flow through without rescaling.
 */
export function formatByteSizeKb(kb: number | undefined): string {
  if (kb === undefined || !Number.isFinite(kb)) return '?'
  if (kb >= UNIT_KB.t) return `${(kb / UNIT_KB.t).toFixed(1)}T`
  if (kb >= UNIT_KB.g) return `${(kb / UNIT_KB.g).toFixed(1)}G`
  if (kb >= UNIT_KB.m) return `${(kb / UNIT_KB.m).toFixed(1)}M`
  return `${Math.round(kb)}K`
}

/**
 * Parse a human size (`100G`, `500M`, `1.5T`, `64K`, optionally with a trailing `B`) to KB,
 * returning `null` for anything unparseable. A bare number is GB — the unit anyone means when
 * they say how much disk to keep free. User input, so a bad value is a sentinel, not a throw.
 */
export function parseByteSizeKb(value: string | number | undefined): number | null {
  if (value === undefined) return null
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? value * UNIT_KB.g : null
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  return amount * (match[2] ? UNIT_KB[match[2].toLowerCase()] : UNIT_KB.g)
}
