import type { TmuxSessionSummary } from '@quimbyhq/session'
import { listQuimbyTmuxSessions } from '@quimbyhq/session'
import type { QuimbyState } from '@quimbyhq/types'
import { listStorageWorkspaces, readStoredState } from '@quimbyhq/workspace'
import { basename } from 'pathe'

/** What a live quimby tmux session is: a durable agent, or one of a dashboard's ephemeral views. */
export type PoolSessionKind = 'agent' | 'dashboard' | 'view' | 'unknown'

export interface PoolSession extends TmuxSessionSummary {
  kind: PoolSessionKind
  /** Milliseconds since the session's last activity, at the time the inventory was taken. */
  idleMs: number
  /** The short agent id a `qb-<id8>` session is named for. */
  agentId?: string
  /** The agent's display name, when a workspace still claims that id. */
  agentName?: string
  projectId?: string
  /**
   * An agent session no known workspace claims — the workspace was removed (or its agent was)
   * while the session kept running. Nothing will ever reattach to it, so it is pure waste.
   */
  orphan: boolean
}

export interface PoolProject {
  id: string
  /** The repo directory name when known, else the short project id. */
  label: string
  repoRoot?: string
  sessions: PoolSession[]
}

export interface PoolInventory {
  projects: PoolProject[]
  /** Agent sessions with no owning workspace, plus dashboards/views of a vanished project. */
  orphans: PoolSession[]
  totals: {
    sessions: number
    agents: number
    attached: number
    orphans: number
  }
}

/**
 * Every session on quimby's tmux server, joined to the workspace that owns it — the pool-wide
 * answer to "how many agents are running, and where", which no per-project view can give: the
 * tmux socket is shared by every quimby project on this machine, while `quimby list` only ever
 * sees the agents of the workspace you are standing in.
 *
 * `now` is injected so callers (and tests) can take a consistent reading; it defaults to the
 * current clock. A workspace whose stored state can't be read is skipped rather than fatal —
 * its sessions then surface as orphans, which is the honest reading of "nothing claims this".
 */
export async function getPoolInventory(
  opts: Readonly<{ now?: number; currentState?: Readonly<QuimbyState> }> = {},
): Promise<PoolInventory> {
  const now = opts.now ?? Date.now()
  const sessions = await listQuimbyTmuxSessions()
  const owners = await loadWorkspaceOwners(opts.currentState)

  const byProject = new Map<string, PoolProject>()
  const orphans: PoolSession[] = []

  for (const summary of sessions) {
    const session = classifyPoolSession(summary, now, owners)
    const project = session.projectId ? owners.projects.get(session.projectId) : undefined
    if (!project) {
      orphans.push(session)
      continue
    }
    const bucket = byProject.get(project.id) ?? { ...project, sessions: [] }
    bucket.sessions.push(session)
    byProject.set(project.id, bucket)
  }

  const projects = [...byProject.values()].sort((a, b) => a.label.localeCompare(b.label))
  for (const project of projects) project.sessions.sort(byIdleThenName)
  orphans.sort(byIdleThenName)

  return {
    projects,
    orphans,
    totals: {
      sessions: sessions.length,
      agents: [...projects.flatMap((p) => p.sessions), ...orphans].filter((s) => s.kind === 'agent')
        .length,
      attached: sessions.filter((s) => s.attached).length,
      orphans: orphans.length,
    },
  }
}

/** The workspaces and agent ids a session name can be resolved against. */
export interface PoolOwners {
  projects: Map<string, Omit<PoolProject, 'sessions'>>
  /** Short agent id (`qb-<id8>`) → its project id and display name. */
  agents: Map<string, { projectId: string; agentName: string }>
}

/**
 * Read the tmux session name back into what created it. The naming is quimby's own
 * (`qb-<agentId8>`, `qb-dash-<projectId>`, `qbv-<projectId>-<n>`), so classification is pure
 * string work; the *ownership* half comes from `owners`, and its absence is what makes an
 * agent session an orphan.
 */
