import { defineConfig } from 'tsup'

// The @quimbyhq/* packages are private workspace packages whose tsc-emitted
// dist/ uses extensionless ESM imports (not Node-runnable on their own). They
// exist for typechecking and editor resolution; the shipped CLI inlines them so
// the binary is self-contained. Third-party deps stay external.
const noExternal = [/^@quimbyhq\//]

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    clean: true,
    target: 'node22',
    skipNodeModulesBundle: true,
    noExternal,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    target: 'node22',
    skipNodeModulesBundle: true,
    noExternal,
  },
])
