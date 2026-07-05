import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/extension.ts'],
  external: ['vscode'],
  format: ['cjs'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  clean: true,
  outExtension: () => ({ js: '.js' }),
})
