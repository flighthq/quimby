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
  'reporter',
  'template',
  'git',
  'transport',
  'runtimes',
  'runtime-profile',
  'session',
  'workspace',
  'agent',
  'handoff',
  'launch',
  'server',
]

export const alias = Object.fromEntries(
  PACKAGES.map((name) => [
    `@quimbyhq/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
)

export default defineConfig({
  resolve: { alias },
  test: {
    // Never collect tests from worker clones under .quimby/, build output, the local
    // flight/ reference checkout, or the slow end-to-end integration lane (which has its
    // own config and `npm run test:integration` entry point — kept out of default `npm test`).
    exclude: [...configDefaults.exclude, '**/.quimby/**', '**/flight/**', '**/integration/**'],
  },
})
