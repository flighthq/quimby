import { appendFile, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

import { QuimbyError } from '@quimbyhq/errors'
import * as git from '@quimbyhq/git'
import { getAgentDir, getQuimbyDir, getStatePath } from '@quimbyhq/paths'
import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, exists, readYaml } from '@quimbyhq/utils'
import { execa } from 'execa'
import { join } from 'pathe'

import { migrateState, saveState } from './state'
import { ensureDurableWorkspace, restoreWorkspaceLink } from './storage'

export async function resolveWorkspace(): Promise<{
  state: QuimbyState
  repoRoot: string
}> {
  const cwd = process.cwd()
  const repoRoot = await git.findRoot(cwd)

  if (!repoRoot) {
    throw new QuimbyError('Not inside a git repository. Run from within a git repo.')
  }

  const statePath = getStatePath(repoRoot)

  if (!(await exists(statePath))) {
    const sourceRepo = (await git.getRemoteUrl(repoRoot)) ?? repoRoot
    await restoreWorkspaceLink(repoRoot, { sourceRepo })
    if (!(await exists(statePath))) {
      throw new QuimbyError(
        'No quimby workspace found. Run `quimby add <name>` to create an agent, or `quimby restore` to reconnect durable storage.',
      )
    }
  }

  const state = await readYaml<QuimbyState>(statePath)
  await ensureDurableWorkspace(repoRoot, state)

  let dirty = migrateState(state)

  // One-time migration: add stable IDs if missing (existing workspaces pre-date this field).
  if (!state.id) {
    state.id = crypto.randomUUID()
    dirty = true
  }
  for (const agent of Object.values(state.agents)) {
    if (!agent.id) {
      agent.id = crypto.randomUUID()
      dirty = true
    }
    // Agents created before sync targets existed advance against the workspace ref.
    if (!agent.syncRef) {
      agent.syncRef = state.sourceRef
      dirty = true
    }
  }
  if (dirty) await saveState(repoRoot, state)

  // Agent directories are now keyed by UUID; relocate any legacy name-keyed dirs in
  // place. Runs after IDs are guaranteed present, before any id-keyed path is used.
  await migrateAgentDirs(repoRoot, state)

  // Reshape any legacy `inbox/`+`outbox/` mailbox into the explicit-lifecycle `handoff/` tree.
  // Runs after the dir is at its id-keyed path so it operates on the right agent dir.
  await migrateAgentMailboxes(repoRoot, state)

  return { state, repoRoot }
}

/**
 * One-time migration of each local agent's mailbox from the legacy `inbox/`+`outbox/`+dot-archive
 * layout to the explicit-lifecycle `handoff/` tree (plus the `status/` mirror at the agent root):
 *
 *   outbox/<t>/          → handoff/out/queued/<t>/
 *   outbox/.sent/<t>/    → handoff/out/sent/<t>/
 *   inbox/<sender-hash>/ → handoff/in/received/<sender-hash>/
 *   inbox/.done/*        → handoff/in/processed/*
 *   inbox/status/*       → status/*
 *
 * Idempotent: an agent with neither legacy dir is skipped, and the legacy dirs are removed once
 * migrated, so a second load is a no-op. Remote (SSH) agents migrate lazily on their next
 * `quimby run` (see `renderRemoteMailboxMigration`). Best-effort per agent — a single agent's
 * failure never aborts workspace load for the others.
 */
async function migrateAgentMailboxes(repoRoot: string, state: QuimbyState): Promise<void> {
  for (const agent of Object.values(state.agents)) {
    if (isSSH(agent.location)) continue
    try {
      await migrateAgentMailbox(getAgentDir(repoRoot, agent.id))
    } catch {
      // Leave a partially-migrated agent for a human to inspect rather than crash load.
    }
  }
}

