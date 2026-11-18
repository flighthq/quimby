import { tmuxSessionName } from '@quimbyhq/paths'
import type { QuimbySandbox, SandboxShellRunner } from '@quimbyhq/runtimes'
import { getSandboxAgentPrefix } from '@quimbyhq/runtimes'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { QuimbyConfig, SSHLocation } from '@quimbyhq/types'
import { formatByteSizeKb, formatDuration, parseByteSizeKb } from '@quimbyhq/utils'

/** One git-ignored directory in an agent's clone — build output that a rebuild regenerates. */
export interface RemoteReclaimableDir {
  /** Relative to the agent's `repo/`, no trailing slash. */
  path: string
  sizeKb: number
}

/** What one remote agent is costing and whether anything in it is unlanded work. */
export interface RemoteAgentUsage {
  id: string
  /** The name its generated CLAUDE.md/AGENTS.md was rendered with — the host's own record of it. */
  name?: string
  /** Newest of its status/assignment/transcript writes and its last commit (epoch ms). */
  lastActiveAt?: number
  /** Commits since `quimby/seed`; undefined when it could not be read (treated as unsafe). */
  commitsSinceSeed?: number
  /** Uncommitted + untracked (non-ignored) paths; undefined when it could not be read. */
  dirtyFiles?: number
  live: boolean
  /** Only populated by a sized scan; already filtered through `isReclaimableIgnoredPath`. */
  reclaimable: RemoteReclaimableDir[]
}

/** One remote workspace's usage, activity and unlanded work, from `scanRemoteWorkspaceUsage`. */
export interface RemoteWorkspaceUsage {
  id: string
  /** False when the directory vanished between listing and scanning. */
  present: boolean
  agents: RemoteAgentUsage[]
  /** Whole-workspace `du`; only set by a sized scan. */
  sizeKb?: number
}

/** A remote filesystem's capacity, in KB, as `df -Pk` reports it. */
export interface RemoteDiskUsage {
  totalKb: number
  usedKb: number
  availKb: number
  mount: string
}

/** What this machine knows about who owns each remote workspace. */
export interface RemoteWorkspaceOwnership {
  /** The workspace the current repo uses — never a prune candidate. */
  activeId?: string
  /** Registered on this machine; `projectPresent` is whether its local checkout still exists. */
  claimed: ReadonlyMap<string, { repoRoot?: string; projectPresent: boolean }>
}

export interface RemotePruneCriteria {
  now: number
  /** Qualify a workspace whose newest agent activity is at least this old. */
  idleMs?: number
  /** Qualify a workspace whose registered local checkout no longer exists. */
  gone?: boolean
  /** Qualify a workspace no project on this machine has registered. */
  unclaimed?: boolean
  /** Qualify other workspaces of this repo (the original `prune-remote` duplicate sweep). */
  duplicatesOf?: { sourceRepo: string }
}

export interface RemotePruneCandidate {
  id: string
  sourceRepo?: string
  /** Why it qualified, human-readable (`idle 4mo`, `project gone`, …). */
  reasons: string[]
  /** Why it is refused anyway; a blocked candidate is listed but never removed by a sweep. */
  blocked?: string
  sizeKb?: number
}

/** Newest activity across a workspace's agents, or undefined when none has ever recorded any. */
export function getRemoteWorkspaceLastActiveAt(
  usage: Readonly<RemoteWorkspaceUsage>,
): number | undefined {
  const times = usage.agents.map((a) => a.lastActiveAt).filter((t): t is number => t !== undefined)
  return times.length > 0 ? Math.max(...times) : undefined
}

export function getRemoteWorkspaceLiveCount(usage: Readonly<RemoteWorkspaceUsage>): number {
  return usage.agents.filter((a) => a.live).length
}

export function getRemoteWorkspaceReclaimableKb(usage: Readonly<RemoteWorkspaceUsage>): number {
  return usage.agents.reduce(
    (sum, agent) => sum + agent.reclaimable.reduce((s, dir) => s + dir.sizeKb, 0),
    0,
  )
}

