// Publishes `quimby` — the one package this repo ships. Everything under packages/ is
// `private: true` and inlined into the binary by tsup, so there is no graph to publish and no
// internal versions to pin; the whole job is to hand npm a manifest and tarball that actually work
// on a machine with no workspace.
//
// Three things have to be true of the published tarball, and none of them are true of the source
// manifest as it sits:
//
//   Deps.       apps/cli lists all 20 `@quimbyhq/*` packages as dependencies (workspace resolution
//               needs them). They are not on the registry, so a published manifest carrying them
//               fails to install — every time, for everyone. They are stripped here.
//   Externals.  Stripping them removes the only declarer of anything they hoisted. The bundle is
//               scanned and checked against the surviving dependencies BEFORE upload, because that
//               failure installs cleanly and crashes on first run.
//   Docs.       npm reads README/LICENSE from the PACKAGE directory, not the monorepo root, so
//               apps/cli would publish with a blank npm page and an MIT claim with no license text.
//               Both are staged in from the root for the publish and removed afterwards.
//
// Every mutation is undone in a `finally`, so the working tree is unchanged whatever happens —
// a failed publish must not leave a stripped manifest behind for the next `npm ci` to choke on.
//
// Idempotent: a version already on the registry is a skip, not a failure, so a re-run after a
// partial failure completes cleanly. A publish is also skipped when the target dist-tag already
// points at a NEWER version, because `npm publish --tag` moves that tag and npm offers no
// publish-without-a-tag (see snapshot-version-order.ts).
//
// Usage:
//   tsx scripts/publish-package.ts                publish to the default `latest` dist-tag
//   tsx scripts/publish-package.ts --dry-run      pack + report, no upload
//   tsx scripts/publish-package.ts --no-build     skip the build (dist must already exist)
//   tsx scripts/publish-package.ts --tag <tag>    publish under a dist-tag (e.g. next), not `latest`

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PublishManifest } from './publish-manifest'
import {
  bundleExternals,
  missingRuntimeDependencies,
  publishableManifest,
} from './publish-manifest'
import { isSnapshotVersionSuperseded } from './snapshot-version-order'

// Staged in from the repo root for the publish, then removed. npm always includes these from the
// package directory regardless of `files`, which is exactly why they have to be there.
const STAGED_DOCS = ['README.md', 'LICENSE.md'] as const

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = join(root, 'apps', 'cli')
const manifestPath = join(packageDir, 'package.json')
const distDir = join(packageDir, 'dist')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noBuild = args.includes('--no-build')
const tagIndex = args.indexOf('--tag')
const distTag = tagIndex === -1 ? undefined : args[tagIndex + 1]
// npm defaults to `latest` when --tag is absent, so the backwards-move guard covers the stable
// release path on the same terms as a snapshot.
const targetTag = distTag ?? 'latest'

if (!noBuild && !dryRun) {
  console.log('[publish] building (npm run build)…')
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
}

const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original) as PublishManifest
const id = `${manifest.name}@${manifest.version}`

if (manifest.private === true) {
  console.error(`[publish] ${manifest.name} is private:true — refusing to publish`)
  process.exit(1)
}

const publishable = publishableManifest(manifest)
const stripped = Object.keys(manifest.dependencies ?? {}).filter((n) => n.startsWith('@quimbyhq/'))
console.log(`[publish] stripped ${stripped.length} bundled workspace dep(s) from the manifest`)

// The preflight that would have caught consola/yaml. Reads the built bundle rather than trusting
// the manifest, so it asks the only question that matters: does everything this tarball imports
// still have a declarer?
if (!existsSync(distDir)) {
  console.error(`[publish] no build output at ${distDir} — run without --no-build`)
  process.exit(1)
}
const externals = bundleExternals(
  readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(distDir, file), 'utf8')),
)
const missing = missingRuntimeDependencies(publishable, externals)
if (missing.length > 0) {
  console.error(
    `[publish] the bundle imports ${missing.length} package(s) no dependency declares: ` +
      `${missing.join(', ')}\n` +
      '[publish] they were reaching the build through a bundled @quimbyhq/* package. Add them to ' +
      'apps/cli dependencies — the published tarball would install and then crash without them.',
  )
  process.exit(1)
}
console.log(`[publish] ${externals.length} runtime external(s) all declared`)

// The registry probe is async, and `scripts/` runs as CJS (the repo root declares no
// `"type": "module"`), where a top-level `await` is a hard transform error rather than a runtime
// one — the script would not run at all. So the async tail lives in a function that is invoked,
// never awaited at module scope.
void publish()

async function publish(): Promise<void> {
  if (!dryRun) {
    const state = await readRegistryState(String(manifest.name))
    if (state.hasVersion) {
      console.log(`[publish] ${id} is already on the registry — nothing to do`)
      process.exit(0)
    }
    if (
      state.tagVersion !== undefined &&
      isSnapshotVersionSuperseded(String(manifest.version), state.tagVersion)
    ) {
      console.log(
        `[publish] skipping ${id} — \`${targetTag}\` is already at ${state.tagVersion}, ` +
          'which supersedes this build',
      )
      process.exit(0)
    }
  }

  const publishArgs = ['publish', '--access', 'public', '--ignore-scripts']
  if (distTag !== undefined) publishArgs.push('--tag', distTag)
  if (dryRun) publishArgs.push('--dry-run')

  const staged: string[] = []
  try {
    writeFileSync(manifestPath, `${JSON.stringify(publishable, null, 2)}\n`)
    for (const doc of STAGED_DOCS) {
      const source = join(root, doc)
      const target = join(packageDir, doc)
      if (existsSync(source) && !existsSync(target)) {
        copyFileSync(source, target)
        staged.push(target)
      }
    }
    execFileSync('npm', publishArgs, { cwd: packageDir, stdio: 'inherit' })
    console.log(`[publish] ${dryRun ? '(dry run) ' : ''}published ${id} to \`${targetTag}\``)
  } finally {
    // Restore unconditionally: a stripped manifest or a stray README left in apps/cli would be a
    // dirty tree that the next `npm ci` or `packages:check` trips over.
    writeFileSync(manifestPath, original)
    for (const path of staged) rmSync(path, { force: true })
  }
}

/**
 * The two facts the publish decision needs: whether this exact version is already on the registry,
 * and what the target dist-tag currently points at. Both come from one abbreviated packument, so
 * the dist-tag guard costs no extra request. The registry URL comes from npm config rather than
 * being hardcoded, so a private or mirrored registry still resolves.
 *
 * A fetch that fails for any reason (a 404 for a never-published name, or a transient error) reads
 * as neither published nor superseded — the publish attempt itself is then the authority, and it
 * fails loudly rather than silently skipping a release that should have shipped.
 */
async function readRegistryState(
  name: string,
): Promise<{ hasVersion: boolean; tagVersion: string | undefined }> {
  const registry = execFileSync('npm', ['config', 'get', 'registry'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .trim()
    .replace(/\/+$/, '')
  try {
    // Scoped names carry a literal "/" that must not be read as a path separator. `quimby` is
    // unscoped today, but the replace keeps this correct if that ever changes.
    const response = await fetch(`${registry}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) return { hasVersion: false, tagVersion: undefined }
    const doc = (await response.json()) as {
      versions?: Record<string, unknown>
      'dist-tags'?: Record<string, string>
    }
    return {
      hasVersion: doc.versions?.[String(manifest.version)] !== undefined,
      tagVersion: doc['dist-tags']?.[targetTag],
    }
  } catch {
    return { hasVersion: false, tagVersion: undefined }
  }
}
