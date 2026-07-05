import { localNewSessionArgs, prepareLocalTmuxLaunch, prepareSshLaunch } from '@quimbyhq/launch'
import { quimbyTmuxSocket } from '@quimbyhq/paths'
import { sq } from '@quimbyhq/transport'
import type {
  AgentState,
  LayoutPlan,
  LayoutPlanNode,
  LayoutPlanTerminal,
  QuimbyConfig,
  QuimbyState,
} from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { saveState } from '@quimbyhq/workspace'
import {
  loadQuimbyConfig,
  loadState,
  resolveLayoutExpr,
  resolvePresetLayout,
} from '@quimbyhq/workspace'

import type { LayoutNode } from './layout'
import { collectLayoutAgents, isServiceToken, parseLayout, serviceNameOf } from './layout'
import { createMissingPresetAgents, isHostLayoutToken } from './presetAgents'

export type LayoutPlanCommandMode = 'cli' | 'direct'

export interface ResolveLayoutPlanOptions {
  repoRoot: string
  name?: string
  useDefault?: boolean
  commandMode?: LayoutPlanCommandMode
  createMissingPresetAgents?: boolean
}

export interface LayoutTarget {
  name: string
  kind: 'layout' | 'preset'
  isDefault: boolean
}

export async function listLayoutTargets(repoRoot: string): Promise<LayoutTarget[]> {
  const config = await loadQuimbyConfig(repoRoot)
  return [
    ...Object.keys(config.presets ?? {}).map((name) => ({
      name,
      kind: 'preset' as const,
      isDefault: config.default === name,
    })),
    ...Object.keys(config.layouts ?? {}).map((name) => ({
      name,
      kind: 'layout' as const,
      isDefault: config.default === name,
    })),
  ].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

export async function resolveLayoutPlan(
  opts: Readonly<ResolveLayoutPlanOptions>,
): Promise<LayoutPlan> {
  const config = await loadQuimbyConfig(opts.repoRoot)
  const name = targetName(config, opts.name, opts.useDefault)
  const materializesPreset = Boolean(config.presets?.[name]?.layout)
  if (opts.createMissingPresetAgents && materializesPreset) {
    await createMissingPresetAgents(opts.repoRoot, config, name)
  }
  const state = await loadState(opts.repoRoot)
  return buildResolvedLayoutPlan({
    config,
    state,
    repoRoot: opts.repoRoot,
    name,
    useDefault: opts.useDefault,
    commandMode: opts.commandMode ?? 'cli',
  })
}

export interface BuildLayoutPlanOptions {
  name?: string
  useDefault?: boolean
  config: Readonly<QuimbyConfig>
  state: QuimbyState
  repoRoot: string
  commandMode?: LayoutPlanCommandMode
}

export async function buildResolvedLayoutPlan({
  name,
  useDefault,
  config,
  state,
  repoRoot,
  commandMode = 'cli',
}: BuildLayoutPlanOptions): Promise<LayoutPlan> {
  const resolvedName = targetName(config, name, useDefault)
  const expr = resolveLayoutPlanExpr(config, resolvedName)
  const parsed = parseLayout(expr)
  validateLayoutPlan(parsed, config, state)
  const root = await planNode(parsed, { config, state, repoRoot, commandMode })
  if (commandMode === 'direct' && markLocalAgentsTmux(state, parsed)) {
    await saveState(repoRoot, state)
  }

  return {
    version: 1,
    cwd: repoRoot,
    source: {
      default: Boolean(useDefault),
      expr,
      name: resolvedName,
    },
    root,
  }
}

function targetName(
  config: Readonly<QuimbyConfig>,
  name: string | undefined,
  useDefault: boolean | undefined,
): string {
  if (useDefault) {
    if (!config.default) {
      throw new Error(
        'No default preset configured. Set one with `quimby run --layout <name> --default`.',
      )
    }
    return config.default
  }
  if (!name) throw new Error('Provide a layout or preset name, or use --default.')
  return name
}

function resolveLayoutPlanExpr(config: Readonly<QuimbyConfig>, name: string): string {
  const preset = config.presets?.[name]
  if (preset?.layout) return resolvePresetLayout(config, name)
  if (config.layouts?.[name]) return resolveLayoutExpr(config, name)
  throw new Error(`Layout or preset "${name}" not found in quimby config`)
}

function validateLayoutPlan(
  node: Readonly<LayoutNode>,
  config: Readonly<QuimbyConfig>,
  state: Readonly<QuimbyState>,
): void {
  const services = config.services ?? {}
  for (const name of collectLayoutAgents(node)) {
    if (isServiceToken(name)) {
      const service = serviceNameOf(name)
      if (!services[service]) {
        const known = Object.keys(services)
        throw new Error(
          `Layout references service "${service}" (\`${name}\`), which is not defined under \`services:\`` +
            `${known.length ? ` (defined: ${known.join(', ')})` : ' (none are defined)'}.`,
        )
      }
      continue
    }
    if (!isHostLayoutToken(name) && !state.agents[name]) {
      throw new Error(`Agent "${name}" not found`)
    }
  }
}

interface PlannerContext {
  config: Readonly<QuimbyConfig>
  state: QuimbyState
  repoRoot: string
  commandMode: LayoutPlanCommandMode
}

async function planNode(node: Readonly<LayoutNode>, ctx: PlannerContext): Promise<LayoutPlanNode> {
  if (node.type === 'tabs') {
    return withWeight(
      {
        type: 'tabs',
        terminals: await Promise.all(node.names.map((name) => planTerminal(name, ctx))),
      },
      node.weight,
    )
  }
  return withWeight(
    {
      type: node.type,
      children: await Promise.all(node.children.map((child) => planNode(child, ctx))),
    },
    node.weight,
  )
}

async function planTerminal(
  name: string,
  ctx: Readonly<PlannerContext>,
): Promise<LayoutPlanTerminal> {
  if (isServiceToken(name)) return serviceTerminal(name, ctx.config, ctx.repoRoot)
  if (isHostLayoutToken(name)) return hostTerminal(name, ctx.repoRoot)
  return agentTerminal(name, ctx)
}

function serviceTerminal(
  name: string,
  config: Readonly<QuimbyConfig>,
  repoRoot: string,
): LayoutPlanTerminal {
  const service = serviceNameOf(name)
  const command = config.services?.[service] ?? ''
  return {
    kind: 'service',
    name,
    displayName: service,
    cwd: repoRoot,
    command: {
      argv: ['bash', '-l', '-c', command],
      string: command,
    },
  }
}

function hostTerminal(name: string, repoRoot: string): LayoutPlanTerminal {
  return {
    kind: 'host',
    name,
    displayName: '$',
    cwd: repoRoot,
    command: {
      argv: ['bash', '-l'],
      string: 'bash -l',
    },
  }
}

async function agentTerminal(
  name: string,
  ctx: Readonly<PlannerContext>,
): Promise<LayoutPlanTerminal> {
  const command =
    ctx.commandMode === 'direct'
      ? await directAgentCommand(ctx.state.agents[name], ctx.state, ctx.repoRoot)
      : cliAgentCommand(name)
  return {
    kind: 'agent',
    name,
    displayName: name,
    cwd: ctx.repoRoot,
    command,
  }
}

function cliAgentCommand(name: string): { argv: string[]; string: string } {
  const argv = ['quimby', 'run', name]
  return { argv, string: argv.map(shellArg).join(' ') }
}

async function directAgentCommand(
  agent: Readonly<AgentState>,
  state: QuimbyState,
  repoRoot: string,
): Promise<{ argv: string[]; string: string }> {
  if (isSSH(agent.location)) {
    const launch = await prepareSshLaunch({
      state,
      repoRoot,
      agent,
      location: agent.location,
    })
    const remoteTmuxArgs = [
      'tmux',
      '-L',
      quimbyTmuxSocket,
      '-f',
      launch.tmuxConf,
      'new-session',
      '-A',
      '-s',
      launch.sessionName,
      '-n',
      launch.windowName,
      '-c',
      launch.cwd,
      'bash',
      '-l',
      '-c',
      sq(launch.shellCmd),
    ].join(' ')
    const argv = ['ssh', '-t', ...(agent.location.port ? ['-p', String(agent.location.port)] : []), launch.host, remoteTmuxArgs] // prettier-ignore
    return { argv, string: argv.map(shellArg).join(' ') }
  }
  const launch = await prepareLocalTmuxLaunch({ state, repoRoot, agent })
  const argv = ['tmux', ...localNewSessionArgs(launch, { detached: false })]
  return { argv, string: argv.map(shellArg).join(' ') }
}

function markLocalAgentsTmux(state: QuimbyState, node: Readonly<LayoutNode>): boolean {
  let dirty = false
  for (const name of collectLayoutAgents(node)) {
    if (isHostLayoutToken(name) || isServiceToken(name)) continue
    const agent = state.agents[name]
    if (agent && !isSSH(agent.location) && !agent.tmux) {
      agent.tmux = true
      dirty = true
    }
  }
  return dirty
}

function withWeight<T extends object>(node: T, weight: number | undefined): T {
  return weight === undefined ? node : { ...node, weight }
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : sq(value)
}
