import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import * as vscode from 'vscode'

import type { LayoutPlan, LayoutPlanNode, LayoutPlanTerminal } from './layoutPlan'

const execFileAsync = promisify(execFile)

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('quimby.openLayout', () => openDefaultLayout()),
    vscode.commands.registerCommand('quimby.connectWorkspace', () => openDefaultLayout()),
  )
}

export function deactivate(): void {}

async function openDefaultLayout(): Promise<void> {
  try {
    const root = workspaceRoot()
    const plan = await readDefaultLayoutPlan(root)
    const first = renderLayoutNode(plan.root)
    first?.show()
    await vscode.window.showInformationMessage(`Opened Quimby layout "${plan.source.name}"`)
  } catch (err) {
    await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
  }
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) throw new Error('Open a workspace folder before connecting Quimby.')
  return folder.uri.fsPath
}

async function readDefaultLayoutPlan(root: string): Promise<LayoutPlan> {
  const { stdout } = await execFileAsync('quimby', ['layout', '--default', '--json'], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout) as LayoutPlan
}

function renderLayoutNode(node: LayoutPlanNode, parent?: vscode.Terminal): vscode.Terminal | null {
  if (node.type === 'tabs') return renderTabs(node.terminals, parent)

  let first: vscode.Terminal | null = null
  let splitParent = parent
  for (const child of node.children) {
    const terminal = renderLayoutNode(child, splitParent)
    if (!terminal) continue
    if (!first) first = terminal
    splitParent = first
  }
  return first
}

function renderTabs(
  terminals: readonly LayoutPlanTerminal[],
  parent?: vscode.Terminal,
): vscode.Terminal | null {
  let first: vscode.Terminal | null = null
  for (const leaf of terminals) {
    const terminal = createTerminal(leaf, first ?? parent)
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
