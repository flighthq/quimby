import { QuimbyError } from '@quimbyhq/errors'

// A parsed panel-dashboard layout. `tabs` is a leaf — a pane hosting one or more agents as
// tabs; `cols`/`rows` split their region side by side / stacked. See design-decisions.md
// ("The multi-panel dashboard is a three-layer nesting…") for the model and grammar.
export type LayoutNode =
  | { type: 'tabs'; names: readonly string[] }
  | { type: 'cols'; children: readonly LayoutNode[] }
  | { type: 'rows'; children: readonly LayoutNode[] }

type Token = { kind: 'name'; value: string } | { kind: 'op'; value: '|' | '/' | '(' | ')' }

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

// True when a string uses layout operators (`|` `/` `(` `)`). A bare name or a space-separated
// list without operators is not a layout expression — the caller treats those as a single
// agent / the flat tabbed dashboard, so the panel path is purely additive.
export function isLayoutExpr(s: string): boolean {
  return /[|/()]/.test(s)
}

// Parse a layout expression into a tree. Precedence, tightest → loosest: space (tab group) >
// `/` (rows) > `|` (columns); parens override. Throws QuimbyError on malformed input.
export function parseLayout(expr: string): LayoutNode {
  const parser = new LayoutParser(tokenize(expr))
  const node = parser.parseColumns()
  parser.expectEnd()
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
      return node
    }
    return this.parseTabs()
  }

  private parseTabs(): LayoutNode {
    const names: string[] = []
    let t = this.tokens[this.pos]
    while (t?.kind === 'name') {
      names.push(t.value)
      this.pos++
      t = this.tokens[this.pos]
    }
    if (names.length === 0) {
      const next = this.tokens[this.pos]
      throw new QuimbyError(
        next
          ? `Expected an agent name in layout, got "${next.value}"`
          : 'Expected an agent name in layout, got end of input',
      )
    }
    return { type: 'tabs', names }
  }

  private isOp(v: '|' | '/' | '(' | ')'): boolean {
    const t = this.tokens[this.pos]
    return !!t && t.kind === 'op' && t.value === v
  }
}
