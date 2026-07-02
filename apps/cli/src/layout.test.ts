import { describe, expect, it } from 'vitest'

import { collectLayoutAgents, isLayoutExpr, parseLayout } from './layout'

describe('collectLayoutAgents', () => {
  it('returns unique agent names in first-appearance order', () => {
    expect(collectLayoutAgents(parseLayout('(a b)/c | a e'))).toEqual(['a', 'b', 'c', 'e'])
  })

  it('includes host as an ordinary name', () => {
    expect(collectLayoutAgents(parseLayout('host | a'))).toEqual(['host', 'a'])
  })
})

describe('isLayoutExpr', () => {
  it('is true when any layout operator is present', () => {
    expect(isLayoutExpr('a|b')).toBe(true)
    expect(isLayoutExpr('a/b')).toBe(true)
    expect(isLayoutExpr('(a)')).toBe(true)
  })

  it('is false for a bare name or a space-separated list', () => {
    expect(isLayoutExpr('alice')).toBe(false)
    expect(isLayoutExpr('alice bob')).toBe(false)
  })
})

describe('parseLayout', () => {
  it('treats space as the tightest binding — a tab group in one pane', () => {
    expect(parseLayout('a b')).toEqual({ type: 'tabs', names: ['a', 'b'] })
  })

  it('parses columns with `|`', () => {
    expect(parseLayout('a | b')).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['a'] },
        { type: 'tabs', names: ['b'] },
      ],
    })
  })

  it('binds `/` tighter than `|` (columns of stacks)', () => {
    expect(parseLayout('a/b | c/d')).toEqual({
      type: 'cols',
      children: [
        {
          type: 'rows',
          children: [
            { type: 'tabs', names: ['a'] },
            { type: 'tabs', names: ['b'] },
          ],
        },
        {
          type: 'rows',
          children: [
            { type: 'tabs', names: ['c'] },
            { type: 'tabs', names: ['d'] },
          ],
        },
      ],
    })
  })

  it('parses "a b | c d" as tabs{a,b} beside tabs{c,d}', () => {
    expect(parseLayout('a b | c d')).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['a', 'b'] },
        { type: 'tabs', names: ['c', 'd'] },
      ],
    })
  })

  it('honors parentheses over precedence', () => {
    expect(parseLayout('((a b) / c) | d e')).toEqual({
      type: 'cols',
      children: [
        {
          type: 'rows',
          children: [
            { type: 'tabs', names: ['a', 'b'] },
            { type: 'tabs', names: ['c'] },
          ],
        },
        { type: 'tabs', names: ['d', 'e'] },
      ],
    })
  })

  it('is whitespace-insensitive around operators', () => {
    expect(parseLayout('a|b')).toEqual(parseLayout('  a  |  b  '))
  })

  it('flattens n-ary splits at one level', () => {
    expect(parseLayout('a | b | c')).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['a'] },
        { type: 'tabs', names: ['b'] },
        { type: 'tabs', names: ['c'] },
      ],
    })
  })

  it('reads `$` as a host-shell slot token', () => {
    expect(parseLayout('a | $')).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['a'] },
        { type: 'tabs', names: ['$'] },
      ],
    })
  })

  it('allows multiple host slots, as tabs or panes', () => {
    expect(parseLayout('$ $ | $')).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['$', '$'] },
        { type: 'tabs', names: ['$'] },
      ],
    })
  })

  it('throws on an empty expression', () => {
    expect(() => parseLayout('   ')).toThrow(/expected an agent name/i)
  })

  it('throws on a dangling operator', () => {
    expect(() => parseLayout('a |')).toThrow(/expected an agent name/i)
  })

  it('throws on unbalanced parentheses', () => {
    expect(() => parseLayout('(a b')).toThrow(/unbalanced/i)
  })

  it('throws on a stray closing parenthesis', () => {
    expect(() => parseLayout('a) b')).toThrow(/unexpected/i)
  })

  it('throws on an invalid character', () => {
    expect(() => parseLayout('a & b')).toThrow(/invalid character/i)
  })
})
