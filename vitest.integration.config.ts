import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

import { alias } from './vitest.shared'

// The end-to-end integration lane: `npm run test:integration` (which builds the CLI first,
// then runs this). It drives the real built `quimby` binary against throwaway workspaces and
// spawns git / tmux / ssh, so it is deliberately kept out of the fast default `npm test`.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['integration/**/*.integration.test.ts'],
    // The same isolation the unit lane gets. Without it this lane drove the real built CLI with no
    // QUIMBY_DATA_HOME override, so its throwaway workspaces were registered in the developer's
    // actual `~/.local/share/quimby` — unbounded growth in $HOME, and tests reading real user state.
    setupFiles: [fileURLToPath(new URL('./scripts/vitest-setup.ts', import.meta.url))],
    globalSetup: [fileURLToPath(new URL('./scripts/vitest-global-setup.ts', import.meta.url))],
    exclude: [...configDefaults.exclude, '**/.quimby/**', '**/flight/**'],
    // Each suite mutates real processes/sockets/temp repos; run files serially and give the
    // subprocess-heavy steps generous headroom.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
