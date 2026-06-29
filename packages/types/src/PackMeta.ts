import type { CommitMeta } from './CommitMeta'

export interface PackMeta {
  name: string
  worker: string
  description: string
  suggestedMessage: string
  createdAt: string
  commits: CommitMeta[]
}
