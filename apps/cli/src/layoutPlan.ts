import { QuimbyError } from '@quimbyhq/errors'
import type {
  LayoutPlan,
  LayoutPlanNode,
  LayoutPlanTerminal,
  QuimbyConfig,
  QuimbyState,
} from '@quimbyhq/types'
import { resolveLayoutExpr, resolvePresetLayout } from '@quimbyhq/workspace'

import type { LayoutNode } from './layout'
import { collectLayoutAgents, isServiceToken, parseLayout, serviceNameOf } from './layout'

const HOST_WINDOW = 'host'
const HOST_TAB_NAME = '$'

export interface LayoutPlanInput {
  name?: string
  useDefault?: boolean
  config: Readonly<QuimbyConfig>
  state: Readonly<QuimbyState>
  repoRoot: string
}

export function buildResolvedLayoutPlan({
  name,
  useDefault,
  config,
  state,
  repoRoot,
}: LayoutPlanInput): LayoutPlan {
  const resolvedName = useDefault ? resolveDefaultName(config) : name
  if (!resolvedName) {
    throw new QuimbyError('Provide a layout or preset name, or use --default.')
  }

  const expr = resolveLayoutPlanExpr(config, resolvedName)
  const parsed = parseLayout(expr)
  validateLayoutPlan(parsed, config, state)

  return {
    version: 1,
    cwd: repoRoot,
    source: {
      default: Boolean(useDefault),
      expr,
      name: resolvedName,
    },
    root: planNode(parsed, config, repoRoot),
  }
}

function resolveDefaultName(config: Readonly<QuimbyConfig>): string {
  if (!config.default) {
    throw new QuimbyError(
      'No default preset configured. Set one with `quimby run --layout <name> --default`.',
    )
  }
  return config.default
}

function resolveLayoutPlanExpr(config: Readonly<QuimbyConfig>, name: string): string {
  const preset = config.presets?.[name]
  if (preset?.layout) return resolvePresetLayout(config, name)
  if (config.layouts?.[name]) return resolveLayoutExpr(config, name)
  throw new QuimbyError(`Layout or preset "${name}" not found in quimby config`)
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
        throw new QuimbyError(
          `Layout references service "${service}" (\`${name}\`), which is not defined under \`services:\`` +
            `${known.length ? ` (defined: ${known.join(', ')})` : ' (none are defined)'}.`,
        )
      }
      continue
    }
    if (!isHostToken(name) && !state.agents[name]) {
      throw new QuimbyError(`Agent "${name}" not found`)
    }
  }
}

function planNode(
  node: Readonly<LayoutNode>,
  config: Readonly<QuimbyConfig>,
  repoRoot: string,
): LayoutPlanNode {
  if (node.type === 'tabs') {
    return withWeight(
      {
        type: 'tabs',
        terminals: node.names.map((name) => planTerminal(name, config, repoRoot)),
      },
      node.weight,
    )
  }
  return withWeight(
    {
      type: node.type,
      children: node.children.map((child) => planNode(child, config, repoRoot)),
    },
    node.weight,
  )
}

function planTerminal(
  name: string,
  config: Readonly<QuimbyConfig>,
  repoRoot: string,
): LayoutPlanTerminal {
  if (isServiceToken(name)) {
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
  if (isHostToken(name)) {
    return {
      kind: 'host',
      name,
      displayName: HOST_TAB_NAME,
      cwd: repoRoot,
      command: {
        argv: ['bash', '-l'],
        string: 'bash -l',
      },
    }
  }
  return {
    kind: 'agent',
    name,
    displayName: name,
    cwd: repoRoot,
    command: {
      argv: ['quimby', 'run', name],
      string: ['quimby', 'run', name].map(shellArg).join(' '),
    },
  }
}

function isHostToken(name: string): boolean {
  return name === HOST_WINDOW || name === HOST_TAB_NAME
}

function withWeight<T extends object>(node: T, weight: number | undefined): T {
  return weight === undefined ? node : { ...node, weight }
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
