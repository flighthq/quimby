import { addAgent, syncAgent } from '@quimbyhq/agent'
import { findRoot } from '@quimbyhq/git'
import { handoffWork } from '@quimbyhq/handoff'
import { buildResolvedLayoutPlan, listLayoutTargets, resolveLayoutPlan } from '@quimbyhq/layout'
import type { Reporter } from '@quimbyhq/reporter'
import { getServerInfo, type QuimbyServerHandle, startServer } from '@quimbyhq/server'
import { nudgeAgentSession } from '@quimbyhq/session'
import type { LayoutPlanNode, LayoutPlanTerminal } from '@quimbyhq/types'
import { loadQuimbyConfig, loadState } from '@quimbyhq/workspace'
import * as vscode from 'vscode'

const LAST_LAYOUT_KEY = 'quimby.lastLayout'
const SINGLE_AGENT_LAYOUT_NAME = '__vscode_agent__'
// Names of the terminals the current layout opened, persisted so `Close Layout` can find and
// dispose them even after a window reload (VS Code restores terminal editors, but the extension's
// in-memory session does not survive).
const LAYOUT_TERMINALS_KEY = 'quimby.layoutTerminals'

interface StoredLayout {
  name?: string
  useDefault?: boolean
}

interface LayoutSession {
  label: string
  terminals: vscode.Terminal[]
}

interface LayoutQuickPickItem extends vscode.QuickPickItem {
  target: {
    name: string
    kind: 'layout' | 'preset'
  }
}

interface AgentQuickPickItem extends vscode.QuickPickItem {
  agentName?: string
  add?: boolean
}

let repoRoot: string | null = null
let ownedServer: QuimbyServerHandle | null = null
let layoutSession: LayoutSession | null = null
let extensionContext: vscode.ExtensionContext | null = null
let log: vscode.LogOutputChannel | null = null
// Always-visible proof the extension is alive IN THIS window, plus a one-click close control —
// the layout has no other discoverable affordance, and a status-bar item disambiguates which of
// several Extension Development Host windows actually owns the live session.
let statusBarItem: vscode.StatusBarItem | null = null
const agentTerminals = new Map<string, vscode.Terminal>()
const terminalAgents = new Map<vscode.Terminal, string>()

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context
  log = vscode.window.createOutputChannel('Quimby', { log: true })
  context.subscriptions.push(log)
  log.info('Quimby extension activated')
  context.subscriptions.push(
    vscode.commands.registerCommand('quimby.openAgent', () => runCommand(() => openAgentCommand())),
    vscode.commands.registerCommand('quimby.addAgent', () => runCommand(() => addAgentCommand())),
    vscode.commands.registerCommand('quimby.syncAgentTerminal', (terminal?: vscode.Terminal) =>
      runCommand(() => syncAgentTerminalCommand(terminal)),
    ),
    vscode.commands.registerCommand('quimby.handoffAgentTerminal', (terminal?: vscode.Terminal) =>
      runCommand(() => handoffAgentTerminalCommand(terminal)),
    ),
    vscode.commands.registerCommand('quimby.reconnectAgentTerminal', (terminal?: vscode.Terminal) =>
      runCommand(() => reconnectAgentTerminalCommand(terminal)),
    ),
    vscode.commands.registerCommand('quimby.closeAgentTerminal', (terminal?: vscode.Terminal) =>
      runCommand(() => closeAgentTerminalCommand(terminal)),
    ),
    vscode.commands.registerCommand('quimby.home', () => runCommand(() => showHome(context))),
    vscode.commands.registerCommand('quimby.openLayout', () =>
      runCommand(() => openLayoutCommand(context)),
    ),
    vscode.commands.registerCommand('quimby.restoreLastLayout', () =>
      runCommand(async () => {
        await restoreLastLayout(context)
      }),
    ),
    vscode.commands.registerCommand('quimby.closeLayout', () => {
      log?.info('command: quimby.closeLayout')
      const closed = closeLayout()
      void vscode.window.showInformationMessage(
        closed > 0
          ? `Quimby: closed ${closed} layout terminal(s).`
          : 'Quimby: no layout terminals to close.',
      )
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const name = terminalAgents.get(terminal)
      if (!name) return
      terminalAgents.delete(terminal)
      if (agentTerminals.get(name) === terminal) agentTerminals.delete(name)
    }),
    { dispose: () => void stopOwnedServer() },
    { dispose: () => void closeLayout() },
    { dispose: () => disposeAgentTerminals() },
  )

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  context.subscriptions.push(statusBarItem)
  updateStatusBar()

  repoRoot = await resolveRepoRoot()
  if (!repoRoot) {
    await vscode.window.showErrorMessage(
      'Quimby could not find a git repository for this workspace.',
    )
    return
  }

  const root = repoRoot
  await safely('suppressTerminalKillConfirmation', () => suppressTerminalKillConfirmation())
  await safely('startEmbeddedServer', () => startEmbeddedServer(root))
  if (shouldRestoreLastLayout()) {
    await runCommand(async () => {
      const restored = await restoreLastLayout(context, { quiet: true })
      if (!restored) await showHome(context)
    })
  }
}

