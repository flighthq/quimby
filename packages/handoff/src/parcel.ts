import { readdir, readFile, rm } from 'node:fs/promises'

import { HandoffError, QuimbyError } from '@quimbyhq/errors'
import { isMergeInProgress, isRebaseOrAmInProgress } from '@quimbyhq/git'
import {
  getAgentDir,
  getAgentHandoffInReceivedParcelDir,
  getStagingDir,
  getStagingHandoffDir,
  remoteAgentHandoffInReceivedDir,
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
    const rReceivedDir = `${remoteAgentHandoffInReceivedDir(projectId, toId, toLocation.base)}/${name}`
    await transport.ensureDir(rReceivedDir)
    await transport.rsyncTo(stagingDir, rReceivedDir)
    return
  }

  if (!(await exists(getAgentDir(repoRoot, toId)))) {
    throw new QuimbyError(`Agent "${to}" not found`)
  }
  const receivedDir = getAgentHandoffInReceivedParcelDir(repoRoot, toId, name)
  await ensureDir(receivedDir)
  await cp(stagingDir, receivedDir, { recursive: true })
}

/** Remove a staged parcel once it has been consumed (applied, delivered, exported). */
export async function discardHandoff(repoRoot: string, name: string): Promise<void> {
  await rm(getStagingHandoffDir(repoRoot, name), { recursive: true, force: true })
}

/**
 * Sweep a staging area left over from an abandoned merge. A merge conflict keeps its staged
 * parcel for retry; if the user then abandons the merge (`git merge --abort`) the parcel
 * lingers with no merge in progress. On the next merge we clear it silently so the run starts
 * clean — but only when no merge (or rebase/`am`) is in progress in `targetRepoPath`, since an
 * in-progress operation is the live retry path whose parcel must be preserved. A `--commits` merge
 * lands via `git am`, so guarding on merge alone would wipe a parcel while an am-based retry is
 * still live. Returns whether anything was cleared.
 */
export async function healAbandonedStaging(
  repoRoot: string,
  targetRepoPath: string,
): Promise<boolean> {
  const stagingDir = getStagingDir(repoRoot)
  if (!(await exists(stagingDir))) return false
  if ((await readdir(stagingDir)).length === 0) return false
  if (await isMergeInProgress(targetRepoPath)) return false
  if (await isRebaseOrAmInProgress(targetRepoPath)) return false
  await rm(stagingDir, { recursive: true, force: true })
  return true
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
