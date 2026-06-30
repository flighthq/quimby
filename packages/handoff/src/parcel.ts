import { readFile, rm } from 'node:fs/promises'

import { HandoffError, QuimbyError } from '@quimbyhq/errors'
import {
  getAgentDir,
  getAgentInboxParcelDir,
  getStagingHandoffDir,
  remoteAgentDir,
} from '@quimbyhq/paths'
import { getSSHTransport } from '@quimbyhq/transport'
import type { AgentLocation, HandoffMeta } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import { cp, ensureDir, exists, readYaml } from '@quimbyhq/utils'
import { join } from 'pathe'

/** Carry a staged parcel into a recipient agent's inbox (local copy or rsync). */
export async function deliverHandoff(opts: {
  repoRoot: string
  name: string
  to: string
  /** Stable id of the recipient — keys its on-disk inbox directory. */
  toId: string
  toLocation: Readonly<AgentLocation> | undefined
  projectId: string
}): Promise<void> {
  const { repoRoot, name, to, toId, toLocation, projectId } = opts

  const stagingDir = getStagingHandoffDir(repoRoot, name)
  if (!(await exists(stagingDir))) {
    throw new HandoffError(`Handoff "${name}" not found`, name)
  }

  if (isSSH(toLocation)) {
    const transport = getSSHTransport(toLocation)
    const rInboxDir = `${remoteAgentDir(projectId, toId, toLocation.base)}/inbox/${name}`
    await transport.ensureDir(rInboxDir)
    await transport.rsyncTo(stagingDir, rInboxDir)
    return
  }

  if (!(await exists(getAgentDir(repoRoot, toId)))) {
    throw new QuimbyError(`Agent "${to}" not found`)
  }
  const inboxDir = getAgentInboxParcelDir(repoRoot, toId, name)
  await ensureDir(inboxDir)
  await cp(stagingDir, inboxDir, { recursive: true })
}

/** Remove a staged parcel once it has been consumed (applied, delivered, exported). */
export async function discardHandoff(repoRoot: string, name: string): Promise<void> {
  await rm(getStagingHandoffDir(repoRoot, name), { recursive: true, force: true })
}

export async function readHandoff(
  repoRoot: string,
  name: string,
): Promise<{ meta: HandoffMeta; squashedDiff: string; note: string }> {
  const dir = getStagingHandoffDir(repoRoot, name)
  const metaPath = join(dir, 'meta.yaml')
  if (!(await exists(metaPath))) {
    throw new HandoffError(`Handoff "${name}" not found`, name)
  }
  const meta = await readYaml<HandoffMeta>(metaPath)
  const squashedDiff = (await exists(join(dir, 'squashed.diff')))
    ? await readFile(join(dir, 'squashed.diff'), 'utf-8')
    : ''
  const note = (await exists(join(dir, 'README.md')))
    ? await readFile(join(dir, 'README.md'), 'utf-8')
    : ''
  return { meta, squashedDiff, note }
}
