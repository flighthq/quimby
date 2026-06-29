import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

// Resolve every @quimbyhq/* import to that package's TypeScript source instead of
// its built dist/, so tests run on a clean checkout without a prior `npm run build`.
// Paths are absolute (anchored at the repo root, where this file lives), so the
// alias is correct whether vitest runs from the root or from a single package dir.
const PACKAGES = [
  'types',
  'errors',
  'utils',
  'paths',
  'template',
  'git',
  'transport',
  'runtimes',
  'workspace',
  'worker',
  'pack',
  'server',
]

const alias = Object.fromEntries(
  PACKAGES.map((name) => [
    `@quimbyhq/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
)

export default defineConfig({
  resolve: { alias },
  test: {
    // Never collect tests from worker clones under .quimby/, build output, or the
    // local flight/ reference checkout.
    exclude: [...configDefaults.exclude, '**/.quimby/**', '**/flight/**'],
  },
})