/**
 * Work in a workspace that exists nowhere else: commits since each agent's seed plus its dirty
 * paths. `unknown` is set when any agent could not be read — callers must treat that as "may
 * hold work", since an unreadable repo is not evidence of an empty one.
 */
export function getRemoteWorkspaceUnlandedWork(usage: Readonly<RemoteWorkspaceUsage>): {
  commits: number
  dirtyFiles: number
  unknown: boolean
} {
  let commits = 0
  let dirtyFiles = 0
  let unknown = false
  for (const agent of usage.agents) {
    if (agent.commitsSinceSeed === undefined || agent.dirtyFiles === undefined) unknown = true
    commits += agent.commitsSinceSeed ?? 0
    dirtyFiles += agent.dirtyFiles ?? 0
  }
  return { commits, dirtyFiles, unknown }
}

/** Disk usage of the filesystem holding `~/.quimby` on the host, or null when unreadable. */
export async function getRemoteDiskUsage(
  location: Readonly<SSHLocation & { host: string }>,
): Promise<RemoteDiskUsage | null> {
  const out = await getSSHTransport(location).exec(
    'df -Pk "$HOME/.quimby" 2>/dev/null || df -Pk "$HOME" 2>/dev/null || true',
  )
  return parseRemoteDiskUsage(out)
}

/**
 * Whether a git-ignored directory is safe to delete as regenerable build output.
 *
 * Ignored is not the same as disposable: `.env`, keys, and local credentials are ignored precisely
 * BECAUSE they matter. Those are almost always single files, which the scan never offers, but a
 * directory can carry the same weight (`secrets/`, `.env.d/`), so any segment that names one is
 * refused. Anything that could escape the repo is refused outright.
 */
export function isReclaimableIgnoredPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\n')) return false
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
    if (PROTECTED_SEGMENTS.some((pattern) => pattern.test(segment))) return false
  }
  return true
}

