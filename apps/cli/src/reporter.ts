import type { Reporter } from '@quimbyhq/reporter'
import { logger } from '@quimbyhq/utils'

/**
 * The CLI's `Reporter`: forwards operation progress to consola. This is the one
 * place consola is bound to the reporter contract — capability packages emit
 * through `Reporter` and never import consola themselves.
 */
export const consolaReporter: Reporter = {
  start: (message) => logger.start(message),
  success: (message) => logger.success(message),
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error(message),
}
