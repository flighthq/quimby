import type { AgentWorkSummary } from '@quimbyhq/agent'

/**
 * Render an agent's merge-state — work sitting on top of its seed — as a one-line signal for
 * `diff`/`status`/`list`: `"3 files, 2 commits, +140/-12 — not yet merged"`, or `"no unmerged
 * work"` when the working tree matches the seed. Deliberately avoids the word "synced", which
 * names the unrelated seed-vs-base axis (`quimby sync`). A null summary (unreadable repo) reads
 * as unavailable. Colorless — callers add any emphasis.
 */
export function formatWorkSummary(summary: Readonly<AgentWorkSummary> | null): string {
  if (!summary) return 'work state unavailable'
  const { files, insertions, deletions, commits } = summary
  if (files === 0 && commits === 0) return 'no unmerged work'
  const parts: string[] = []
  if (files > 0) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  if (commits > 0) parts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
  parts.push(`+${insertions}/-${deletions}`)
  return `${parts.join(', ')} — not yet merged`
}