async function migrateAgentMailbox(agentDir: string): Promise<void> {
  const legacyInbox = join(agentDir, 'inbox')
  const legacyOutbox = join(agentDir, 'outbox')
  const hasInbox = await exists(legacyInbox)
  const hasOutbox = await exists(legacyOutbox)
  if (!hasInbox && !hasOutbox) return

  const handoff = join(agentDir, 'handoff')
  const outQueued = join(handoff, 'out', 'queued')
  const outSent = join(handoff, 'out', 'sent')
  const inReceived = join(handoff, 'in', 'received')
  const inProcessed = join(handoff, 'in', 'processed')
  const statusMirror = join(agentDir, 'status')
  for (const dir of [outQueued, outSent, inReceived, inProcessed, statusMirror]) {
    await ensureDir(dir)
  }

  if (hasOutbox) {
    // Recipient dirs (skip the `.sent` ledger) → out/queued; `.sent/<t>` → out/sent.
    await moveChildDirsInto(legacyOutbox, outQueued, { skip: ['.sent'] })
    await moveChildDirsInto(join(legacyOutbox, '.sent'), outSent)
    await rm(legacyOutbox, { recursive: true, force: true })
  }

  if (hasInbox) {
    // `status/` is a flat set of `<peer>.md` files, not parcels — move the files, not a dir.
    await moveChildEntriesInto(join(legacyInbox, 'status'), statusMirror)
    await moveChildDirsInto(join(legacyInbox, '.done'), inProcessed)
    // Remaining parcel dirs; `status`/`.done` are already drained, so only `<sender>-<hash>` remain.
    await moveChildDirsInto(legacyInbox, inReceived, { skip: ['status', '.done'] })
    await rm(legacyInbox, { recursive: true, force: true })
  }
}

/** Move each child *directory* of `srcDir` into `destDir` (by rename), skipping named entries. */
async function moveChildDirsInto(
  srcDir: string,
  destDir: string,
  opts?: { skip?: readonly string[] },
): Promise<void> {
  if (!(await exists(srcDir))) return
  const skip = new Set(opts?.skip ?? [])
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue
    const dest = join(destDir, entry.name)
    if (await exists(dest)) continue
    await rename(join(srcDir, entry.name), dest)
  }
}

/** Move every child entry (files and dirs) of `srcDir` into `destDir` (by rename). */
async function moveChildEntriesInto(srcDir: string, destDir: string): Promise<void> {
  if (!(await exists(srcDir))) return
  for (const entry of await readdir(srcDir)) {
    const dest = join(destDir, entry)
    if (await exists(dest)) continue
    await rename(join(srcDir, entry), dest)
  }
}

/**
 * Move local agent directories from the legacy name-keyed layout
 * (`.quimby/agents/<name>`) to the UUID-keyed one (`.quimby/agents/<id>`). Idempotent:
 * skips an agent whose id-dir already exists or whose legacy dir is absent. Remote
 * (SSH) agents migrate lazily on their next `quimby run`.
 */
async function migrateAgentDirs(repoRoot: string, state: QuimbyState): Promise<void> {
  const agentsRoot = join(repoRoot, '.quimby', 'agents')
  for (const [name, agent] of Object.entries(state.agents)) {
    if (isSSH(agent.location) || name === agent.id) continue
    const legacy = join(agentsRoot, name)
    const current = join(agentsRoot, agent.id)
    if ((await exists(legacy)) && !(await exists(current))) {
      await rename(legacy, current)
    }
  }
}

export async function ensureWorkspace(repoRoot: string): Promise<QuimbyState> {
  const statePath = getStatePath(repoRoot)

  if (await exists(statePath)) {
    const state = await readYaml<QuimbyState>(statePath)
    await ensureDurableWorkspace(repoRoot, state)
    return state
  }

  const sourceRepo = (await git.getRemoteUrl(repoRoot)) ?? repoRoot
  await restoreWorkspaceLink(repoRoot, { sourceRepo })
  if (await exists(statePath)) {
    const state = await readYaml<QuimbyState>(statePath)
    await ensureDurableWorkspace(repoRoot, state)
    return state
  }

  const sourceRef = await getCurrentBranch(repoRoot)
  const snapshot = await git.getCurrentRef(repoRoot)

  const state: QuimbyState = {
    id: crypto.randomUUID(),
    sourceRepo,
    sourceRef,
    snapshot,
    createdAt: new Date().toISOString(),
    agents: {},
  }

  await ensureDir(getQuimbyDir(repoRoot))
  await ensureDurableWorkspace(repoRoot, state)
  await saveState(repoRoot, state)
  await addToGitignore(repoRoot)

  return state
}

async function getCurrentBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
    return stdout.trim()
  } catch {
    return 'main'
  }
}

async function addToGitignore(repoRoot: string): Promise<void> {
  const gitignorePath = join(repoRoot, '.gitignore')

  if (await exists(gitignorePath)) {
    const content = await readFile(gitignorePath, 'utf-8')
    if (content.split('\n').some((line) => line.trim() === '.quimby')) {
      return
    }
    await appendFile(gitignorePath, '\n.quimby\n')
  } else {
    await writeFile(gitignorePath, '.quimby\n', 'utf-8')
  }
}