export async function deactivate(): Promise<void> {
  disposeAgentTerminals()
  closeLayout()
  await stopOwnedServer()
}

async function showHome(context: vscode.ExtensionContext): Promise<void> {
  const root = await requireRepoRoot()
  const targets = await listLayoutTargets(root)
  const last = context.workspaceState.get<StoredLayout>(LAST_LAYOUT_KEY)
  const server = await getServerInfo(root)
  const message = [
    `Quimby workspace: ${root}`,
    `layouts/presets: ${targets.length}`,
    `server: ${server ? `running on ${server.port}` : 'starting with extension'}`,
    `last layout: ${last?.useDefault ? 'default' : (last?.name ?? 'none')}`,
  ].join(' | ')
  const action = await vscode.window.showInformationMessage(
    message,
    'Open Default',
    'Open Layout',
    'Restore Last',
    'Close Layout',
  )
  if (action === 'Open Default') await openLayout(context, { useDefault: true })
  else if (action === 'Open Layout') await openLayoutCommand(context)
  else if (action === 'Restore Last') await restoreLastLayout(context)
  else if (action === 'Close Layout') closeLayout()
}

async function openLayoutCommand(context: vscode.ExtensionContext): Promise<void> {
  const root = await requireRepoRoot()
  const targets = await listLayoutTargets(root)
  if (targets.length === 0) {
    await vscode.window.showErrorMessage('No Quimby layouts or presets are configured.')
    return
  }
  const items = targets.map((target): LayoutQuickPickItem => ({
    description: target.isDefault ? `${target.kind}, default` : target.kind,
    label: `${target.isDefault ? '$(star) ' : ''}${target.name}`,
    target: { kind: target.kind, name: target.name },
  }))
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open Quimby layout or preset',
  })
  if (!picked) return
  await openLayout(context, { name: picked.target.name })
}

