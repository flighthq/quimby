import { findRoot } from '@quimbyhq/git'
import { listLayoutTargets, resolveLayoutPlan } from '@quimbyhq/layout'
import { getServerInfo, type QuimbyServerHandle, startServer } from '@quimbyhq/server'
import type { LayoutPlanNode, LayoutPlanTerminal } from '@quimbyhq/types'
import * as vscode from 'vscode'

const LAST_LAYOUT_KEY = 'quimby.lastLayout'

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

let repoRoot: string | null = null
let ownedServer: QuimbyServerHandle | null = null
let layoutSession: LayoutSession | null = null

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand('quimby.home', () => runCommand(() => showHome(context))),
    vscode.commands.registerCommand('quimby.openLayout', () =>
      runCommand(() => openLayoutCommand(context)),
    ),
    vscode.commands.registerCommand('quimby.restoreLastLayout', () =>
      runCommand(async () => {
        await restoreLastLayout(context)
      }),
    ),
    vscode.commands.registerCommand('quimby.closeLayout', () => closeLayout()),
    { dispose: () => void stopOwnedServer() },
    { dispose: () => closeLayout() },
  )

  repoRoot = await resolveRepoRoot()
  if (!repoRoot) {
    await vscode.window.showErrorMessage(
      'Quimby could not find a git repository for this workspace.',
    )
    return
  }

  await startEmbeddedServer(repoRoot)
  if (shouldRestoreLastLayout()) {
    await runCommand(async () => {
      const restored = await restoreLastLayout(context, { quiet: true })
      if (!restored) await showHome(context)
    })
  } else {
    await showHome(context)
  }
}

export async function deactivate(): Promise<void> {
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
  closeLayout()
  layoutSession = { label: plan.source.name ?? 'default', terminals: [] }
  const first = renderLayoutNode(plan.root, layoutSession)
  first?.show()
  await context.workspaceState.update(LAST_LAYOUT_KEY, {
    name: plan.source.name,
    useDefault: target.useDefault,
  })
  await vscode.window.showInformationMessage(`Opened Quimby layout "${plan.source.name}".`)
}

function renderLayoutNode(
  node: LayoutPlanNode,
  session: LayoutSession,
  parent?: vscode.Terminal,
): vscode.Terminal | null {
  if (node.type === 'tabs') return renderTabs(node.terminals, session, parent)

  let first: vscode.Terminal | null = null
  let splitParent = parent
  for (const child of node.children) {
    const terminal = renderLayoutNode(child, session, splitParent)
    if (!terminal) continue
    if (!first) first = terminal
    splitParent = first
  }
  return first
}

function renderTabs(
  terminals: readonly LayoutPlanTerminal[],
  session: LayoutSession,
  parent?: vscode.Terminal,
): vscode.Terminal | null {
  let first: vscode.Terminal | null = null
  for (const leaf of terminals) {
    const terminal = createTerminal(leaf, first ?? parent)
    session.terminals.push(terminal)
    terminal.sendText(leaf.command.string)
    if (!first) first = terminal
  }
  return first
}

function createTerminal(
  terminal: Readonly<LayoutPlanTerminal>,
  parent?: vscode.Terminal,
): vscode.Terminal {
  return vscode.window.createTerminal({
    name: terminal.displayName,
    cwd: terminal.cwd,
    ...(parent ? { location: { parentTerminal: parent } } : {}),
  })
}

function closeLayout(): void {
  for (const terminal of layoutSession?.terminals ?? []) terminal.dispose()
  layoutSession = null
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
  return vscode.workspace.getConfiguration('quimby').get('restoreLastLayout', true)
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (err) {
    await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
  }
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
