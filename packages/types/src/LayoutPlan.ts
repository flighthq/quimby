export interface LayoutPlanCommand {
  argv: string[]
  string: string
}

export interface LayoutPlanTerminal {
  kind: 'agent' | 'host' | 'service'
  name: string
  displayName: string
  cwd: string
  command: LayoutPlanCommand
}

export type LayoutPlanNode =
  | {
      type: 'cols' | 'rows'
      weight?: number
      children: LayoutPlanNode[]
    }
  | {
      type: 'tabs'
      weight?: number
      terminals: LayoutPlanTerminal[]
    }

export interface LayoutPlan {
  version: 1
  cwd: string
  source: {
    default: boolean
    expr: string
    name?: string
  }
  root: LayoutPlanNode
}