async function addAgentCommand(): Promise<void> {
  const root = await requireRepoRoot()
  const name = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: 'builder4',
    prompt: 'New Quimby agent name',
    validateInput: validateAgentNameInput,
  })
  if (!name) return
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Adding Quimby agent "${name}"`,
    },
    async () => {
      await addAgent(root, name)
    },
  )
  await vscode.window.showInformationMessage(`Quimby agent "${name}" added.`)
  await openAgent(name)
}

async function openAgentCommand(): Promise<void> {
  const picked = await pickAgent({ includeAdd: true })
  if (!picked) return
  if (picked.add) {
    await addAgentCommand()
    return
  }
  if (picked.agentName) await openAgent(picked.agentName)
}

async function openAgent(agentName: string): Promise<void> {
  const existing = agentTerminals.get(agentName)
  if (existing) {
    existing.show()
    return
  }
  await reconnectAgent(agentName)
}

async function restoreLastLayout(
  context: vscode.ExtensionContext,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  const last = context.workspaceState.get<StoredLayout>(LAST_LAYOUT_KEY)
  if (!last) {
    if (!opts.quiet)
      await vscode.window.showInformationMessage('No Quimby layout has been opened yet.')
    return false
  }
  await openLayout(context, last)
  return true
}

async function openLayout(context: vscode.ExtensionContext, target: StoredLayout): Promise<void> {
  const root = await requireRepoRoot()
  const plan = await resolveLayoutPlan({
    repoRoot: root,
    name: target.name,
    useDefault: target.useDefault,
    commandMode: 'direct',
    createMissingPresetAgents: true,
  })
  log?.info(`openLayout: "${plan.source.name ?? 'default'}"`)
  closeLayout()
  layoutSession = { label: plan.source.name ?? 'default', terminals: [] }
  openLayoutTerminals(plan.root, layoutSession)
  updateStatusBar()
  log?.info(`openLayout: created ${layoutSession.terminals.length} terminal(s)`)
  await context.workspaceState.update(
    LAYOUT_TERMINALS_KEY,
    layoutSession.terminals
      .map((terminal) => terminal.creationOptions.name)
      .filter((name): name is string => name !== undefined),
  )
  await context.workspaceState.update(LAST_LAYOUT_KEY, {
    name: plan.source.name,
    useDefault: target.useDefault,
  })
  await vscode.window.showInformationMessage(`Opened Quimby layout "${plan.source.name}".`)
}

// Explicit editor columns, one per agent pane. Using a fixed column (not `Beside`) is what makes
// the panes land side by side: several terminals are created synchronously in a loop, which does
// not give VS Code time to advance the "active" editor group that `Beside` splits from — so
// `Beside` panes would otherwise all resolve beside the first group and stack into one.
const EDITOR_COLUMNS: readonly vscode.ViewColumn[] = [
  vscode.ViewColumn.One,
  vscode.ViewColumn.Two,
  vscode.ViewColumn.Three,
  vscode.ViewColumn.Four,
  vscode.ViewColumn.Five,
  vscode.ViewColumn.Six,
  vscode.ViewColumn.Seven,
  vscode.ViewColumn.Eight,
  vscode.ViewColumn.Nine,
]

// Open the layout's terminals in the two homes VS Code already has:
//  - `agent` terminals go to the EDITOR area, one group per pane, side by side (agents that
//    share a group stack as editor tabs within their column).
//  - `host`/`service` terminals go to the real terminal PANEL — that is exactly what the tmux
//    "bottom pane" was simulating, so in VS Code they become actual panel terminals.
// VS Code's editor grid can't reproduce arbitrary row/column nesting, so the tree is flattened
// to a left-to-right sequence of panes (a `/` rows split renders beside rather than stacked).
function openLayoutTerminals(root: LayoutPlanNode, session: LayoutSession): void {
  let editorPanes = 0
  let firstEditor: vscode.Terminal | null = null
  for (const terminals of flattenTabGroups(root)) {
    const agents = terminals.filter((leaf) => leaf.kind === 'agent')
    const shells = terminals.filter((leaf) => leaf.kind !== 'agent')
    if (agents.length > 0) {
      const viewColumn = EDITOR_COLUMNS[editorPanes] ?? vscode.ViewColumn.Beside
      for (const leaf of agents) {
        const terminal = spawnLayoutTerminal(leaf, { viewColumn }, session)
        firstEditor ??= terminal
      }
      editorPanes++
    }
    for (const leaf of shells) spawnLayoutTerminal(leaf, vscode.TerminalLocation.Panel, session)
  }
  ;(firstEditor ?? session.terminals[0])?.show()
}

function spawnLayoutTerminal(
  leaf: Readonly<LayoutPlanTerminal>,
  location: vscode.TerminalOptions['location'],
  session: LayoutSession,
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: leaf.displayName,
    cwd: leaf.cwd,
    location,
    iconPath: leaf.kind === 'agent' ? quimbyBadgeIcon() : undefined,
    // Don't let VS Code revive these across a window reload: otherwise the reload restores the
    // terminals AND `restoreLastLayout` re-creates them, producing duplicates that Close Layout
    // can't fully clear. The extension re-opens the layout itself on activation instead.
    isTransient: true,
  })
  const where =
    typeof location === 'object' && location && 'viewColumn' in location
      ? `editor col ${String(location.viewColumn)}`
      : location === vscode.TerminalLocation.Panel
        ? 'panel'
        : 'editor'
  log?.info(`open terminal "${leaf.displayName}" (${leaf.kind}) → ${where}`)
  session.terminals.push(terminal)
  terminal.sendText(leaf.command.string)
  return terminal
}

// Collapse the layout tree to an ordered list of tab-groups (each a set of terminals that share
// one pane). Row/column nesting is flattened to a left-to-right sequence.
function flattenTabGroups(node: LayoutPlanNode): LayoutPlanTerminal[][] {
  return node.type === 'tabs' ? [node.terminals] : node.children.flatMap(flattenTabGroups)
}

function disposeAgentTerminals(): void {
  for (const terminal of agentTerminals.values()) terminal.dispose()
  agentTerminals.clear()
  terminalAgents.clear()
}

async function closeAgentTerminalCommand(terminal?: vscode.Terminal): Promise<void> {
  const agentName = await requireAgentNameForTerminal(terminal)
  agentTerminals.get(agentName)?.dispose()
}

async function handoffAgentTerminalCommand(terminal?: vscode.Terminal): Promise<void> {
  await handoffAgentWork(await requireAgentNameForTerminal(terminal))
}

async function reconnectAgent(agentName: string): Promise<void> {
  agentTerminals.get(agentName)?.dispose()
  const root = await requireRepoRoot()
  const placeholder = createStartingAgentTerminal(agentName, root)
  agentTerminals.set(agentName, placeholder)
  terminalAgents.set(placeholder, agentName)
  log?.info(`open agent terminal placeholder: ${agentName}`)
  placeholder.show()

  const leaf = await resolveSingleAgentTerminal(root, agentName)
  if (agentTerminals.get(agentName) !== placeholder) return

  const terminal = vscode.window.createTerminal({
    name: agentName,
    cwd: leaf.cwd,
    color: new vscode.ThemeColor('terminal.ansiYellow'),
    iconPath: quimbyBadgeIcon(),
    isTransient: true,
    location: vscode.TerminalLocation.Editor,
  })
  terminalAgents.delete(placeholder)
  agentTerminals.set(agentName, terminal)
  terminalAgents.set(terminal, agentName)
  log?.info(`open agent terminal: ${agentName}`)
  terminal.show()
  placeholder.dispose()
  terminal.sendText(leaf.command.string)
}

async function reconnectAgentTerminalCommand(terminal?: vscode.Terminal): Promise<void> {
  await reconnectAgent(await requireAgentNameForTerminal(terminal))
}

async function syncAgentTerminalCommand(terminal?: vscode.Terminal): Promise<void> {
  await syncAgentWork(await requireAgentNameForTerminal(terminal))
}

async function handoffAgentWork(agentName: string): Promise<void> {
  const recipient = await pickAgent({ exclude: agentName })
  if (!recipient?.agentName) return
  const message = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: 'Optional note for the recipient',
    prompt: `Handoff ${agentName} to ${recipient.agentName}`,
  })
  if (message === undefined) return
  const root = await requireRepoRoot()
  const state = await loadState(root)
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Handing off ${agentName} to ${recipient.agentName}`,
    },
    async () => {
      const result = await handoffWork(
        {
          state,
          repoRoot: root,
          from: agentName,
          to: recipient.agentName,
          message: message.trim() || undefined,
        },
        vscodeReporter(),
      )
      if (result.nudgeText !== null) {
        await nudgeAgentSession({
          agent: state.agents[result.to],
          displayName: result.to,
          reporter: vscodeReporter(),
          text: result.nudgeText,
        })
      }
    },
  )
  await vscode.window.showInformationMessage(`Quimby handoff queued for "${recipient.agentName}".`)
}

