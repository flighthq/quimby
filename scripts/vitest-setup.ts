import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TEST_TMP_DIRNAME } from './vitest-test-root'

const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid)

// Everything a test writes goes under ONE root, so cleanup is a single sweep (see
// vitest-global-setup.ts) that can never touch a real quimby's temp files. That matters because the
// runtime writes `quimby-index-*`, `qb-rsync-*` and `quimby-merge-msg-*` straight into the OS temp
// dir, so a prefix-matching sweep would delete a live operation's scratch out from under it.
//
// Redirecting TMPDIR (which `os.tmpdir()` reads, and which child processes inherit) captures every
// `mkdtemp` in the suites *and* in the real CLI the integration lane spawns — without having to
// rewrite each call site or keep a prefix list in sync forever.
//
// Guarded by its own marker rather than by inspecting TMPDIR: setup files run once per test FILE
// and a worker runs many, so re-deriving the root from `tmpdir()` after the first pass would nest
// it inside itself on every subsequent file.
if (!process.env.QUIMBY_TEST_TMP_ROOT) {
  const root = join(tmpdir(), TEST_TMP_DIRNAME, worker)
  mkdirSync(root, { recursive: true })
  process.env.QUIMBY_TEST_TMP_ROOT = root
  process.env.TMPDIR = root
}

// Durable storage and user config land inside that root too. Without this the integration lane —
// which drives the real built CLI — wrote workspaces into the developer's actual
// `~/.local/share/quimby`, growing it unboundedly and making tests depend on real user state.
const testRoot = process.env.QUIMBY_TEST_TMP_ROOT
process.env.QUIMBY_DATA_HOME ??= join(testRoot, 'data')
process.env.XDG_CONFIG_HOME ??= join(testRoot, 'config')
