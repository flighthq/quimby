import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pc from 'picocolors'

// Inline the hand-written QUIMBY.md into a generated .ts at build time. A markdown source is far
// nicer to write and diff than an escaped string literal, but the CLI ships as a single bundle
// that can't read a source file at runtime — and a `.md` import would need a text loader wired
// through tsc, tsup, AND vitest (which disagree on the mechanism). Generating a plain .ts sidesteps
// all of that: every tool just sees a normal module. The output is committed and prettier-ignored;
// `context:check` (in `npm run check`) fails if it drifts from QUIMBY.md.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'packages/template/src/QUIMBY.md')
const OUT = join(root, 'packages/template/src/quimbyContext.ts')

const checkMode = process.argv.includes('--check')

function render(): string {
  const md = readFileSync(SRC, 'utf-8')
  return (
    '// GENERATED from QUIMBY.md by `npm run context:build`. Do not edit — edit QUIMBY.md instead.\n' +
    '// The Quimby-tier agent context; {{agentName}}/{{agentId}} are substituted by renderQuimbyContext.\n' +
    `export const QUIMBY_CONTEXT = ${JSON.stringify(md)}\n`
  )
}

const generated = render()

if (checkMode) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf-8') : ''
  if (current !== generated) {
    console.error(
      pc.red('✗ quimbyContext.ts is out of sync with QUIMBY.md — run `npm run context:build`'),
    )
    process.exit(1)
  }
  console.log(pc.green('✓ quimbyContext.ts is in sync with QUIMBY.md'))
} else {
  writeFileSync(OUT, generated)
  console.log(pc.green('✓ generated quimbyContext.ts from QUIMBY.md'))
}
