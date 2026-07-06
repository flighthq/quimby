import { addAgent, syncAgent } from '@quimbyhq/agent'
import { findRoot } from '@quimbyhq/git'
import { handoffWork } from '@quimbyhq/handoff'
import { buildResolvedLayoutPlan, listLayoutTargets, resolveLayoutPlan } from '@quimbyhq/layout'
import type { Reporter } from '@quimbyhq/reporter'
import { getServerInfo, type QuimbyServerHandle, startServer } from '@quimbyhq/server'
import { nudgeAgentSession } from '@quimbyhq/session'
import type { LayoutPlanNode, LayoutPlanTerminal } from '@quimbyhq/types'
import { loadQuimbyConfig, loadState } from '@quimbyhq/workspace'
import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
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

interface AgentWebviewMessage {
  command?: string
  cols?: number
  data?: string
  rows?: number
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
const agentPanels = new Map<string, AgentPanel>()

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context
  log = vscode.window.createOutputChannel('Quimby', { log: true })
  context.subscriptions.push(log)
  log.info('Quimby extension activated')
  context.subscriptions.push(
    vscode.commands.registerCommand('quimby.openAgent', () => runCommand(() => openAgentCommand())),
    vscode.commands.registerCommand('quimby.addAgent', () => runCommand(() => addAgentCommand())),
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
    { dispose: () => void stopOwnedServer() },
    { dispose: () => void closeLayout() },
    { dispose: () => disposeAgentPanels() },
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
  disposeAgentPanels()
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
  const existing = agentPanels.get(agentName)
  if (existing) {
    existing.reveal()
    await existing.ensureConnected()
    return
  }
  const panel = vscode.window.createWebviewPanel(
    'quimby.agent',
    `Quimby: ${agentName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  )
  if (!extensionContext) throw new Error('Quimby extension context is not initialized.')
  const agentPanel = new AgentPanel(panel, agentName, extensionContext.extensionUri)
  agentPanels.set(agentName, agentPanel)
  agentPanel.render()
  await agentPanel.reconnect()
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

function disposeAgentPanels(): void {
  for (const panel of agentPanels.values()) panel.dispose()
  agentPanels.clear()
}

class AgentPanel {
  private connected = false
  private disposed = false
  private session: EmbeddedTerminalSession | null = null
  private terminalSize = { cols: 120, rows: 30 }

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly agentName: string,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.panel.onDidDispose(() => {
      this.disposed = true
      agentPanels.delete(this.agentName)
      this.session?.dispose()
      this.session = null
    })
    this.panel.webview.onDidReceiveMessage((message: AgentWebviewMessage) => {
      void runCommand(async () => {
        if (message.command === 'sync') await this.sync()
        else if (message.command === 'handoff') await this.handoff()
        else if (message.command === 'disconnect') this.disconnect()
        else if (message.command === 'reconnect') await this.reconnect()
        else if (message.command === 'terminalInput' && typeof message.data === 'string') {
          this.session?.write(message.data)
        } else if (
          message.command === 'terminalResize' &&
          typeof message.cols === 'number' &&
          typeof message.rows === 'number'
        ) {
          this.terminalSize = { cols: message.cols, rows: message.rows }
          this.session?.resize(message.cols, message.rows)
        } else if (message.command === 'terminalReady') {
          this.session?.flush()
        }
      })
    })
  }

  disconnect(): void {
    this.session?.dispose()
    this.session = null
    this.connected = false
    this.render()
  }

  async handoff(): Promise<void> {
    const recipient = await pickAgent({ exclude: this.agentName })
    if (!recipient?.agentName) return
    const message = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: 'Optional note for the recipient',
      prompt: `Handoff ${this.agentName} to ${recipient.agentName}`,
    })
    if (message === undefined) return
    const root = await requireRepoRoot()
    const state = await loadState(root)
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Handing off ${this.agentName} to ${recipient.agentName}`,
      },
      async () => {
        const result = await handoffWork(
          {
            state,
            repoRoot: root,
            from: this.agentName,
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
    await vscode.window.showInformationMessage(
      `Quimby handoff queued for "${recipient.agentName}".`,
    )
  }

  async reconnect(): Promise<void> {
    this.session?.dispose()
    this.session = null
    const root = await requireRepoRoot()
    const leaf = await resolveSingleAgentTerminal(root, this.agentName)
    this.session = new EmbeddedTerminalSession({
      cwd: leaf.cwd,
      onClose: () => {
        if (this.disposed) return
        this.session = null
        this.connected = false
        this.render()
      },
      onOutput: (data) => {
        void this.panel.webview.postMessage({ data, command: 'terminalOutput' })
      },
      command: leaf.command.string,
      cols: this.terminalSize.cols,
      label: this.agentName,
      rows: this.terminalSize.rows,
    })
    this.connected = true
    this.render()
    this.session.start()
  }

  render(): void {
    if (this.disposed) return
    this.panel.webview.html = renderAgentPanelHtml(this.panel.webview, this.extensionUri, {
      agentName: this.agentName,
      connected: this.connected,
    })
  }

  reveal(): void {
    this.panel.reveal()
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected || !this.session) await this.reconnect()
  }

  dispose(): void {
    this.panel.dispose()
  }

  private async sync(): Promise<void> {
    const root = await requireRepoRoot()
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Syncing Quimby agent "${this.agentName}"`,
      },
      () => syncAgent(root, this.agentName),
    )
    const verb = result.rebased ? `rebased ${result.commitsReplayed} commit(s)` : 'already current'
    await vscode.window.showInformationMessage(`Quimby sync complete: ${verb}.`)
  }
}

class EmbeddedTerminalSession {
  private disposed = false
  private process: IPty | null = null
  private readonly pending: string[] = []
  private ready = false

  constructor(
    private readonly opts: {
      command: string
      cols: number
      cwd: string
      label: string
      onClose: () => void
      onOutput: (data: string) => void
      rows: number
    },
  ) {}

  dispose(): void {
    this.disposed = true
    this.process?.kill()
    this.process = null
  }

  flush(): void {
    this.ready = true
    while (this.pending.length > 0) {
      this.opts.onOutput(this.pending.shift() ?? '')
    }
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  }

  start(): void {
    const launch = terminalShellCommand(this.opts.command)
    log?.info(`embedded terminal pty: ${this.opts.label}`)
    this.process = spawn(launch.file, launch.args, {
      cols: this.opts.cols,
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? 'xterm-256color',
      },
      name: 'xterm-256color',
      rows: this.opts.rows,
    })
    this.process.onData((data) => this.output(data))
    this.process.onExit(() => {
      if (!this.disposed) this.opts.onClose()
    })
  }

  write(data: string): void {
    this.process?.write(data)
  }

  private output(data: string): void {
    if (this.ready) {
      this.opts.onOutput(data)
    } else {
      this.pending.push(data)
    }
  }
}

function terminalShellCommand(command: string): { args: string[]; file: string } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', command] }
  }
  return { file: 'bash', args: ['-l', '-c', command] }
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

function renderAgentPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { agentName: string; connected: boolean },
): string {
  const nonce = nonceValue()
  const xtermCss = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview-assets', 'xterm.css'),
  )
  const xtermJs = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview-assets', 'xterm.js'),
  )
  const fitJs = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview-assets', 'addon-fit.js'),
  )
  const state = opts.connected ? 'Connected' : 'Disconnected'
  const detail = opts.connected
    ? 'The agent terminal is owned by this Quimby tab.'
    : 'The terminal was closed or disconnected. Reconnect to open a fresh agent terminal.'
  const reconnectButton = opts.connected
    ? `<button data-command="disconnect" title="Disconnect terminal">Disconnect</button>`
    : `<button class="primary" data-command="reconnect" title="Reconnect terminal">Reconnect</button>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quimby: ${escapeHtml(opts.agentName)}</title>
  <link rel="stylesheet" href="${xtermCss}">
  <style nonce="${nonce}">
    html,
    body {
      height: 100%;
    }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      margin: 0;
    }
    .root {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .toolbar {
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
      padding: 10px 12px;
    }
    .title {
      font-weight: 600;
      margin-right: auto;
    }
    button {
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      font: inherit;
      padding: 5px 10px;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .state {
      align-items: center;
      display: flex;
      flex: 1 1 auto;
      gap: 16px;
      padding: 36px 24px;
    }
    .terminal-wrap {
      flex: 1 1 auto;
      min-height: 0;
      padding: 8px;
    }
    #terminal {
      height: 100%;
      width: 100%;
    }
    .glyph {
      align-items: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      font-size: 30px;
      height: 64px;
      justify-content: center;
      width: 64px;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 6px;
    }
    p {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
      margin: 0;
      max-width: 620px;
    }
  </style>
</head>
<body>
  <div class="root">
    <div class="toolbar">
      <div class="title">Quimby: ${escapeHtml(opts.agentName)}</div>
      <button data-command="sync" title="Sync this agent">Sync</button>
      <button data-command="handoff" title="Handoff this agent's work">Handoff</button>
      ${reconnectButton}
    </div>
    ${
      opts.connected
        ? `<div class="terminal-wrap"><div id="terminal"></div></div>`
        : `<main class="state">
      <div class="glyph">&#8635;</div>
      <div>
        <h2>${state}</h2>
        <p>${detail}</p>
      </div>
    </main>`
    }
  </div>
  <script nonce="${nonce}" src="${xtermJs}"></script>
  <script nonce="${nonce}" src="${fitJs}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const button of document.querySelectorAll('button[data-command]')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ command: button.dataset.command });
      });
    }
    const terminalElement = document.getElementById('terminal');
    if (terminalElement) {
      const term = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        fontFamily: 'var(--vscode-editor-font-family)',
        fontSize: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size'), 10) || 13,
        theme: {
          background: getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim(),
          foreground: getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground').trim()
        }
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(terminalElement);
      const resize = () => {
        fit.fit();
        vscode.postMessage({ command: 'terminalResize', cols: term.cols, rows: term.rows });
      };
      term.onData((data) => vscode.postMessage({ command: 'terminalInput', data }));
      window.addEventListener('resize', resize);
      resize();
      vscode.postMessage({ command: 'terminalReady' });
      window.addEventListener('message', (event) => {
        if (event.data?.command === 'terminalOutput') term.write(event.data.data);
      });
      term.focus();
    }
  </script>
</body>
</html>`
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

function nonceValue(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let i = 0; i < 32; i++) value += chars[Math.floor(Math.random() * chars.length)]
  return value
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
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
