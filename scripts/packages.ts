import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pc from 'picocolors'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

interface PackageJson {
  name?: string
  private?: boolean
  type?: string
  main?: string
  types?: string
  exports?: PackageExports
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type PackageExportTarget =
  string | { [condition: string]: PackageExportTarget } | PackageExportTarget[]
type PackageExports = PackageExportTarget | Record<string, PackageExportTarget>

interface CheckError {
  label: string
  detail?: string
}

const EXPECTED_SCRIPTS: Readonly<Record<string, string>> = {
  build: 'tsc -b',
  typecheck: 'tsc -b --noEmit',
  clean: 'tsc -b --clean',
}

const tsconfigPaths =
  readJson<{ compilerOptions?: { paths?: Record<string, string[]> } }>(
    join(root, 'tsconfig.base.json'),
  )?.compilerOptions?.paths ?? {}

const buildRefs = new Set(
  (
    readJson<{ references?: { path: string }[] }>(join(root, 'tsconfig.build.json'))?.references ??
    []
  ).map((r) => r.path.replace(/^\.\/packages\//, '')),
)

const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name))

const results: { name: string; errors: CheckError[] }[] = []

for (const pkgDir of packageDirs) {
  const dirName = pkgDir.split('/').at(-1)!
  const pkg = readJson<PackageJson>(join(pkgDir, 'package.json'))
  if (!pkg?.name) continue

  const errors: CheckError[] = []

  for (const rel of ['src/index.ts', 'tsconfig.json', 'vitest.config.ts']) {
    check(errors, `${rel} exists`, existsSync(join(pkgDir, rel)))
  }

  check(errors, 'private is true', pkg.private === true, `got ${JSON.stringify(pkg.private)}`)
  check(errors, 'type is "module"', pkg.type === 'module', `got ${JSON.stringify(pkg.type)}`)

  for (const [script, expected] of Object.entries(EXPECTED_SCRIPTS)) {
    check(
      errors,
      `${script} script is "${expected}"`,
      pkg.scripts?.[script] === expected,
      `got ${JSON.stringify(pkg.scripts?.[script])}`,
    )
  }

  check(errors, `${pkg.name} in tsconfig.base.json paths`, pkg.name in tsconfigPaths)
  check(errors, `${pkg.name}/* in tsconfig.base.json paths`, `${pkg.name}/*` in tsconfigPaths)
  check(errors, `${dirName} in tsconfig.build.json references`, buildRefs.has(dirName))

  const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies }
  for (const [dep, version] of Object.entries(allDeps)) {
    if (dep.startsWith('@quimbyhq/')) {
      check(errors, `${dep} pins "*"`, version === '*', `got "${version}"`)
    }
  }

  const targets = new Set<string>()
  if (pkg.main) targets.add(pkg.main)
  if (pkg.types) targets.add(pkg.types)
  collectExportTargets(pkg.exports, targets)
  for (const sourcePath of distTargetsToSources(pkgDir, targets)) {
    check(
      errors,
      `${sourcePath.slice(pkgDir.length + 1)} exists for a package export target`,
      existsSync(sourcePath),
    )
  }

  results.push({ name: pkg.name, errors })
}

report(results)

function check(errors: CheckError[], label: string, ok: boolean, detail?: string): void {
  if (!ok) errors.push({ label, detail })
}

function collectExportTargets(target: PackageExportTarget | undefined, out: Set<string>): void {
  if (target === undefined) return
  if (typeof target === 'string') {
    out.add(target)
  } else if (Array.isArray(target)) {
    for (const item of target) collectExportTargets(item, out)
  } else {
    for (const value of Object.values(target)) collectExportTargets(value, out)
  }
}

// Map every ./dist/*.{js,d.ts} export target back to the .ts source it must come
// from, deduped — a missing source means a dangling export.
function distTargetsToSources(pkgDir: string, targets: Iterable<string>): Set<string> {
  const sources = new Set<string>()
  for (const target of targets) {
    const normalized = target.replaceAll('\\', '/')
    if (!normalized.startsWith('./dist/')) continue
    const rel = normalized
      .slice('./dist/'.length)
      .replace(/\.d\.ts$/, '.ts')
      .replace(/\.js$/, '.ts')
    sources.add(join(pkgDir, 'src', rel))
  }
  return sources
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, 'utf-8'))) as T
  } catch {
    return null
  }
}

function report(results: { name: string; errors: CheckError[] }[]): void {
  const failed = results.filter((r) => r.errors.length > 0)
  const total = failed.reduce((n, r) => n + r.errors.length, 0)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ passed: total === 0, packages: results }, null, 2))
    process.exit(total === 0 ? 0 : 1)
  }

  for (const { name, errors } of failed) {
    console.log(`\n${pc.bold(name)}`)
    for (const { label, detail } of errors) {
      console.log(`  ${pc.red('✗')} ${label}${detail ? pc.dim(` — ${detail}`) : ''}`)
    }
  }

  if (total === 0) {
    console.log(pc.green(`✓ ${results.length} packages valid`))
    process.exit(0)
  }
  console.log(
    pc.red(
      `\n✗ ${total} error${total === 1 ? '' : 's'} across ${failed.length} package${failed.length === 1 ? '' : 's'}`,
    ),
  )
  process.exit(1)
}

// Minimal JSONC stripper so tsconfig.* comments don't break JSON.parse.
function stripJsonComments(text: string): string {
  let result = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '"') {
      result += text[i++]
      while (i < text.length) {
        if (text[i] === '\\') {
          result += text[i] + text[i + 1]
          i += 2
        } else if (text[i] === '"') {
          result += text[i++]
          break
        } else {
          result += text[i++]
        }
      }
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      result += text[i++]
    }
  }
  return result
}