async function syncAgentWork(agentName: string): Promise<void> {
  const root = await requireRepoRoot()
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Syncing Quimby agent "${agentName}"`,
    },
    () => syncAgent(root, agentName),
  )
  const verb = result.rebased ? `rebased ${result.commitsReplayed} commit(s)` : 'already current'
  await vscode.window.showInformationMessage(`Quimby sync complete: ${verb}.`)
}

function agentNameForTerminal(terminal: vscode.Terminal | undefined): string | null {
  if (!terminal) return null
  return terminalAgents.get(terminal) ?? null
}

function quimbyBadgeIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('shield')
}

function createStartingAgentTerminal(agentName: string, cwd: string): vscode.Terminal {
  return vscode.window.createTerminal({
    name: agentName,
    cwd,
    color: new vscode.ThemeColor('terminal.ansiYellow'),
    iconPath: quimbyBadgeIcon(),
    isTransient: true,
    location: vscode.TerminalLocation.Editor,
    shellPath: process.env.SHELL || '/bin/sh',
    shellArgs: [
      '-c',
      [
        `printf '\\033[1mStarting Quimby agent "${shellSingleQuote(agentName)}"...\\033[0m\\n'`,
        "printf 'Resolving workspace, transport, and tmux session. This placeholder will be replaced automatically.\\n'",
        "printf 'Input typed here is ignored.\\n'",
        "trap '' INT TERM",
        'while :; do sleep 3600; done',
      ].join('; '),
    ],
  })
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''")
}

async function requireAgentNameForTerminal(terminal?: vscode.Terminal): Promise<string> {
  const targetTerminal = terminal ?? vscode.window.activeTerminal
  const agentName = agentNameForTerminal(targetTerminal)
  if (agentName) return agentName
  const terminalName = targetTerminal?.creationOptions.name
  if (typeof terminalName === 'string') {
    const root = await requireRepoRoot()
    const state = await loadState(root)
    if (state.agents[terminalName]) return terminalName
  }
  const picked = await pickAgent({ includeAdd: false })
  if (picked?.agentName) return picked.agentName
  throw new Error('Select a Quimby agent terminal first.')
}

async function resolveSingleAgentTerminal(
  root: string,
  agentName: string,
): Promise<LayoutPlanTerminal> {
  const [config, state] = await Promise.all([loadQuimbyConfig(root), loadState(root)])
  const plan = await buildResolvedLayoutPlan({
    commandMode: 'direct',
    config: {
      ...config,
      layouts: { ...config.layouts, [SINGLE_AGENT_LAYOUT_NAME]: agentName },
    },
    name: SINGLE_AGENT_LAYOUT_NAME,
    repoRoot: root,
    state,
  })
  const leaf = flattenTabGroups(plan.root)
    .flat()
    .find((terminal) => terminal.kind === 'agent')
  if (!leaf) throw new Error(`Agent "${agentName}" did not resolve to a terminal.`)
  return leaf
}

async function pickAgent(opts: {
  exclude?: string
  includeAdd?: boolean
}): Promise<AgentQuickPickItem | undefined> {
  const root = await requireRepoRoot()
  const state = await loadStateForAgentPicker(root, opts.includeAdd === true)
  const items: AgentQuickPickItem[] = Object.keys(state?.agents ?? {})
    .filter((name) => name !== opts.exclude)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      agentName: name,
      description: state?.agents[name].role ?? state?.agents[name].defaults?.entrypoint,
      label: `$(hubot) ${name}`,
    }))
  if (opts.includeAdd) {
    items.push({
      add: true,
      alwaysShow: true,
      description: 'Create a Quimby agent, then open it',
      label: '$(add) Add new agent...',
    })
  }
  if (items.length === 0) {
    await vscode.window.showInformationMessage('No other Quimby agents are configured.')
    return undefined
  }
  return vscode.window.showQuickPick(items, {
    placeHolder: opts.includeAdd ? 'Open or add a Quimby agent' : 'Select a Quimby agent',
  })
}

async function loadStateForAgentPicker(
  root: string,
  allowMissing: boolean,
): Promise<Awaited<ReturnType<typeof loadState>> | null> {
  try {
    return await loadState(root)
  } catch (err) {
    if (allowMissing) return null
    throw err
  }
}

function validateAgentNameInput(value: string): string | undefined {
  if (!value) return 'Enter an agent name.'
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return 'Use letters, numbers, dot, underscore, or dash.'
  }
  if (value === 'host') return '"host" is reserved.'
  return undefined
}

function vscodeReporter(): Reporter {
  return {
    error: (message) => log?.error(message),
    info: (message) => log?.info(message),
    start: (message) => log?.info(message),
    success: (message) => log?.info(message),
    warn: (message) => log?.warn(message),
  }
}

// Dispose the layout's terminals: the tracked objects directly (reliable in-session), plus any
// open terminal whose ORIGINAL creation name is in the layout set. Matching on
// `creationOptions.name` — not the live `name`, which shell integration rewrites with the running
// command — also catches a terminal whose in-memory reference was lost or that was only partly
// hand-closed.
function closeLayout(): number {
  const layoutNames = new Set<string>(
    extensionContext?.workspaceState.get<string[]>(LAYOUT_TERMINALS_KEY) ?? [],
  )
  const targets = new Set<vscode.Terminal>(layoutSession?.terminals ?? [])
  log?.info(
    `closeLayout: session terminals=${layoutSession?.terminals.length ?? 0}, ` +
      `persisted names=[${[...layoutNames].join(', ')}], open terminals=${vscode.window.terminals.length}`,
  )
  for (const terminal of vscode.window.terminals) {
    const name = terminal.creationOptions.name
    log?.debug(`  open terminal: name="${terminal.name}" creationName="${name ?? ''}"`)
    if (name !== undefined && layoutNames.has(name)) targets.add(terminal)
  }
  log?.info(`closeLayout: disposing ${targets.size} terminal(s)`)
  for (const terminal of targets) {
    log?.info(`  dispose "${terminal.name}"`)
    terminal.dispose()
  }
  layoutSession = null
  updateStatusBar()
  return targets.size
}

// Reflect the current session in the status bar: a layout name + close affordance when one is
// open, an "open" prompt when idle. Its mere presence proves the extension is live in this window.
function updateStatusBar(): void {
  if (!statusBarItem) return
  if (layoutSession) {
    statusBarItem.text = `$(layout) Quimby: ${layoutSession.label}`
    statusBarItem.tooltip = 'Close Quimby layout'
    statusBarItem.command = 'quimby.closeLayout'
  } else {
    statusBarItem.text = '$(shield) Quimby'
    statusBarItem.tooltip = 'Open one Quimby agent'
    statusBarItem.command = 'quimby.openAgent'
  }
  statusBarItem.show()
}

async function startEmbeddedServer(root: string): Promise<void> {
  if (await getServerInfo(root)) return
  ownedServer = await startServer({ repoRoot: root })
}

async function stopOwnedServer(): Promise<void> {
  const server = ownedServer
  ownedServer = null
  await server?.stop()
}

function shouldRestoreLastLayout(): boolean {
  return vscode.workspace.getConfiguration('quimby').get('restoreLastLayout', false)
}

// Editor-area terminals with a running process route their dispose through VS Code's "confirm
// before closing" flow, so with confirmOnKill at its default a programmatic Close Layout silently
// does nothing (there is no user to confirm). Set it to "never" for this workspace so both Close
// Layout and a hand-close go through without a prompt. Quimby agents keep durable state on disk,
// so a closed terminal loses no work. Opt out with `quimby.suppressTerminalKillConfirmation`.
async function suppressTerminalKillConfirmation(): Promise<void> {
  const quimby = vscode.workspace.getConfiguration('quimby')
  if (!quimby.get('suppressTerminalKillConfirmation', true)) {
    log?.info('suppressTerminalKillConfirmation: disabled by setting')
    return
  }
  const terminal = vscode.workspace.getConfiguration('terminal.integrated')
  const current = terminal.get<string>('confirmOnKill')
  if (current !== 'never') {
    await terminal.update('confirmOnKill', 'never', vscode.ConfigurationTarget.Workspace)
    log?.info(`terminal.integrated.confirmOnKill: "${current ?? 'default'}" → "never" (workspace)`)
  } else {
    log?.info('terminal.integrated.confirmOnKill already "never"')
  }
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (err) {
    await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
  }
}

// Run an activation step so a failure is logged and swallowed rather than aborting `activate`
// (an un-awaited rejection there leaves the extension half-initialized). Unlike `runCommand` this
// stays quiet — activation steps shouldn't pop error modals on startup — and records the stack.
async function safely(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (err) {
    log?.error(`${label} failed: ${errorDetail(err)}`)
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

async function requireRepoRoot(): Promise<string> {
  repoRoot ??= await resolveRepoRoot()
  if (!repoRoot) throw new Error('Open a git workspace containing quimby.yaml before using Quimby.')
  return repoRoot
}

async function resolveRepoRoot(): Promise<string | null> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return null
  return (await findRoot(folder.uri.fsPath)) ?? null
}
