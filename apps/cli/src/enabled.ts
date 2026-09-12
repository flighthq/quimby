import { QuimbyError } from '@quimbyhq/errors'
import type { AgentState } from '@quimbyhq/types'

/**
 * Refuse to launch a disabled agent.
 *
 * `disable` frees the live session and keeps the work on disk, and the layout planner prunes a
 * disabled leaf so a saved dashboard opens the enabled set without editing its expression. But the
 * layout is only one way in: `quimby run <agent>`, `start`, and `restart` name an agent directly,
 * and none of them consulted the flag — so the session came straight back, while `quimby list`
 * reported `⊘ disabled` because that row trusted the flag over its own session probe. A disabled
 * agent could therefore be running, receiving nudges, and answering parcels while every surface
 * said it was shelved.
 *
 * Refusing here is what makes the flag true. It is a hard error rather than a warn-and-launch
 * because the cost of getting it wrong is a fleet whose reported state and real state disagree,
 * which is far more expensive than retyping the command after `quimby enable`.
 */
export function assertAgentEnabled(agent: Readonly<AgentState>, name: string): void {
  if (agent.enabled === false) {
    throw new QuimbyError(
      `"${name}" is disabled — its work is on disk but it takes no session. ` +
        `Re-enable it with \`quimby enable ${name}\`.`,
    )
  }
}
