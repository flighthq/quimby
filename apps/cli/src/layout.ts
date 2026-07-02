import { QuimbyError } from '@quimbyhq/errors'

// A parsed panel-dashboard layout. `tabs` is a leaf — a pane hosting one or more agents as
// tabs; `cols`/`rows` split their region side by side / stacked. An optional `weight` is a
// `:N` size share the node carries within its split (see `layoutWeights`). See
// design-decisions.md ("Pane sizes are node weights (`:N`)…") for the model and grammar.
export type LayoutNode =
  | { type: 'tabs'; names: readonly string[]; weight?: number }
  | { type: 'cols'; children: readonly LayoutNode[]; weight?: number }
  | { type: 'rows'; children: readonly LayoutNode[]; weight?: number }

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: '|' | '/' | '(' | ')' }
  | { kind: 'weight'; value: number }

const NAME_CHAR = /[A-Za-z0-9._-]/

// Unique agent names a layout references, in first-appearance order. `host` is included; the
// caller decides how to render it (a shell pane), just as the flat dashboard does.
export function collectLayoutAgents(node: Readonly<LayoutNode>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (n: Readonly<LayoutNode>): void => {
    if (n.type === 'tabs') {
      for (const name of n.names) {
        if (!seen.has(name)) {
          seen.add(name)
          out.push(name)
        }
      }
    } else {
      for (const c of n.children) walk(c)
    }
  }
  walk(node)
  return out
}

// True when a string uses layout operators (`|` `/` `(` `)`) or a `:N` size weight. A bare
// name or a space-separated list without operators is not a layout expression — the caller
// treats those as a single agent / the flat tabbed dashboard, so the panel path is purely
// additive. `:` is included because an agent name can never contain one (validateAgentName
// forbids it), so a colon always signals layout intent — routing `a:70` to a clear weight
// error rather than an "agent not found".
export function isLayoutExpr(s: string): boolean {
  return /[|/():]/.test(s)
}

// Effective sibling sizes for a split's children: explicit `:N` weights are used as-is;
// unsized children split the remainder-to-100 equally (so `a:70 / b / c` → b,c get 15 each),
// with a floor of 1 apiece so an explicit sum ≥ 100 never zeroes an unsized pane. When every
// sibling is weighted this is plain sum-and-divide (`2:1` → thirds). Returns raw shares; the
// caller normalizes by their sum.
export function layoutWeights(children: readonly Readonly<LayoutNode>[]): number[] {
  const explicitSum = children.reduce((sum, c) => sum + (c.weight ?? 0), 0)
  const unsized = children.filter((c) => c.weight === undefined).length
  const share = unsized > 0 ? Math.max((100 - explicitSum) / unsized, 1) : 0
  return children.map((c) => c.weight ?? share)
}

// Parse a layout expression into a tree. Precedence, tightest → loosest: space (tab group) >
// `/` (rows) > `|` (columns); parens override. A `:N` weight binds to the preceding name or
// `)` group. Throws QuimbyError on malformed input (including a weight on a tab member or a
// pane with no split siblings to size against).
export function parseLayout(expr: string): LayoutNode {
  const parser = new LayoutParser(tokenize(expr))
  const node = parser.parseColumns()
  parser.expectEnd()
  assertWeightsUnderSplit(node, false)
  return node
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === ' ' || c === '\t' || c === '\n') {
      i++
      continue
    }
    if (c === '|' || c === '/' || c === '(' || c === ')') {
      tokens.push({ kind: 'op', value: c })
      i++
      continue
    }
    // `:N` is a size weight bound to the preceding name or `)` group. Digits only (weights
    // are integers); a non-positive weight is degenerate, and a bare `:` is a typo.
    if (c === ':') {
      let j = i + 1
      while (j < expr.length && expr[j] >= '0' && expr[j] <= '9') j++
      if (j === i + 1) {
        throw new QuimbyError(`Expected a number after ":" in layout "${expr}" (a size weight, e.g. "agent:70")`) // prettier-ignore
      }
      const n = Number(expr.slice(i + 1, j))
      if (n <= 0) throw new QuimbyError(`Size weight must be positive in layout "${expr}", got ":${n}"`) // prettier-ignore
      tokens.push({ kind: 'weight', value: n })
      i = j
      continue
    }
    // `$` is a standalone name meaning "a host shell slot" — repeatable, so `$ | $` is two
    // host panes and `a $` is agent a beside a host tab. Single-char so it never merges with
    // an adjacent name (the caller maps it, and `host`, to a shell).
    if (c === '$') {
      tokens.push({ kind: 'name', value: '$' })
      i++
      continue
    }
    if (NAME_CHAR.test(c)) {
      let j = i
      while (j < expr.length && NAME_CHAR.test(expr[j])) j++
      tokens.push({ kind: 'name', value: expr.slice(i, j) })
      i = j
      continue
    }
    throw new QuimbyError(`Invalid character ${JSON.stringify(c)} in layout "${expr}"`)
  }
  return tokens
}

