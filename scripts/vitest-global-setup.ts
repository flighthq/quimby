import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TEST_TMP_DIRNAME } from './vitest-test-root'

/**
 * Sweep the suites' temp root before and after every run.
 *
 * Sweeping on **setup** as well as teardown is the load-bearing half: a crashed or killed run never
 * reaches teardown, and the old fixed-path roots (`quimby-vitest-data-<worker>`) were never removed
 * at all — so residue accumulated across every run a developer ever made. That surfaces as inode
 * exhaustion with plenty of free disk, which reads as a code failure rather than a housekeeping one
 * (one `npm test` deposited ~12k inodes; a real machine hit 100% of 1.31M).
 *
 * Because the root is swept on setup, two concurrent runs would clear each other's scratch. That is
 * the deliberate trade: bounded accumulation beats per-run uniqueness, which is exactly what leaked
 * before. `npm run ci` runs the lanes sequentially.
 */
async function sweepTestTmpRoot(): Promise<void> {
  await rm(join(tmpdir(), TEST_TMP_DIRNAME), { recursive: true, force: true })
  await sweepLegacyRoots()
}

// Before the single-root scheme, each worker wrote to a fixed `quimby-vitest-{data,config}-<n>`
// path that nothing ever removed, so an existing checkout carries residue from every run it has
// ever done (38 such roots on the machine this was found). Clearing them once on the next run
// spares the developer a manual `rm`. Matching by prefix is safe *here* — unlike the runtime's
// `quimby-index-*` / `qb-rsync-*`, these names were only ever produced by the test setup.
async function sweepLegacyRoots(): Promise<void> {
  const root = tmpdir()
  const entries = await readdir(root).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((name) => LEGACY_ROOT.test(name))
      .map((name) => rm(join(root, name), { recursive: true, force: true })),
  )
}

const LEGACY_ROOT = /^quimby-vitest-(data|config)-/

export async function setup(): Promise<void> {
  await sweepTestTmpRoot()
}

export async function teardown(): Promise<void> {
  await sweepTestTmpRoot()
}
