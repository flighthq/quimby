import { getPoolCapacity, getPoolInventory, poolCapacityWarning } from '@quimbyhq/pool'
import type { QuimbyConfig, QuimbyState } from '@quimbyhq/types'
import { logger } from '@quimbyhq/utils'

/**
 * Warn — never refuse — when a launch would push the machine past `pool.maxLive`.
 *
 * The probe is skipped entirely unless a ceiling is configured, so the ordinary launch path
 * pays nothing; and a failing probe is silent, because a missing tmux or an unreadable
 * workspace must not stand between the user and starting an agent.
 */
export async function warnIfPoolAtCapacity(
  config: Readonly<QuimbyConfig> | undefined,
  state?: Readonly<QuimbyState>,
): Promise<void> {
  if (!config?.pool?.maxLive) return
  try {
    const inventory = await getPoolInventory(state ? { currentState: state } : {})
    const warning = poolCapacityWarning(getPoolCapacity(inventory, config))
    if (warning) logger.warn(warning)
  } catch {
    // A pool reading is advisory; never let it block a launch.
  }
}
