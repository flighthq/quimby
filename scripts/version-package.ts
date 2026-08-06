// Sets the published package's version — the bump run before tagging a release, and the stamp CI
// applies before a snapshot publish.
//
// Only apps/cli is touched. Every `@quimbyhq/*` package is `private: true` and bundled into the
// binary, so nothing ever resolves them BY VERSION; stamping them would be diff noise that implies
// a published graph quimby does not have. (Flight stamps its whole graph because every package
// there really is published under locked versioning.)
//
// Usage: tsx scripts/version-package.ts <version>   (e.g. 0.3.0)

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'apps', 'cli', 'package.json')

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: tsx scripts/version-package.ts <version>   (e.g. 0.3.0)')
  process.exit(1)
}

const text = readFileSync(manifestPath, 'utf8')
// Replace only the top-level "version" line so the diff is one line, not a reserialize that would
// reorder keys and churn the manifest on every snapshot build.
const updated = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`)
if (updated === text) {
  console.error(`[version:package] no "version" field found in ${manifestPath}`)
  process.exit(1)
}
writeFileSync(manifestPath, updated)

console.log(`[version:package] set quimby to ${version}`)
