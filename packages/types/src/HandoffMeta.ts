import type { CommitMeta } from './CommitMeta'

export interface HandoffMeta {
  name: string
  /** The agent that sent the parcel. */
  from: string
  /** The recipient agent; set on delivery, absent while staged or exported. */
  to?: string
  /** The agent whose diff this parcel carries, when it differs from `from`. */
  codeSource?: string
  /** The parcel's note (README.md), when it carries one. */
  note?: string
  description: string
  suggestedMessage: string
  createdAt: string
  commits: CommitMeta[]
}
