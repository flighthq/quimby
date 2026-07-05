declare module 'vscode' {
  export interface ExtensionContext {
    subscriptions: { dispose(): unknown }[]
    workspaceState: Memento
  }

  export interface Disposable {
    dispose(): unknown
  }

  export interface Memento {
    get<T>(key: string): T | undefined
    update(key: string, value: unknown): Thenable<void>
  }

  export interface Uri {
    fsPath: string
  }

  export interface WorkspaceFolder {
    uri: Uri
  }

  export interface Terminal {
    name: string
    dispose(): void
    sendText(text: string): void
    show(preserveFocus?: boolean): void
  }

  export interface TerminalOptions {
    cwd?: string
    location?: unknown
    name?: string
  }

  export interface QuickPickItem {
    description?: string
    label: string
  }

  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable
  }

  export const window: {
    createTerminal(options: TerminalOptions): Terminal
    showQuickPick<T extends QuickPickItem>(
      items: readonly T[],
      options?: { placeHolder?: string },
    ): Thenable<T | undefined>
    showErrorMessage(message: string): Thenable<string | undefined>
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>
  }

  export const workspace: {
    getConfiguration(section?: string): { get<T>(key: string, defaultValue: T): T }
    workspaceFolders?: readonly WorkspaceFolder[]
  }
}
