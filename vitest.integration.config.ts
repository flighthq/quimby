import { configDefaults, defineConfig } from 'vitest/config'

import { alias } from './vitest.shared'

// The end-to-end integration lane: `npm run test:integration` (which builds the CLI first,
// then runs this). It drives the real built `quimby` binary against throwaway workspaces and
// spawns git / tmux / ssh, so it is deliberately kept out of the fast default `npm test`.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['integration/**/*.integration.test.ts'],
    exclude: [...configDefaults.exclude, '**/.quimby/**', '**/flight/**'],
    // Each suite mutates real processes/sockets/temp repos; run files serially and give the
    // subprocess-heavy steps generous headroom.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
