export interface WorkspaceConfig {
  name?: string
  source: SourceConfig
  sandboxes: Record<string, SandboxConfig>
}

export interface SourceConfig {
  ref: string
}

export interface SandboxConfig {
  role: string
  runtime: RuntimeConfig
  receives?: string[]
  env?: Record<string, string>
  template?: string | TemplateConfig
}

export interface TemplateConfig {
  path: string
  vars?: Record<string, string>
}

export interface RuntimeConfig {
  type: string
  launch: (ctx: LaunchContext) => string[]
  host?: string
  user?: string
  port?: number
}

export interface LaunchContext {
  sandbox: {
    name: string
    path: string
    repoPath: string
  }
  source: {
    repo: string
    ref: string
    snapshot: string
  }
  workspace: {
    name: string
    path: string
  }
}

export function defineWorkspace(config: WorkspaceConfig): WorkspaceConfig {
  return config
}