class LayoutParser {
  private pos = 0

  constructor(private readonly tokens: readonly Token[]) {}

  parseColumns(): LayoutNode {
    const children = [this.parseRows()]
    while (this.isOp('|')) {
      this.pos++
      children.push(this.parseRows())
    }
    return children.length === 1 ? children[0] : { type: 'cols', children }
  }

  expectEnd(): void {
    const t = this.tokens[this.pos]
    if (t) throw new QuimbyError(`Unexpected "${t.value}" in layout`)
  }

  private parseRows(): LayoutNode {
    const children = [this.parseFactor()]
    while (this.isOp('/')) {
      this.pos++
      children.push(this.parseFactor())
    }
    return children.length === 1 ? children[0] : { type: 'rows', children }
  }

  private parseFactor(): LayoutNode {
    if (this.isOp('(')) {
      this.pos++
      const node = this.parseColumns()
      if (!this.isOp(')')) throw new QuimbyError('Unbalanced "(" in layout')
      this.pos++
      const weight = this.takeWeight()
      return weight !== undefined ? { ...node, weight } : node
    }
    return this.parseTabs()
  }

  private parseTabs(): LayoutNode {
    const names: string[] = []
    let weight: number | undefined
    let weighted = 0
    let t = this.tokens[this.pos]
    while (t?.kind === 'name') {
      names.push(t.value)
      this.pos++
      const w = this.takeWeight()
      if (w !== undefined) {
        weight = w
        weighted++
      }
      t = this.tokens[this.pos]
    }
    if (names.length === 0) {
      const next = this.tokens[this.pos]
      throw new QuimbyError(
        next
          ? `Expected an agent name in layout, got "${describeToken(next)}"`
          : 'Expected an agent name in layout, got end of input',
      )
    }
    // A tab group is one pane showing one tab at a time, so its members have no size relative
    // to each other; weight the whole group as `(a b):N` instead.
    if (weighted > 0 && names.length > 1) {
      throw new QuimbyError(
        `Size weights (\`:N\`) apply to a pane, not a tab — "${names.join(' ')}" is a tab group (one pane, tabbed). Weight the whole group as "(${names.join(' ')}):N".`,
      )
    }
    return weight !== undefined ? { type: 'tabs', names, weight } : { type: 'tabs', names }
  }

  private isOp(v: '|' | '/' | '(' | ')'): boolean {
    const t = this.tokens[this.pos]
    return !!t && t.kind === 'op' && t.value === v
  }

  private takeWeight(): number | undefined {
    const t = this.tokens[this.pos]
    if (t?.kind === 'weight') {
      this.pos++
      return t.value
    }
    return undefined
  }
}

// A weight is only meaningful on a pane that has siblings to size against — a direct child of
// a `cols`/`rows` split. A weight on the whole layout, or on a lone pane, sizes nothing, so it
// is a user error rather than a silent no-op.
function assertWeightsUnderSplit(node: Readonly<LayoutNode>, underSplit: boolean): void {
  if (node.weight !== undefined && !underSplit) {
    throw new QuimbyError(
      `A size weight (\`:${node.weight}\`) only means something on a pane with split siblings (inside a \`|\` or \`/\`); this one sizes nothing on its own.`,
    )
  }
  if (node.type === 'cols' || node.type === 'rows') {
    for (const child of node.children) assertWeightsUnderSplit(child, true)
  }
}

function describeToken(t: Readonly<Token>): string {
  return t.kind === 'weight' ? `:${t.value}` : t.value
}
