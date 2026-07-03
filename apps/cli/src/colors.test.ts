import { colors } from 'consola/utils'
import { describe, expect, it } from 'vitest'

import { bold, cyan, dim, green, red, yellow } from './colors'

describe('colors', () => {
  it('routes every style through consola/utils colors so NO_COLOR/FORCE_COLOR/TTY are honored', () => {
    // Identity check rather than escape-code assertion: proving the helpers ARE colorette's
    // guards against a revert to unconditional `\x1b[..m` escapes that ignore NO_COLOR, without
    // depending on the ambient color support of the test runner.
    expect(bold).toBe(colors.bold)
    expect(cyan).toBe(colors.cyan)
    expect(dim).toBe(colors.dim)
    expect(green).toBe(colors.green)
    expect(red).toBe(colors.red)
    expect(yellow).toBe(colors.yellow)
  })
})
