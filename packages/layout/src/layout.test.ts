import { describe, expect, it } from 'vitest'

import type { LayoutNode } from './layout'
import {
  collectLayoutAgents,
  expandRoleSlots,
  isLayoutExpr,
  isRoleToken,
  isServiceToken,
  layoutWeights,
  parseLayout,
  roleNameOf,
  serviceNameOf,
} from './layout'

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

describe('expandRoleSlots', () => {
  // Two builders and an integration; the fake resolver returns them in "creation" order.
  const resolve = (role: string): string[] =>
    role === 'builder' ? ['builder', 'builder-2'] : role === 'integration' ? ['integration'] : []

  it('expands a @role leaf to all its instances, tabbed into one pane', () => {
    expect(expandRoleSlots(parseLayout('@builder'), resolve)).toEqual({
      type: 'tabs',
      names: ['builder', 'builder-2'],
    })
  })

  it('expands @role leaves inside a split, preserving structure', () => {
    expect(expandRoleSlots(parseLayout('@builder | @integration'), resolve)).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['builder', 'builder-2'] },
        { type: 'tabs', names: ['integration'] },
      ],
    })
  })

  it('leaves concrete names and host/service tokens untouched', () => {
    expect(expandRoleSlots(parseLayout('@builder | host $server'), resolve)).toEqual({
      type: 'cols',
      children: [
        { type: 'tabs', names: ['builder', 'builder-2'] },
        { type: 'tabs', names: ['host', '$server'] },
      ],
    })
  })

  it('keeps a pane weight on the expanded role slot', () => {
    expect(expandRoleSlots(parseLayout('@builder:70 / other:30'), resolve)).toEqual({
      type: 'rows',
      children: [
        { type: 'tabs', names: ['builder', 'builder-2'], weight: 70 },
        { type: 'tabs', names: ['other'], weight: 30 },
      ],
    })
  })

  it('dedupes within a pane so @role plus an explicit instance shows one tab', () => {
    expect(expandRoleSlots(parseLayout('@builder builder'), resolve)).toEqual({
      type: 'tabs',
      names: ['builder', 'builder-2'],
    })
  })

  it('throws for a role slot with no instances', () => {
    expect(() => expandRoleSlots(parseLayout('@ghost'), resolve)).toThrow('no agent has role "ghost"') // prettier-ignore
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

describe('isRoleToken', () => {
  it('is true for `@name` and false for a bare `@`, a service, host, or an agent name', () => {
    expect(isRoleToken('@builder')).toBe(true)
    expect(isRoleToken('@')).toBe(false)
    expect(isRoleToken('$server')).toBe(false)
    expect(isRoleToken('builder')).toBe(false)
  })

  it('tokenizes `@name` as one tab member', () => {
    expect(collectLayoutAgents(parseLayout('@review | @builder / @integration'))).toEqual([
      '@review',
      '@builder',
      '@integration',
    ])
  })
})

describe('isServiceToken', () => {
  it('is true for `$name` and false for a bare host `$` or an agent name', () => {
    expect(isServiceToken('$server')).toBe(true)
    expect(isServiceToken('$')).toBe(false)
    expect(isServiceToken('server')).toBe(false)
    expect(isServiceToken('host')).toBe(false)
  })

  it('tokenizes `$name` as one tab member, distinct from a plain `$` host', () => {
    expect(collectLayoutAgents(parseLayout('host $server'))).toEqual(['host', '$server'])
    expect(collectLayoutAgents(parseLayout('$ | $server'))).toEqual(['$', '$server'])
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

describe('roleNameOf', () => {
  it('strips the leading `@`', () => {
    expect(roleNameOf('@builder')).toBe('builder')
  })
})

describe('serviceNameOf', () => {
  it('strips the leading `$`', () => {
    expect(serviceNameOf('$server')).toBe('server')
  })
})
