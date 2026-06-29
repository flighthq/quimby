import type { AgentState } from './AgentState'

export interface QuimbyState {
  id: string
  sourceRepo: string
  sourceRef: string
  snapshot: string
  createdAt: string
  agents: Record<string, AgentState>
  subscriptions?: Record<string, string[]>
}
