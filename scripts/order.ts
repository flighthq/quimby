import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import pc from 'picocolors'
import ts from 'typescript'

interface OrderIssue {
  rel: string
  actual: string[]
  expected: string[]
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')
const fixMode = process.argv.includes('--fix')
const checkMode = process.argv.includes('--check')
const jsonMode = process.argv.includes('--json')

const testFiles = findTestFiles(packagesDir)
const issues: OrderIssue[] = []
let fixedCount = 0

for (const path of testFiles) {
  const original = readFileSync(path, 'utf-8')
  const blocks = describeBlocks(path, original)
  if (blocks.length < 2) continue

  const names = blocks.map((b) => b.name)
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  if (names.every((name, i) => name === sorted[i])) continue

  const rel = relative(root, path)
  if (fixMode) {
    writeFileSync(path, reorder(original, blocks), 'utf-8')
    fixedCount++
    console.log(`${pc.green('✓')} reordered ${rel}`)
  } else {
    issues.push({ rel, actual: names, expected: sorted })
  }
}

report()

// Top-level `describe('name', …)` calls, in source order, with their text spans.
function describeBlocks(
  path: string,
  text: string,
): { name: string; start: number; end: number }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const blocks: { name: string; start: number; end: number }[] = []

  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
    const callee = statement.expression.expression
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.expression.text
        : ''
    if (calleeName !== 'describe') continue

    const firstArg = statement.expression.arguments[0]
    if (!firstArg || !ts.isStringLiteralLike(firstArg)) continue

    blocks.push({ name: firstArg.text, start: statement.getStart(source), end: statement.getEnd() })
  }

  return blocks
}

function findTestFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.test.ts')) files.push(path)
    }
  }
  for (const pkg of readdirSync(dir, { withFileTypes: true })) {
    if (pkg.isDirectory()) walk(join(dir, pkg.name, 'src'))
  }
  return files.sort()
}

// Permute only the describe-block spans into sorted order, leaving imports,
// helpers and the whitespace between blocks exactly where they are. Splicing
// right-to-left keeps earlier offsets valid.
function reorder(text: string, blocks: { name: string; start: number; end: number }[]): string {
  const sorted = [...blocks].sort((a, b) => a.name.localeCompare(b.name))
  const texts = blocks.map((b) => text.slice(b.start, b.end))
  const sortedTexts = sorted.map((b) => text.slice(b.start, b.end))

  let result = text
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (texts[i] === sortedTexts[i]) continue
    result = result.slice(0, blocks[i].start) + sortedTexts[i] + result.slice(blocks[i].end)
  }
  return result
}

function report(): void {
  if (jsonMode) {
    console.log(JSON.stringify({ passed: issues.length === 0, issues }, null, 2))
    process.exit(issues.length === 0 ? 0 : 1)
  }

  if (fixMode) {
    console.log(
      fixedCount === 0
        ? pc.green('✓ describe blocks already ordered')
        : pc.green(`\n✓ fixed ${fixedCount} file(s)`),
    )
    process.exit(0)
  }

  for (const { rel, actual, expected } of issues) {
    console.log(`\n${pc.bold(rel)}`)
    console.log(`  ${pc.red('actual:  ')}${actual.join(', ')}`)
    console.log(`  ${pc.green('expected:')}${expected.join(', ')}`)
  }

  if (issues.length === 0) {
    console.log(pc.green('✓ describe blocks are alphabetized'))
    process.exit(0)
  }
  console.log(
    pc.red(
      `\n✗ ${issues.length} file(s) with out-of-order describe blocks — run \`npm run order:fix\``,
    ),
  )
  process.exit(checkMode ? 1 : 0)
}
