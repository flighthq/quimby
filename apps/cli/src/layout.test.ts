import { describe, expect, it } from 'vitest'

import type { LayoutNode } from './layout'
import { collectLayoutAgents, isLayoutExpr, layoutWeights, parseLayout } from './layout'

const tabs = (name: string, weight?: number): LayoutNode =>
  weight === undefined ? { type: 'tabs', names: [name] } : { type: 'tabs', names: [name], weight }

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

  it('is true when a `:N` size weight is present', () => {
    expect(isLayoutExpr('a:70 / b')).toBe(true)
    expect(isLayoutExpr('a:70')).toBe(true)
  })

  it('is false for a bare name or a space-separated list', () => {
    expect(isLayoutExpr('alice')).toBe(false)
    expect(isLayoutExpr('alice bob')).toBe(false)
  })
})

describe('layoutWeights', () => {
  it('splits evenly when no sibling is weighted', () => {
    expect(layoutWeights([tabs('a'), tabs('b')])).toEqual([50, 50])
  })

  it('uses explicit weights as-is (plain sum-and-divide)', () => {
    expect(layoutWeights([tabs('a', 70), tabs('b', 30)])).toEqual([70, 30])
    expect(layoutWeights([tabs('a', 2), tabs('b', 1)])).toEqual([2, 1])
  })

  it('gives unsized siblings an equal share of the remainder to 100', () => {
    expect(layoutWeights([tabs('a', 70), tabs('b'), tabs('c')])).toEqual([70, 15, 15])
  })

  it('floors an unsized share at 1 when the explicit sum meets or exceeds 100', () => {
    expect(layoutWeights([tabs('a', 100), tabs('b')])).toEqual([100, 1])
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

  it('binds a `:N` weight to an agent name', () => {
    expect(parseLayout('a:70 / b:30')).toEqual({
      type: 'rows',
      children: [
        { type: 'tabs', names: ['a'], weight: 70 },
        { type: 'tabs', names: ['b'], weight: 30 },
      ],
    })
  })

  it('binds a `:N` weight to a `)` group', () => {
    expect(parseLayout('(a b):70 / c:30')).toEqual({
      type: 'rows',
      children: [
        { type: 'tabs', names: ['a', 'b'], weight: 70 },
        { type: 'tabs', names: ['c'], weight: 30 },
      ],
    })
  })

  it('leaves unweighted siblings without a weight field', () => {
    expect(parseLayout('a:70 / b')).toEqual({
      type: 'rows',
      children: [
        { type: 'tabs', names: ['a'], weight: 70 },
        { type: 'tabs', names: ['b'] },
      ],
    })
  })

  it('throws when a weight is put on a tab member', () => {
    expect(() => parseLayout('a:2 b | c')).toThrow(/tab/i)
    expect(() => parseLayout('(a b:1) | c')).toThrow(/tab/i)
  })

  it('throws when a weight has no split siblings to size against', () => {
    expect(() => parseLayout('(a):5')).toThrow(/size weight/i)
    expect(() => parseLayout('a:5')).toThrow(/size weight/i)
  })

  it('throws on a `:` with no number', () => {
    expect(() => parseLayout('a: | b')).toThrow(/number after/i)
  })

  it('throws on a non-positive weight', () => {
    expect(() => parseLayout('a:0 | b')).toThrow(/positive/i)
  })
})