/** Every agent id with a directory in any workspace on the host. */
export async function listRemoteAgentIds(
  location: Readonly<SSHLocation & { host: string }>,
): Promise<Set<string>> {
  const out = await getSSHTransport(location).exec(
    `for d in "$HOME"/.quimby/workspaces/*/.quimby/agents/*; do [ -d "$d" ] && printf '%s\\n' "\${d##*/}"; done; true`,
  )
  return new Set(
    out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
}

/** Session names on the host's quimby tmux socket — an agent with one is live. */
export async function listRemoteLiveSessions(
  location: Readonly<SSHLocation & { host: string }>,
): Promise<Set<string>> {
  const out = await getSSHTransport(location).exec(
    "tmux -L quimby list-sessions -F '#{session_name}' 2>/dev/null || true",
  )
  return new Set(
    out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
}

export function parseRemoteDiskUsage(stdout: string): RemoteDiskUsage | null {
  // POSIX `-P` keeps each filesystem on one line; the last line is the one asked about.
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%/.test(l))
  const line = lines.at(-1)
  if (!line) return null
  const parts = line.split(/\s+/)
  const [totalKb, usedKb, availKb] = parts.slice(1, 4).map(Number)
  if (![totalKb, usedKb, availKb].every(Number.isFinite)) return null
  return { totalKb, usedKb, availKb, mount: parts.slice(5).join(' ') }
}

export function parseRemoteWorkspaceUsage(
  id: string,
  stdout: string,
  liveSessions: ReadonlySet<string>,
): RemoteWorkspaceUsage {
  const agents = new Map<string, RemoteAgentUsage>()
  const candidates = new Map<string, string[]>()
  const duLines: { kb: number; path: string }[] = []
  let root: string | undefined
  let dedupes = false
  let present = true
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    switch (parts[0]) {
      case 'QBGONE':
        present = false
        break
      case 'QBROOT':
        root = parts.slice(1).join('\t')
        break
      case 'QBDEDUP':
        dedupes = true
        break
      case 'QBDU': {
        // `du` prints "<kb>\t<path>"; the path is last and rejoined so a tab in a name cannot shift it.
        const kb = Number(parts[1])
        const path = parts.slice(2).join('\t')
        if (parts[1] && Number.isFinite(kb) && path) duLines.push({ kb, path })
        break
      }
      case 'QBAG': {
        const [, agentId, activity, commits, dirty, name] = parts
        if (!agentId) break
        const seconds = Number(activity)
        agents.set(agentId, {
          id: agentId,
          ...(name ? { name } : {}),
          ...(seconds > 0 ? { lastActiveAt: seconds * 1000 } : {}),
          ...(isCount(commits) ? { commitsSinceSeed: Number(commits) } : {}),
          ...(isCount(dirty) ? { dirtyFiles: Number(dirty) } : {}),
          live: liveSessions.has(tmuxSessionName(agentId)),
          reclaimable: [],
        })
        break
      }
      case 'QBIG': {
        const [, agentId, nestedRepo, ...rest] = parts
        const path = rest.join('\t')
        // A nested repository is someone's checkout, not build output, whatever .gitignore says.
        if (!agentId || nestedRepo === '1' || !isReclaimableIgnoredPath(path)) break
        candidates.set(agentId, [...(candidates.get(agentId) ?? []), path])
        break
      }
    }
  }
  const sizeOf = new Map(duLines.map((line) => [line.path, line.kb]))
  for (const [agentId, paths] of candidates) {
    const agent = agents.get(agentId)
    if (!agent || root === undefined) continue
    agent.reclaimable = paths
      .map((path) => ({
        path,
        sizeKb: sizeOf.get(`${root}/.quimby/agents/${agentId}/repo/${path}`),
      }))
      .filter((dir): dir is RemoteReclaimableDir => dir.sizeKb !== undefined)
      .sort((a, b) => b.sizeKb - a.sizeKb)
  }
  // With a deduping `du` the workspace line is only the remainder, so the total is every line; with
  // one that does not, the workspace line already counts everything on its own.
  const rootKb = root === undefined ? undefined : sizeOf.get(root)
  const sizeKb =
    rootKb === undefined
      ? undefined
      : dedupes
        ? duLines.reduce((sum, line) => sum + line.kb, 0)
        : rootKb
  return {
    id,
    present,
    agents: [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ...(sizeKb === undefined ? {} : { sizeKb }),
  }
}

/**
 * Delete build-output directories from one remote agent's clone. Every path is re-validated here,
 * not just at scan time, because this is the one call that cannot be undone; the list travels on
 * stdin so an unbounded set of paths never lands on a command line (or in an error message).
 *
 * Unless `includeLive`, the agent's session is re-checked IN the same invocation, immediately
 * before anything is removed: the scan that judged it idle may be minutes old on a large host,
 * and an agent started in between is exactly the one whose build tree must not vanish under it.
 * A live agent comes back as `live: true` with nothing removed.
 */
export async function removeRemoteReclaimableDirs(
  location: Readonly<SSHLocation & { host: string }>,
  workspaceId: string,
  agentId: string,
  paths: readonly string[],
  opts: Readonly<{ includeLive?: boolean }> = {},
): Promise<{ removed: string[]; live: boolean }> {
  const safe = paths.filter(isReclaimableIgnoredPath)
  if (safe.length === 0) return { removed: [], live: false }
  const repo = `"$HOME/.quimby/workspaces/"${sq(workspaceId)}"/.quimby/agents/"${sq(agentId)}"/repo"`
  // `=` makes tmux match the session name exactly; a bare target also accepts a prefix.
  const liveGuard = opts.includeLive
    ? ''
    : `tmux -L quimby has-session -t ${sq(`=${tmuxSessionName(agentId)}`)} 2>/dev/null && { printf 'QBLIVE\\n'; exit 0; }; `
  const out = await getSSHTransport(location).exec(
    `${liveGuard}cd ${repo} || exit 1; while IFS= read -r p; do [ -n "$p" ] && rm -rf -- "./$p"; done`,
    { input: `${safe.join('\n')}\n` },
  )
  if (out.includes('QBLIVE')) return { removed: [], live: true }
  return { removed: safe, live: false }
}

/**
 * The warning a low-disk host earns, or null when it has room. Shared by the launch path and the
 * server so the threshold and the remedy read identically wherever the user meets them.
 */
export function remoteDiskWarning(
  disk: Readonly<RemoteDiskUsage> | null,
  config: Readonly<QuimbyConfig> | undefined,
  hostLabel: string,
): string | null {
  if (!disk || disk.totalKb <= 0) return null
  const minFreeKb = resolveStorageMinFreeKb(config, disk.totalKb)
  if (disk.availKb >= minFreeKb) return null
  const usedPct = Math.round((disk.usedKb / disk.totalKb) * 100)
  return (
    `Remote host "${hostLabel}" is low on disk: ${formatByteSizeKb(disk.availKb)} free of ` +
    `${formatByteSizeKb(disk.totalKb)} (${usedPct}% used; storage.minFree ${describeMinFree(config)}). ` +
    `See what is reclaimable with \`quimby storage list-remote --host ${hostLabel}\`, then clear ` +
    `build output with \`quimby storage clean-remote --host ${hostLabel}\`.`
  )
}

/**
 * `storage.minFree` in KB against a filesystem of `totalKb`: a percentage or an absolute size,
 * falling back to the default on a missing or unparseable value (reported by config warnings).
 */
export function resolveStorageMinFreeKb(
  config: Readonly<QuimbyConfig> | undefined,
  totalKb: number,
): number {
  const raw = config?.storage?.minFree
  const pct = parseMinFreePercent(raw)
  if (pct !== null) return (totalKb * pct) / 100
  const kb = parseByteSizeKb(raw)
  if (kb !== null) return kb
  return (totalKb * DEFAULT_MIN_FREE_PERCENT) / 100
}

/** Whether `storage.minFree` is a value `resolveStorageMinFreeKb` understands. */
export function isValidStorageMinFree(value: string | number | undefined): boolean {
  return (
    value === undefined || parseMinFreePercent(value) !== null || parseByteSizeKb(value) !== null
  )
}

/** Run sandbox sweep scripts on an SSH host (the sandboxes of a remote agent live there). */
export function remoteSandboxShellRunner(
  location: Readonly<SSHLocation & { host: string }>,
): SandboxShellRunner {
  const transport = getSSHTransport(location)
  return (script, input) => transport.exec(script, input === undefined ? {} : { input })
}

/**
 * Measure one remote workspace: per agent, its last activity, its unlanded work and whether it is
 * live; with `sizes`, also the workspace total and each agent's reclaimable ignored directories.
 *
 * One SSH invocation per workspace, so a caller listing a host can report each as it lands rather
 * than going silent until the slowest `du` on the box finishes.
 */
export async function scanRemoteWorkspaceUsage(
  location: Readonly<SSHLocation & { host: string }>,
  id: string,
  opts: Readonly<{
    sizes?: boolean
    /** With `sizes`, also total the whole workspace (default true). Cleaning needs only the build dirs. */
    total?: boolean
    liveSessions?: ReadonlySet<string>
  }> = {},
): Promise<RemoteWorkspaceUsage> {
  const live = opts.liveSessions ?? (await listRemoteLiveSessions(location))
  const sizes = opts.sizes ?? false
  const out = await getSSHTransport(location).exec(
    remoteUsageScanScript(id, sizes, sizes && (opts.total ?? true)),
  )
  return parseRemoteWorkspaceUsage(id, out, live)
}

/**
 * Choose remote workspaces a sweep may delete. A workspace qualifies when ANY requested criterion
 * matches; it is then BLOCKED (listed, never removed) when an agent in it is live or it holds work
 * that exists nowhere else. The active workspace never qualifies. Deleting a workspace with work in
 * it is possible only by naming it to `remove-remote` — a sweep picks by pattern, and a pattern is
 * exactly what should not be trusted to decide that something nobody looked at is disposable.
 */
export function selectRemoteWorkspacePruneCandidates(
  entries: ReadonlyArray<{
    id: string
    sourceRepo?: string
    usage: Readonly<RemoteWorkspaceUsage>
  }>,
  ownership: Readonly<RemoteWorkspaceOwnership>,
  criteria: Readonly<RemotePruneCriteria>,
): RemotePruneCandidate[] {
  const out: RemotePruneCandidate[] = []
  for (const entry of entries) {
    if (entry.id === ownership.activeId || !entry.usage.present) continue
    const owner = ownership.claimed.get(entry.id)
    const reasons: string[] = []
    if (criteria.idleMs !== undefined) {
      const last = getRemoteWorkspaceLastActiveAt(entry.usage)
      if (last === undefined) reasons.push('no recorded activity')
      else if (criteria.now - last >= criteria.idleMs) {
        reasons.push(`idle ${formatDuration(criteria.now - last)}`)
      }
    }
    if (criteria.gone && owner && !owner.projectPresent) {
      reasons.push(`project gone: ${owner.repoRoot ?? '?'}`)
    }
    if (criteria.unclaimed && !owner) reasons.push('unclaimed on this machine')
    if (criteria.duplicatesOf && entry.sourceRepo === criteria.duplicatesOf.sourceRepo) {
      reasons.push("duplicate of this repo's workspace")
    }
    if (reasons.length === 0) continue
    out.push({
      id: entry.id,
      ...(entry.sourceRepo ? { sourceRepo: entry.sourceRepo } : {}),
      reasons,
      ...(entry.usage.sizeKb === undefined ? {} : { sizeKb: entry.usage.sizeKb }),
      ...blockReason(entry.usage),
    })
  }
  return out
}

/**
 * Sandboxes on a host that no agent there owns: no workspace holds an agent dir with their id
 * prefix, and no live session carries it. That is the residue of a teardown that missed — the old
 * one recomputed the wrong name, skipped role-backed agents, and never ran for a deleted workspace.
 *
 * Evidence, not proof: an agent provisioned under a custom `--host user@box:/path` base lives
 * outside `~/.quimby/workspaces` and would read as an orphan here, which is why removal is opt-in
 * and a live session always protects.
 */
export function selectOrphanSandboxes(
  sandboxes: readonly QuimbySandbox[],
  knownAgentIds: ReadonlySet<string>,
  liveSessions: ReadonlySet<string>,
): QuimbySandbox[] {
  const known = new Set([...knownAgentIds].map((id) => id.slice(0, 8).toLowerCase()))
  return sandboxes.filter((sandbox) => {
    const prefix = getSandboxAgentPrefix(sandbox.name)
    return prefix !== null && !known.has(prefix) && !liveSessions.has(`qb-${prefix}`)
  })
}

function blockReason(usage: Readonly<RemoteWorkspaceUsage>): { blocked?: string } {
  const live = getRemoteWorkspaceLiveCount(usage)
  if (live > 0) return { blocked: `${live} live session(s)` }
  const work = getRemoteWorkspaceUnlandedWork(usage)
  if (work.unknown) return { blocked: 'an agent repo could not be read — it may hold work' }
  if (work.commits > 0 || work.dirtyFiles > 0) {
    return {
      blocked: `holds unlanded work (${work.commits} commit(s), ${work.dirtyFiles} dirty file(s))`,
    }
  }
  return {}
}

function describeMinFree(config: Readonly<QuimbyConfig> | undefined): string {
  const raw = config?.storage?.minFree
  return raw !== undefined && isValidStorageMinFree(raw)
    ? String(raw)
    : `${DEFAULT_MIN_FREE_PERCENT}%`
}

function isCount(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value)
}

