import type { AgentLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

import type { Transport } from './localTransport'
import { LocalTransport } from './localTransport'
import { SSHTransport } from './sshTransport'

export type { Transport }

export function getTransport(location: AgentLocation | undefined): Transport {
  if (isSSH(location)) return new SSHTransport(location)
  return new LocalTransport()
}
