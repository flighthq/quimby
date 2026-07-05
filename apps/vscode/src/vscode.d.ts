declare module 'vscode' {
  export interface ExtensionContext {
    subscriptions: { dispose(): unknown }[]
  }

  export interface Uri {
    fsPath: string
  }

  export interface WorkspaceFolder {
    uri: Uri
  }

  export interface Terminal {
    name: string
    sendText(text: string): void
    show(preserveFocus?: boolean): void
  }

  export interface TerminalOptions {
    cwd?: string
    location?: unknown
    name?: string
  }

  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void }
  }

  export const window: {
    createTerminal(options: TerminalOptions): Terminal
    showErrorMessage(message: string): Thenable<string | undefined>
    showInformationMessage(message: string): Thenable<string | undefined>
  }

  export const workspace: {
    workspaceFolders?: readonly WorkspaceFolder[]
  }
}
