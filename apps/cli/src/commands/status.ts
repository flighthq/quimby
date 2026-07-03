import type { AgentWorkSummary } from '@quimbyhq/agent'
import {
  getAgentHeadHash,
  getAgentSyncStatus,
  getAgentWorkSummary,
  parseAttestation,
} from '@quimbyhq/agent'
import { QuimbyError } from '@quimbyhq/errors'
import { readInboxParcelNames, readOutboxRecipients } from '@quimbyhq/handoff'
import { getAgentDir, remoteAgentDir } from '@quimbyhq/paths'
import { deliverStatusSnapshot, formatStatusSnapshot, getServerInfo } from '@quimbyhq/server'
import { getAgentSessionState } from '@quimbyhq/session'
import { getTransport } from '@quimbyhq/transport'
import type { AgentSessionState, AgentState, QuimbyState } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { exists, logger, readText } from '@quimbyhq/utils'
import { resolveWorkspace } from '@quimbyhq/workspace'
import { defineCommand } from 'citty'
import { join } from 'pathe'

import { formatAttestation } from '../attestation'
import { bold, cyan, dim, green, red, yellow } from '../colors'
import { page } from '../pager'
import { formatWorkSummary } from '../workSummary'

const STATUS_EXCERPT_LINES = 8

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Inspect agents: an orchestration overview, or one agent in depth',
  },
  args: {
    agent: {
      type: 'positional',
      description: 'Agent to deep-dive (omit for the overview of all agents)',
      required: false,
    },
    interactive: {
      type: 'boolean',
      alias: 'i',
      description: "Page the agent's full status.md instead of a digest",
      default: false,
    },
    to: {
      type: 'string',
      description:
        "Push <name>'s current status to this agent's inbox/status (manual twin of subscribe)",
    },
  },
  run: runStatusCommand,
})

export async function runStatusCommand({
  args,
}: {
  args: { agent?: string; interactive?: boolean; to?: string }
}) {
  const { state, repoRoot } = await resolveWorkspace()

  if (args.to) {
    await pushStatus(repoRoot, state, args.agent, args.to)
    return
  }

  if (args.agent) {
    await renderDeepDive(repoRoot, state, args.agent, args.interactive ?? false)
    return
  }

  const names = Object.keys(state.agents)
  if (names.length === 0) {
    logger.info('No agents. Run `quimby add <name>` to create an agent.')
    return
  }
  await renderOverview(repoRoot, state, names)
}

async function pushStatus(
  repoRoot: string,
  state: QuimbyState,
  from: string | undefined,
  to: string,
): Promise<void> {
  if (!from) {
    throw new QuimbyError('Provide the source agent: quimby status <from> --to <agent>')
  }
  const fromAgent = state.agents[from]
  if (!fromAgent) {
    throw new QuimbyError(`Agent "${from}" not found`)
  }
  const toAgent = state.agents[to]
  if (!toAgent) {
    throw new QuimbyError(`Agent "${to}" not found`)
  }
  const content = await readAgentFile(repoRoot, state, fromAgent, 'status.md')
  const payload = formatStatusSnapshot(from, content || '(no status)', new Date().toISOString())
  await deliverStatusSnapshot({ repoRoot, stateId: state.id, fromName: from, toAgent, payload })
  logger.success(`Pushed "${from}" status → "${to}" (inbox/status/${from}.md)`)
}

async function renderOverview(
  repoRoot: string,
  state: QuimbyState,
  names: string[],
): Promise<void> {
  const snapshots = await Promise.all(
    names.map((name) => gatherSnapshot(repoRoot, state, state.agents[name])),
  )

  console.log(bold(`Agents (${names.length})`))
  names.forEach((name, i) => {
    const snap = snapshots[i]
    const cells = [
      `  ${bold(name)}`,
      renderSession(snap.sessionState),
      countCell('inbox', snap.inbox.length),
      countCell('outbox', snap.outbox.length),
      dim(formatWorkSummary(snap.summary)),
    ]
    // The seed-vs-base axis, distinct from unmerged work — surfaced so a stale baseline
    // ("run quimby sync") is visible in the overview, not just the deep-dive.
    if (snap.behind > 0) cells.push(yellow(`${snap.behind} behind ${snap.syncRef}`))
    console.log(cells.join('  '))
  })

  const server = await getServerInfo(repoRoot)
  if (server) console.log(dim(`\nServer running on :${server.port} (PID ${server.pid})`))
}

