import { colors } from 'consola/utils'

// One color seam for all CLI output, delegated to consola's colorette-backed `colors` so
// NO_COLOR, FORCE_COLOR, and non-TTY output are all honored exactly as consola's own logs are.
// Commands import these instead of hand-rolling `\x1b[..m` escapes, which would print raw when
// color is unwanted.
export const bold = colors.bold
export const cyan = colors.cyan
export const dim = colors.dim
export const green = colors.green
export const red = colors.red
export const yellow = colors.yellow
