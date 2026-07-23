import type { AgentAttestation } from './AgentAttestation'
import type { CommitMeta } from './CommitMeta'

export interface HandoffMeta {
  name: string
  /** The agent that sent the parcel. */
  from: string
  /** The recipient agent; set on delivery, absent while staged or exported. */
  to?: string
  /** The agent whose diff this parcel carries, when it differs from `from`. */
  codeSource?: string
  /** The commit the diff was generated against (the agent's seed at assemble time). */
  seedCommit?: string
  /** The parcel's note (README.md), when it carries one. */
  note?: string
  /** Host-stamped signal that the note carries user-directed work rather than peer advice. */
  userDirected?: boolean
  description: string
  suggestedMessage: string
  createdAt: string
  commits: CommitMeta[]
  /** The code source's self-attestation at carry time, relayed so it travels with the work. */
  attestation?: AgentAttestation
}
