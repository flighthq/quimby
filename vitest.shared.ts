import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

// Resolve every @quimbyhq/* import to that package's TypeScript source instead of
// its built dist/, so tests run on a clean checkout without a prior `npm run build`.
// Paths are absolute (anchored at the repo root, where this file lives), so the
// alias is correct whether vitest runs from the root or from a single package dir.
//
// READ FROM DISK, never hand-listed. This was a literal array, and two packages (`status`, `pool`)
// were added to the monorepo without being added here — so every test importing them ACROSS a
// package boundary silently resolved to their stale `dist/`, while their own colocated tests (which
// import relatively) passed. That is the worst failure shape available: a source change appears to
// have no effect, and a green suite may be testing the last build rather than the working tree.
// Deriving the list removes the drift instead of asking a reviewer to notice it.
const PACKAGES_DIR = fileURLToPath(new URL('./packages', import.meta.url))

export const alias = Object.fromEntries(
  readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`@quimbyhq/${entry.name}`, `${PACKAGES_DIR}/${entry.name}/src/index.ts`])
    .filter(([, entryPoint]) => existsSync(entryPoint)),
)

export default defineConfig({
  resolve: { alias },
  test: {
    setupFiles: [fileURLToPath(new URL('./scripts/vitest-setup.ts', import.meta.url))],
    globalSetup: [fileURLToPath(new URL('./scripts/vitest-global-setup.ts', import.meta.url))],
    // Never collect tests from worker clones under .quimby/, build output, the local
    // flight/ reference checkout, or the slow end-to-end integration lane (which has its
    // own config and `npm run test:integration` entry point — kept out of default `npm test`).
    exclude: [...configDefaults.exclude, '**/.quimby/**', '**/flight/**', '**/integration/**'],
  },
})
