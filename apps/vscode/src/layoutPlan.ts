export interface LayoutPlan {
  source: {
    name?: string
  }
  root: LayoutPlanNode
}

export type LayoutPlanNode =
  | {
      type: 'cols' | 'rows'
      children: LayoutPlanNode[]
    }
  | {
      type: 'tabs'
      terminals: LayoutPlanTerminal[]
    }

export interface LayoutPlanTerminal {
  displayName: string
  cwd: string
  command: {
    string: string
  }
}
