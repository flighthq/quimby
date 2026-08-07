import { defineConfig } from 'tsup'

// The @quimbyhq/* packages are private workspace packages whose tsc-emitted
// dist/ uses extensionless ESM imports (not Node-runnable on their own). They
// exist for typechecking and editor resolution; the shipped CLI inlines them so
// the binary is self-contained. Third-party deps stay external.
const noExternal = [/^@quimbyhq\//]

// Only the CLI is built for distribution. `src/index.ts` deliberately has no bundle entry: it is
// the type surface a future curated SDK package would expose, not a surface `quimby` itself ships.
// Building it emitted a declaration file that `noExternal` could NOT make self-contained — the dts
// rollup keeps `export { AgentState } from '@quimbyhq/types'`, naming a private package that the
// published manifest strips — so a consumer's `tsc` failed against a runtime bundle that worked
// perfectly. Rather than ship a broken type surface, quimby ships none, and the manifest
// advertises only `bin`.
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
])
