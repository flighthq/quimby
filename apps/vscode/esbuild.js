// Bundle the VS Code extension with esbuild (VS Code's recommended bundler).
//
// The extension is CommonJS and loaded by VS Code's extension host, which provides only the
// `vscode` module. Everything else is inlined — including the private @quimbyhq/* workspace
// packages, whose tsc-emitted dist/ uses extensionless ESM imports that Node cannot resolve at
// runtime, plus their (sometimes ESM-only) third-party deps that a CJS bundle cannot require().
// The result is a single self-contained dist/extension.js.
const esbuild = require('esbuild')
const { copyFile, cp, mkdir, rm } = require('node:fs/promises')
const { dirname, join } = require('node:path')

const watch = process.argv.includes('--watch')
const webviewAssets = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
]

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
  external: ['node-pty', 'vscode'],
  logLevel: 'info',
}

async function main() {
  if (watch) {
    await copyRuntimeNodeModules()
    await copyWebviewAssets()
    const ctx = await esbuild.context(options)
    await ctx.watch()
    console.log('esbuild: watching for changes…')
  } else {
    await esbuild.build(options)
    await copyRuntimeNodeModules()
    await copyWebviewAssets()
  }
}

async function copyRuntimeNodeModules() {
  const outDir = join('dist', 'node_modules')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await cp(packageRoot('node-pty'), join(outDir, 'node-pty'), {
    recursive: true,
    filter: (source) => !source.includes(`${join('node-pty', 'src')}${require('node:path').sep}`),
  })
}

async function copyWebviewAssets() {
  const outDir = join('dist', 'webview-assets')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const [source, dest] of webviewAssets) {
    const from = require.resolve(source, { paths: [process.cwd()] })
    const to = join(outDir, dest)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

function packageRoot(name) {
  return dirname(require.resolve(`${name}/package.json`, { paths: [process.cwd()] }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
