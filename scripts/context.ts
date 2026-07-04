import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pc from 'picocolors'

// Inline the hand-written QUIMBY.md into a generated .ts. A markdown source is far nicer to write
// and diff than an escaped string literal, but the CLI ships as a single bundle that can't read a
// source file at runtime — and a `.md` import would need a text loader wired through tsc, tsup, AND
// vitest (which disagree on the mechanism). Generating a plain .ts sidesteps all of that: every tool
// just sees a normal module.
//
// QUIMBY.md is the ONLY committed artifact. The generated quimbyContext.ts is gitignored and rebuilt
// automatically before every build/typecheck/test/check (the `pre*` npm hooks) and at install time
// (`prepare`), so it can never drift from QUIMBY.md and there is no second file to keep in sync.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'packages/template/src/QUIMBY.md')
const OUT = join(root, 'packages/template/src/quimbyContext.ts')

function render(): string {
  const md = readFileSync(SRC, 'utf-8')
  return (
    '// GENERATED from QUIMBY.md — gitignored build artifact, not committed. Do not edit; edit QUIMBY.md.\n' +
    '// The Quimby-tier agent context; {{agentName}}/{{agentId}} are substituted by renderQuimbyContext.\n' +
    `export const QUIMBY_CONTEXT = ${JSON.stringify(md)}\n`
  )
}

writeFileSync(OUT, render())
console.log(pc.green('✓ generated quimbyContext.ts from QUIMBY.md'))
