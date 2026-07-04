import { readdir, rm } from 'node:fs/promises'

import { getAgentStatusMirrorDir, remoteAgentStatusMirrorDir } from '@quimbyhq/paths'
import { getTransport, sp, sq } from '@quimbyhq/transport'
import type { QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { ensureDir, writeText } from '@quimbyhq/utils'
import { join } from 'pathe'

import { formatStatusPlaceholder } from './statusSnapshot'

/**
 * Make one agent's `status/` mirror hold **exactly one file per other current agent**, so
 * `ls status/` is a correct peer roster independent of the server and of any peer's running
 * state — the surface an agent uses to discover who it can address. Reconciliation, not
 * event-patching: it keys on **state membership** (never a live session), writes a placeholder
 * for any peer whose file is absent (never clobbering real mirrored content — the poller fills
 * that), and deletes any `*.md` whose basename isn't a current agent (sweeping rename/remove
 * orphans). Idempotent and cheap, so it is safe to call every poll cycle and on every launch.
 * Works for local and SSH owners.
 */
export async function reconcileAgentStatusMirror(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  ownerName: string,
): Promise<void> {
  const owner = state.agents[ownerName]
  if (!owner) return
  const peers = Object.keys(state.agents).filter((name) => name !== ownerName)

  if (isSSH(owner.location)) {
    const dir = remoteAgentStatusMirrorDir(state.id, owner.id, owner.location.base)
    const entries = peers.map((name) => ({ name, placeholder: formatStatusPlaceholder(name) }))
    await getTransport(owner.location).exec(renderRemoteStatusReconcile(dir, entries))
    return
  }

  const dir = getAgentStatusMirrorDir(repoRoot, owner.id)
  await ensureDir(dir)

  let existing: string[] = []
  try {
    existing = await readdir(dir)
  } catch {
    existing = []
  }

  const peerSet = new Set(peers)
  for (const file of existing) {
    if (!file.endsWith('.md')) continue
    if (!peerSet.has(file.slice(0, -'.md'.length))) await rm(join(dir, file), { force: true })
  }
  for (const name of peers) {
    if (!existing.includes(`${name}.md`)) {
      await writeText(join(dir, `${name}.md`), formatStatusPlaceholder(name))
    }
  }
}

/**
 * The shell one-liner that reconciles a *remote* agent's `status/` mirror — the SSH twin of the
 * local branch of {@link reconcileAgentStatusMirror}: create the dir, write a placeholder for any
 * peer whose file is absent (never clobbering real content), then delete any `*.md` whose basename
 * isn't a current peer. A pure string builder so it is testable without a host; peer names are
 * roster-validated (`[A-Za-z0-9_-]`), so the `case` allowlist stays safe.
 */
export function renderRemoteStatusReconcile(
  dir: string,
  entries: readonly { name: string; placeholder: string }[],
): string {
  const d = sp(dir)
  const fills = entries
    .map((e) => {
      const file = sp(`${dir}/${e.name}.md`)
      return `[ -e ${file} ] || printf '%s' ${sq(e.placeholder)} > ${file};`
    })
    .join(' ')
  const allow = entries.length ? ` ${entries.map((e) => e.name).join(' ')} ` : '  '
  const sweep =
    `for f in ${d}/*.md; do [ -e "$f" ] || continue; b=$(basename "$f" .md); ` +
    `case ${sq(allow)} in *" $b "*) : ;; *) rm -f "$f" ;; esac; done`
  return `mkdir -p ${d}; ${fills} ${sweep}`
}
