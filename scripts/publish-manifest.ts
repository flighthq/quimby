// The pure manifest/bundle rules the publish path enforces. Kept apart from publish-package.ts so
// they are unit-testable without touching the registry, and so the regression they prevent is
// pinned by a test rather than by a comment.
//
// Quimby ships as ONE unscoped package (`quimby`). Every `@quimbyhq/*` package is `private: true`
// and tsup inlines it into the binary (`noExternal: [/^@quimbyhq\//]`), so those workspace entries
// are build-time boundaries that must NOT survive into the published manifest — they are not on the
// registry, and leaving them in makes every `npm i -g quimby` fail to resolve.
//
// Stripping them exposes a second, quieter hazard: a third-party package that only a bundled
// workspace package declared (consola and yaml were declared solely by @quimbyhq/utils) is a real
// runtime import of the bundle with nothing left to declare it. That installs cleanly and then
// crashes on first run. So the strip is paired with a check that everything the built bundle
// actually imports is still declared.

import { isBuiltin } from 'node:module'

/** A package.json, narrowed to the fields the publish path reads or rewrites. */
export interface PublishManifest {
  name?: string
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  [key: string]: unknown
}

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

// Bare specifiers in the emitted bundle: `from "x"`, `import("x")`, `require("x")`, with or without
// the space esbuild's output omits. Deliberately conservative — anything with interpolation, a
// space, a relative lead, or a `node:` scheme is not a package and is filtered below, because a
// false positive here fails a publish that should have shipped.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g

/**
 * The dependency names the built bundle still imports at runtime, normalized to package names
 * (`consola/utils` → `consola`, `@clack/prompts/x` → `@clack/prompts`). Node builtins, relative
 * paths, and anything carrying template interpolation are excluded.
 */
export function bundleExternals(sources: readonly string[]): string[] {
  const found = new Set<string>()
  for (const source of sources) {
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      const name = packageNameOf(specifier)
      if (name !== null) found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * The externals the bundle imports that no dependency field declares — the `consola`/`yaml` class
 * of bug, which only appears once the bundled workspace packages stop hoisting them. Non-empty
 * means the published tarball would install and then crash, so the publish must stop.
 */
export function missingRuntimeDependencies(
  manifest: Readonly<PublishManifest>,
  externals: readonly string[],
): string[] {
  const declared = new Set<string>()
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) declared.add(name)
  }
  return externals.filter((name) => !declared.has(name)).sort()
}

/**
 * A clone of `manifest` with every `@quimbyhq/*` entry removed from each dependency field, and any
 * field left empty removed entirely so the published manifest carries no vestigial `{}`. The input
 * is never mutated — the caller restores the on-disk file from its original text.
 */
export function publishableManifest(manifest: Readonly<PublishManifest>): PublishManifest {
  const clone = structuredClone(manifest) as PublishManifest
  for (const field of DEP_FIELDS) {
    const deps = clone[field]
    if (deps === undefined) continue
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@quimbyhq/')) delete deps[name]
    }
    if (Object.keys(deps).length === 0) delete clone[field]
  }
  return clone
}

// The package a specifier resolves to, or null when it isn't a package import at all. A scoped
// specifier keeps two segments (`@scope/name`), an unscoped one keeps the first.
function packageNameOf(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.')) return null
  // Interpolation or whitespace means this matched inside a template literal or a prose string,
  // not an import.
  if (/[${}\s\\]/.test(specifier)) return null
  const segments = specifier.split('/')
  const name = specifier.startsWith('@')
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : null
    : (segments[0] ?? null)
  // `isBuiltin` covers BOTH spellings, which matters: the bundle carries bare `os`/`path`/`http`
  // alongside prefixed `node:fs`, and treating a bare builtin as a package would demand a
  // dependency that can never exist and block every publish.
  return name === null || isBuiltin(name) ? null : name
}