async function renderDeepDive(
  repoRoot: string,
  state: QuimbyState,
  name: string,
  interactive: boolean,
): Promise<void> {
  const agent = state.agents[name]
  if (!agent) {
    throw new QuimbyError(`Agent "${name}" not found`)
  }

  const [snap, assignment, status] = await Promise.all([
    gatherSnapshot(repoRoot, state, agent),
    readAgentFile(repoRoot, state, agent, 'assignment.md'),
    readAgentFile(repoRoot, state, agent, 'status.md'),
  ])

  // `-i` is the escape hatch to the full status.md; the default view is always a digest.
  if (interactive) {
    await page(`${bold(name)} — status.md\n\n${status || '(no status)'}`)
    return
  }

  const seed = agent.seedCommit ? agent.seedCommit.slice(0, 8) : '(unseeded)'
  const behind = snap.behind > 0 ? yellow(` · ${snap.behind} behind ${snap.syncRef}`) : ''

  console.log(`${bold(name)}  ${renderSession(snap.sessionState)}`)
  console.log(row('assignment', assignment ? firstLine(assignment) : dim('(none)')))
  console.log(row('base', `seed ${seed} · tracks ${snap.syncRef}${behind}`))
  console.log(row('work', formatWorkSummary(snap.summary)))
  // The agent's own attestation (relayed, never a quimby-run guarantee) — shown when it recorded
  // one or a check command is configured, so a stale/absent self-report is visible before merge.
  const attestation = parseAttestation(status)
  if (attestation || agent.check) {
    const liveHash = attestation ? await getAgentHeadHash(repoRoot, state.id, agent) : null
    const text = formatAttestation(attestation, liveHash)
    console.log(
      row(
        'verify',
        !attestation ? dim(text) : attestation.result === 'pass' ? green(text) : red(text),
      ),
    )
  }
  console.log(row('inbox', renderParcelList(snap.inbox, 'unprocessed')))
  console.log(row('outbox', renderParcelList(snap.outbox, 'queued')))

  const { shown, more } = excerpt(status, STATUS_EXCERPT_LINES)
  console.log(row('status.md', shown ? '' : dim('(no status)')))
  if (shown) {
    for (const line of shown.split('\n')) console.log(`    ${dim(line)}`)
    if (more > 0)
      console.log(`    ${dim(`… ${more} more line(s) — `)}${cyan(`quimby status ${name} -i`)}`)
  }
}

interface AgentSnapshot {
  sessionState: AgentSessionState
  summary: AgentWorkSummary | null
  inbox: string[]
  outbox: string[]
  /** How far the agent's seed baseline trails the ref it tracks (the `quimby sync` axis). */
  behind: number
  syncRef: string
}

async function gatherSnapshot(
  repoRoot: string,
  state: QuimbyState,
  agent: Readonly<AgentState>,
): Promise<AgentSnapshot> {
  const [sessionState, summary, inbox, outbox, sync] = await Promise.all([
    getAgentSessionState(agent).catch((): AgentSessionState => 'stopped'),
    getAgentWorkSummary(repoRoot, state.id, agent),
    readInboxParcelNames(repoRoot, agent.id),
    readOutboxRecipients(repoRoot, agent.id),
    getAgentSyncStatus(repoRoot, agent, state.sourceRef).catch(() => null),
  ])
  return {
    sessionState,
    summary,
    inbox,
    outbox,
    behind: sync?.behind ?? 0,
    syncRef: sync?.syncRef ?? agent.syncRef ?? state.sourceRef,
  }
}

async function readAgentFile(
  repoRoot: string,
  state: QuimbyState,
  agent: Readonly<AgentState>,
  filename: string,
): Promise<string> {
  try {
    if (isSSH(agent.location)) {
      const rAgentDir = remoteAgentDir(state.id, agent.id, agent.location.base)
      return (await getTransport(agent.location).readFile(`${rAgentDir}/${filename}`)).trim()
    }
    const path = join(getAgentDir(repoRoot, agent.id), filename)
    return (await exists(path)) ? (await readText(path)).trim() : ''
  } catch {
    return ''
  }
}

function renderSession(s: AgentSessionState): string {
  if (s === 'attached') return cyan('● attached')
  if (s === 'running') return green('● running')
  return dim('○ stopped')
}

function countCell(label: string, n: number): string {
  return n > 0 ? cyan(`${label}: ${n}`) : dim(`${label}: 0`)
}

function renderParcelList(names: string[], noun: string): string {
  if (names.length === 0) return dim(`0 ${noun}`)
  return `${names.length} ${noun} — ${names.join(', ')}`
}

function row(label: string, value: string): string {
  return `  ${dim(label.padEnd(10))}  ${value}`
}

function firstLine(text: string): string {
  const [first, ...rest] = text.split('\n')
  return rest.length > 0 ? `${first} ${dim('(…)')}` : first
}

function excerpt(text: string, maxLines: number): { shown: string; more: number } {
  if (!text) return { shown: '', more: 0 }
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { shown: text, more: 0 }
  return { shown: lines.slice(0, maxLines).join('\n'), more: lines.length - maxLines }
}