function parseMinFreePercent(value: string | number | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(value)
  if (!match) return null
  const pct = Number(match[1])
  return pct >= 0 && pct <= 100 ? pct : null
}

// Rows are tab-delimited and tag-prefixed so shell noise (a login banner, a `du` warning) can
// never parse as data. Every git read is guarded so a failure leaves `-` (unknown) rather than a
// `0` that would read as "nothing here" — the unsafe direction for anything deciding deletions.
//
// Sizing is ONE `du` invocation per workspace, over every build directory and then (for a total)
// the workspace itself. `du` counts each file once across its arguments, so the workspace's line is
// just the remainder and the build trees — almost all of the bytes — are walked once. Sizing each
// directory and then the whole workspace separately walked them twice, on exactly the hosts where
// that walk is the entire cost. A tiny probe confirms this `du` dedupes; if one ever does not, its
// workspace line is a full total on its own, and the parser reads it that way instead.
function remoteUsageScanScript(id: string, sizes: boolean, total: boolean): string {
  const ignoredDirs = sizes
    ? [
        'git -C "$r" -c core.quotePath=false ls-files --others --ignored --exclude-standard --directory 2>/dev/null |',
        'while IFS= read -r p; do case "$p" in */)',
        'p=${p%/}; n=0; [ -e "$r/$p/.git" ] && n=1;',
        `printf 'QBIG\\t%s\\t%s\\t%s\\n' "$aid" "$n" "$p";`,
        // A nested repository is never offered, so it is not measured apart either — its bytes
        // stay in the workspace remainder.
        '[ "$n" = 0 ] && printf "%s\\n" "$r/$p" >> "$tf";;',
        'esac; done;',
      ]
    : []
  const measure = sizes
    ? [
        `printf 'QBROOT\\t%s\\n' "$ws";`,
        'q=$(mktemp -d 2>/dev/null) && { mkdir "$q/s" && head -c 65536 /dev/zero > "$q/s/f";',
        `[ "$(du -sk "$q/s" "$q" 2>/dev/null | sed -n '2s/\\t.*//p')" -lt "$(du -sk "$q/s" 2>/dev/null | cut -f1)" ] && printf 'QBDEDUP\\n';`,
        'rm -rf "$q"; };',
        'set --; while IFS= read -r x; do set -- "$@" "$x"; done < "$tf"; rm -f "$tf";',
        ...(total ? ['set -- "$@" "$ws";'] : []),
        `[ $# -gt 0 ] && du -sk -- "$@" 2>/dev/null | while IFS= read -r line; do printf 'QBDU\\t%s\\n' "$line"; done;`,
      ]
    : []
  return [
    `ws="$HOME/.quimby/workspaces/"${sq(id)};`,
    `[ -d "$ws" ] || { printf 'QBGONE\\n'; exit 0; };`,
    ...(sizes ? ['tf=$(mktemp 2>/dev/null || echo "/tmp/qbdu.$$"); : > "$tf";'] : []),
    'mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; };',
    'for a in "$ws"/.quimby/agents/*; do',
    '[ -d "$a" ] || continue; aid=${a##*/}; r="$a/repo"; t=0;',
    'for f in "$a/status.md" "$a/assignment.md" "$a/session.log"; do',
    'if [ -e "$f" ]; then m=$(mt "$f"); [ "${m:-0}" -gt "$t" ] 2>/dev/null && t=$m; fi;',
    'done;',
    'c=-; d=-;',
    'if [ -d "$r/.git" ]; then',
    'h=$(git -C "$r" log -1 --format=%ct 2>/dev/null); [ "${h:-0}" -gt "$t" ] 2>/dev/null && t=$h;',
    'if x=$(git -C "$r" rev-list --count quimby/seed..HEAD 2>/dev/null); then c=$x; fi;',
    'if s=$(git -C "$r" status --porcelain 2>/dev/null); then d=$(printf "%s\\n" "$s" | grep -c . || true); fi;',
    ...ignoredDirs,
    'fi;',
    // The agent's name lives in host state on the machine that owns it; the copy rendered into its
    // instructions is the host's only record, and lets an unclaimed workspace still read as names.
    `nm=$(sed -n '1s/^You are \\*\\*\\([^*]*\\)\\*\\*.*/\\1/p' "$a/CLAUDE.md" "$a/AGENTS.md" 2>/dev/null | head -n 1);`,
    `printf 'QBAG\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$aid" "$t" "$c" "$d" "$nm";`,
    'done;',
    ...measure,
    'true',
  ].join(' ')
}

// Generous on purpose: when a build tool and a secret share a name, the cost of keeping a few
// gigabytes is nothing next to deleting someone's only copy of a credential.
const PROTECTED_SEGMENTS = [
  /^\.git$/,
  /^\.quimby$/,
  /^\.env/i,
  /secret/i,
  /credential/i,
  /\.(key|pem|p12|pfx)$/i,
]

const DEFAULT_MIN_FREE_PERCENT = 10
