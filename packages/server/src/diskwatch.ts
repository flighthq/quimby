import type { Reporter } from '@quimbyhq/reporter'
import type { QuimbyConfig, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { isResolvedSSHLocation, isSSH } from '@quimbyhq/types'
import { getRemoteDiskUsage, remoteDiskWarning } from '@quimbyhq/workspace'

/** Per-host check times and low/ok state, held across poll cycles. */
export interface DiskWatchTracker {
  hosts: Map<string, { checkedAt: number; low: boolean }>
}

export function createDiskWatchTracker(): DiskWatchTracker {
  return { hosts: new Map() }
}

/**
 * Warn when an SSH host this workspace uses drops below `storage.minFree` — the running server's
 * half of the low-disk warning a launch prints. A fleet left running fills a disk while nobody is
 * launching anything, and a full disk surfaces only as an unrelated-looking build or git failure.
 *
 * Each host is read at most once per `intervalMs` (a `df` is cheap, but the cycle runs every few
 * seconds), and it speaks on transitions: once when a host goes low, once when it recovers —
 * a warning repeated every half hour is one people learn to scroll past. Never deletes anything.
 */
export async function watchRemoteDiskSpace(
  state: Readonly<QuimbyState>,
  config: Readonly<QuimbyConfig> | undefined,
  tracker: DiskWatchTracker,
  now: number,
  reporter: Readonly<Reporter>,
  intervalMs = DISK_CHECK_INTERVAL_MS,
): Promise<void> {
  const hosts = new Map<string, SSHLocation & { host: string }>()
  for (const agent of Object.values(state.agents)) {
    if (isSSH(agent.location) && isResolvedSSHLocation(agent.location)) {
      hosts.set(agent.location.host, agent.location)
    }
  }
  for (const [host, location] of hosts) {
    const seen = tracker.hosts.get(host)
    if (seen && now - seen.checkedAt < intervalMs) continue
    const disk = await getRemoteDiskUsage(location).catch(() => null)
    // An unreachable host is the poller's problem to report; keep the previous verdict and retry.
    if (!disk) {
      tracker.hosts.set(host, { checkedAt: now, low: seen?.low ?? false })
      continue
    }
    const label = location.alias ?? host
    const warning = remoteDiskWarning(disk, config, label)
    if (warning && !seen?.low) reporter.warn(warning)
    if (!warning && seen?.low)
      reporter.info(`Remote host "${label}" is back above storage.minFree.`)
    tracker.hosts.set(host, { checkedAt: now, low: warning !== null })
  }
}

const DISK_CHECK_INTERVAL_MS = 30 * 60_000
