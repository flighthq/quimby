import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { PublishManifest } from './publish-manifest'
import {
  bundleExternals,
  missingRuntimeDependencies,
  publishableManifest,
} from './publish-manifest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliManifestPath = join(root, 'apps', 'cli', 'package.json')
const distDir = join(root, 'apps', 'cli', 'dist')

describe('bundleExternals', () => {
  it('collects bare specifiers from every import form esbuild emits', () => {
    const source = [
      'import {x} from "citty"',
      'import{y}from"execa"',
      'const z = require("yaml")',
      'const w = await import("pathe")',
    ].join('\n')
    expect(bundleExternals([source])).toEqual(['citty', 'execa', 'pathe', 'yaml'])
  })

  it('normalizes subpaths to the package name, keeping the scope for scoped packages', () => {
    const source = 'import a from "consola/utils"\nimport b from "@clack/prompts/dist/x"'
    expect(bundleExternals([source])).toEqual(['@clack/prompts', 'consola'])
  })

  // The bundle carries BOTH builtin spellings — bare `os`/`path`/`http` beside prefixed `node:fs`.
  // Treating a bare one as a package would demand a dependency that cannot exist, blocking every
  // publish; this is exactly what the first run of the real-bundle test below caught.
  it('ignores relative paths, both builtin spellings, and interpolated strings', () => {
    const source = [
      'import a from "./chunk-ABC.js"',
      'import b from "node:fs"',
      'import c from "os"',
      'import d from "child_process"',
      'const e = `imported from "${name}"`',
      'const f = "copied from the agent dir"',
    ].join('\n')
    expect(bundleExternals([source])).toEqual([])
  })

  it('deduplicates across files', () => {
    expect(bundleExternals(['import a from "citty"', 'import b from "citty"'])).toEqual(['citty'])
  })
})

describe('missingRuntimeDependencies', () => {
  it('reports an external that no dependency field declares', () => {
    const manifest: PublishManifest = { dependencies: { citty: '^0.1.6' } }
    expect(missingRuntimeDependencies(manifest, ['citty', 'consola', 'yaml'])).toEqual([
      'consola',
      'yaml',
    ])
  })

  it('accepts an external declared in any dependency field', () => {
    const manifest: PublishManifest = {
      dependencies: { citty: '^0.1.6' },
      peerDependencies: { consola: '^3.4.2' },
      optionalDependencies: { yaml: '^2.7.1' },
    }
    expect(missingRuntimeDependencies(manifest, ['citty', 'consola', 'yaml'])).toEqual([])
  })

  it('is empty for a manifest with no externals to satisfy', () => {
    expect(missingRuntimeDependencies({}, [])).toEqual([])
  })
})

describe('publishableManifest', () => {
  it('strips every @quimbyhq/* dependency, since tsup inlines them and they are not on npm', () => {
    const manifest: PublishManifest = {
      name: 'quimby',
      dependencies: { '@quimbyhq/agent': '*', '@quimbyhq/types': '*', citty: '^0.1.6' },
    }
    expect(publishableManifest(manifest).dependencies).toEqual({ citty: '^0.1.6' })
  })

  it('strips them from peer and optional dependencies too', () => {
    const manifest: PublishManifest = {
      peerDependencies: { '@quimbyhq/git': '*', pathe: '^2.0.3' },
      optionalDependencies: { '@quimbyhq/pool': '*' },
    }
    const result = publishableManifest(manifest)
    expect(result.peerDependencies).toEqual({ pathe: '^2.0.3' })
    expect(result.optionalDependencies).toBeUndefined()
  })

  it('drops a dependency field left empty rather than publishing a vestigial {}', () => {
    const manifest: PublishManifest = { dependencies: { '@quimbyhq/utils': '*' } }
    expect('dependencies' in publishableManifest(manifest)).toBe(false)
  })

  it('leaves every non-dependency field untouched', () => {
    const manifest: PublishManifest = {
      name: 'quimby',
      version: '0.2.0',
      bin: { quimby: './dist/cli.js' },
      dependencies: { '@quimbyhq/types': '*' },
    }
    const result = publishableManifest(manifest)
    expect(result.name).toBe('quimby')
    expect(result.version).toBe('0.2.0')
    expect(result.bin).toEqual({ quimby: './dist/cli.js' })
  })

  it('does not mutate the input, so the caller can restore the original text', () => {
    const manifest: PublishManifest = { dependencies: { '@quimbyhq/types': '*', citty: '^0.1.6' } }
    publishableManifest(manifest)
    expect(manifest.dependencies).toEqual({ '@quimbyhq/types': '*', citty: '^0.1.6' })
  })

  // The regression this whole module exists for: publishing the source manifest as-is shipped 20
  // unresolvable deps, and stripping them without hoisting what they declared shipped a package
  // that installed and then crashed on `consola`. Both are checked against the REAL manifest and
  // the REAL bundle, so neither can come back through an unrelated dependency move.
  it('leaves the real apps/cli manifest able to satisfy the real bundle', (ctx) => {
    // A clean checkout has no bundle to read (`npm run ci` builds first). Reported as SKIPPED
    // rather than returning green: this is the one check standing between a dependency move and a
    // package that installs and then crashes, so "it did not run" must never read as "it passed".
    if (!existsSync(distDir)) return ctx.skip('no build output — run `npm run build` first')
    const manifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as PublishManifest
    const externals = bundleExternals(
      readdirSync(distDir)
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(distDir, file), 'utf8')),
    )
    expect(externals.length).toBeGreaterThan(0)
    expect(missingRuntimeDependencies(publishableManifest(manifest), externals)).toEqual([])
  })

  it('finds no @quimbyhq/* left in the real published manifest', () => {
    const manifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as PublishManifest
    const published = publishableManifest(manifest)
    const remaining = Object.keys(published.dependencies ?? {}).filter((name) =>
      name.startsWith('@quimbyhq/'),
    )
    expect(remaining).toEqual([])
  })
})