export function classifyPoolSession(
  summary: Readonly<TmuxSessionSummary>,
  now: number,
  owners: Readonly<PoolOwners>,
): PoolSession {
  const idleMs = Math.max(0, now - summary.activityAt)
  const base = { ...summary, idleMs }

  const dashProject = matchProjectPrefix(summary.name, DASHBOARD_PREFIX, owners)
  if (dashProject) return { ...base, kind: 'dashboard', projectId: dashProject, orphan: false }

  const viewProject = matchProjectPrefix(summary.name, VIEW_PREFIX, owners)
  if (viewProject) return { ...base, kind: 'view', projectId: viewProject, orphan: false }

  if (summary.name.startsWith(DASHBOARD_PREFIX) || summary.name.startsWith(VIEW_PREFIX)) {
    // A dashboard/view whose project id resolves to nothing — the workspace is gone.
    return {
      ...base,
      kind: summary.name.startsWith(DASHBOARD_PREFIX) ? 'dashboard' : 'view',
      orphan: true,
    }
  }

  if (summary.name.startsWith(AGENT_PREFIX)) {
    const agentId = summary.name.slice(AGENT_PREFIX.length)
    const owner = owners.agents.get(agentId)
    return {
      ...base,
      kind: 'agent',
      agentId,
      ...(owner ? { agentName: owner.agentName, projectId: owner.projectId } : {}),
      orphan: !owner,
    }
  }

  return { ...base, kind: 'unknown', orphan: true }
}

/**
 * Index every durable workspace by project id and by its agents' short ids. The current
 * workspace is folded in explicitly so a project that has not been materialized into durable
 * storage yet still resolves its own sessions by name.
 */
export async function loadWorkspaceOwners(
  currentState?: Readonly<QuimbyState>,
): Promise<PoolOwners> {
  const projects = new Map<string, Omit<PoolProject, 'sessions'>>()
  const agents = new Map<string, { projectId: string; agentName: string }>()

  const record = (state: Readonly<QuimbyState>, repoRoot?: string): void => {
    projects.set(state.id, {
      id: state.id,
      label: repoRoot ? basename(repoRoot) : state.id.slice(0, 8),
      ...(repoRoot ? { repoRoot } : {}),
    })
    for (const [agentName, agent] of Object.entries(state.agents ?? {})) {
      if (agent?.id) agents.set(agent.id.slice(0, 8), { projectId: state.id, agentName })
    }
  }

  for (const workspace of await listStorageWorkspaces()) {
    if (!workspace.exists) continue
    const state = await readStoredState(workspace.id).catch(() => null)
    if (state) record(state, workspace.repoRoot)
  }
  if (currentState) {
    const known = projects.get(currentState.id)
    record(currentState, known?.repoRoot)
  }

  return { projects, agents }
}

// The session-name prefixes quimby mints, mirroring `@quimbyhq/paths` (`tmuxSessionName`,
// `dashboardSessionName`, `dashboardViewPrefix`). Held as literals because classification reads
// them back off a name tmux reports — `inventory.test.ts` pins them against the paths builders,
// so a rename there fails here rather than silently turning every session into an orphan.
const AGENT_PREFIX = 'qb-'
const DASHBOARD_PREFIX = 'qb-dash-'
const VIEW_PREFIX = 'qbv-'

// The longest project-id match wins so a `qbv-<projectId>-<n>` view never binds to a prefix of
// another project's id; unmatched returns undefined, which reads as "no workspace claims this".
function matchProjectPrefix(
  name: string,
  prefix: string,
  owners: Readonly<PoolOwners>,
): string | undefined {
  if (!name.startsWith(prefix)) return undefined
  const rest = name.slice(prefix.length)
  let best: string | undefined
  for (const id of owners.projects.keys()) {
    if (rest === id || rest.startsWith(`${id}-`)) {
      if (!best || id.length > best.length) best = id
    }
  }
  return best
}

function byIdleThenName(a: Readonly<PoolSession>, b: Readonly<PoolSession>): number {
  if (a.attached !== b.attached) return a.attached ? -1 : 1
  if (a.idleMs !== b.idleMs) return a.idleMs - b.idleMs
  return (a.agentName ?? a.name).localeCompare(b.agentName ?? b.name)
}
