// Bundle the VS Code extension with esbuild (VS Code's recommended bundler).
//
// The extension is CommonJS and loaded by VS Code's extension host, which provides only the
// `vscode` module. Everything else is inlined — including the private @quimbyhq/* workspace
// packages, whose tsc-emitted dist/ uses extensionless ESM imports that Node cannot resolve at
// runtime, plus their (sometimes ESM-only) third-party deps that a CJS bundle cannot require().
// The result is a single self-contained dist/extension.js.
const esbuild = require('esbuild')

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // VS Code 1.95's extension host runs on Node 20 (Electron 32).
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options)
    await ctx.watch()
    console.log('esbuild: watching for changes…')
  } else {
    await esbuild.build(options)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
