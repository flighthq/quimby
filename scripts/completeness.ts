import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import pc from 'picocolors'
import ts from 'typescript'

interface FileCoverage {
  rel: string
  exports: string[]
  covered: string[]
  uncovered: string[]
  missingTestFile: boolean
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')
const verbose = process.argv.includes('--verbose')
const jsonMode = process.argv.includes('--json')

const results: FileCoverage[] = []

for (const sourcePath of findSourceFiles(packagesDir)) {
  const exports = getFunctionExports(sourcePath)
  if (exports.length === 0) continue

  const rel = relative(root, sourcePath)
  const testPath = sourcePath.replace(/\.ts$/, '.test.ts')

  if (!existsSync(testPath)) {
    results.push({ rel, exports, covered: [], uncovered: exports, missingTestFile: true })
    continue
  }

  const content = readFileSync(testPath, 'utf-8')
  const covered = exports.filter((name) => hasDescribeBlock(content, name))
  results.push({
    rel,
    exports,
    covered,
    uncovered: exports.filter((name) => !covered.includes(name)),
    missingTestFile: false,
  })
}

report(results)

// Every non-test, non-barrel source file under a package's src/ is a candidate;
// index.ts and internal.ts are barrels/private and exempt.
function findSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const pkg of readdirSync(dir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    walk(join(dir, pkg.name, 'src'), files)
  }
  return files.sort()
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      entry.name !== 'index.ts' &&
      entry.name !== 'internal.ts'
    ) {
      out.push(path)
    }
  }
}

function getFunctionExports(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const names: string[] = []

  for (const statement of source.statements) {
    if (!hasExportModifier(statement)) continue

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer
        if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          ts.isIdentifier(decl.name)
        ) {
          names.push(decl.name.text)
        }
      }
    }
  }

  return names.sort()
}

function hasDescribeBlock(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`describe\\(['"\`]${escaped}['"\`]`).test(content)
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false
}

function report(results: FileCoverage[]): void {
  const missing = results.filter((r) => r.missingTestFile)
  const partial = results.filter((r) => !r.missingTestFile && r.uncovered.length > 0)
  const full = results.filter((r) => !r.missingTestFile && r.uncovered.length === 0)

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          passed: missing.length === 0 && partial.length === 0,
          summary: {
            total: results.length,
            full: full.length,
            partial: partial.length,
            missing: missing.length,
          },
          missing: missing.map((r) => ({ file: r.rel, exports: r.exports })),
          partial: partial.map((r) => ({ file: r.rel, uncovered: r.uncovered })),
        },
        null,
        2,
      ),
    )
    process.exit(missing.length === 0 && partial.length === 0 ? 0 : 1)
  }

  if (missing.length > 0) {
    console.log(pc.bold(pc.red(`\nMissing test files (${missing.length})`)))
    for (const r of missing) {
      console.log(`  ${pc.red('✗')} ${r.rel} ${pc.dim(`— ${format(r.exports)}`)}`)
    }
  }

  if (partial.length > 0) {
    console.log(pc.bold(pc.yellow(`\nUncovered exports (${partial.length})`)))
    for (const r of partial) {
      console.log(
        `  ${pc.yellow('!')} ${r.rel} ${pc.dim(`(${r.covered.length}/${r.exports.length})`)} — ${format(r.uncovered)}`,
      )
    }
  }

  if (missing.length + partial.length === 0) {
    console.log(pc.green(`✓ ${full.length} files: every exported function has a describe block`))
    return
  }
  // Informational by default: report the gaps but don't fail. Use `--json` (wired
  // for CI) to get a non-zero exit when coverage is incomplete.
  console.log(
    pc.dim(
      `\n${missing.length} missing test file(s), ${partial.length} file(s) with uncovered exports`,
    ),
  )
}

function format(names: string[]): string {
  const shown = verbose ? names : names.slice(0, 8)
  const more = names.length - shown.length
  return shown.join(', ') + (more > 0 ? `, +${more} more` : '')
}
