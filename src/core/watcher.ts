import { watch } from 'chokidar'
import { join, relative } from 'pathe'
import { sendBundle } from './inbox.js'
import { logger } from '../utils/logger.js'
import { createTransport } from './transport/index.js'
import { sendBundleViaTransport } from './inbox.js'
import { sendMessage } from './messaging.js'
import type { WorkspaceConfig } from '../types/config.js'
import type { WorkspaceState } from '../types/workspace.js'

export interface WatcherCallbacks {
  onBundleCreated?: (sandbox: string, bundleId: string) => void
  onStatusChanged?: (sandbox: string) => void
  onMessageReceived?: (sandbox: string, from: string, messageId: string) => void
}

export function startWatcher(opts: {
  workspacePath: string
  config: WorkspaceConfig
  state?: WorkspaceState
  callbacks?: WatcherCallbacks
  pollInterval?: number
}) {
  const { workspacePath, config, state, callbacks, pollInterval = 10_000 } = opts

  const sendsTo = new Map<string, string[]>()
  for (const [name, sandbox] of Object.entries(config.sandboxes)) {
    if (sandbox.receives) {
      for (const sender of sandbox.receives) {
        const recipients = sendsTo.get(sender) ?? []
        recipients.push(name)
        sendsTo.set(sender, recipients)
      }
    }
  }

  const sandboxesDir = join(workspacePath, 'sandboxes')
  const closers: Array<{ close(): Promise<void> }> = []

  const localSandboxes: string[] = []
  const remoteSandboxes: string[] = []

  for (const name of Object.keys(config.sandboxes)) {
    const sandboxState = state?.sandboxes[name]
    if (sandboxState?.host && sandboxState?.user) {
      remoteSandboxes.push(name)
    } else {
      localSandboxes.push(name)
    }
  }

  if (localSandboxes.length > 0) {
    const watcher = watch(sandboxesDir, {
      ignoreInitial: true,
      depth: 5,
      persistent: true,
    })

    const handleFile = async (filePath: string) => {
      const rel = relative(sandboxesDir, filePath)
      const parts = rel.split('/')
      if (parts.length < 3) return

      const sandboxName = parts[0]

      if (
        parts[1] === '.sandbox' &&
        parts[2] === 'bundles' &&
        parts.length === 5 &&
        parts[4] === 'meta.yaml'
      ) {
        const bundleId = parts[3]
        logger.info(`[${sandboxName}] New bundle: ${bundleId}`)
        callbacks?.onBundleCreated?.(sandboxName, bundleId)

        const recipients = sendsTo.get(sandboxName) ?? []
        for (const recipient of recipients) {
          try {
            await sendBundle({
              workspacePath,
              fromSandbox: sandboxName,
              toSandbox: recipient,
              bundleId,
            })
            logger.info(`  -> Routed to ${recipient}`)
          } catch (err) {
            logger.error(
              `  -> Failed to route to ${recipient}: ${err instanceof Error ? err.message : err}`,
            )
          }
        }
      }

      if (parts[1] === '.sandbox' && parts[2] === 'status.md') {
        logger.info(`[${sandboxName}] Status updated`)
        callbacks?.onStatusChanged?.(sandboxName)
      }

      if (
        parts[1] === '.sandbox' &&
        parts[2] === 'messages' &&
        parts[3] === 'outbox' &&
        parts.length === 5 &&
        parts[4].endsWith('.md')
      ) {
        logger.info(`[${sandboxName}] New outbox message: ${parts[4]}`)
      }
    }

    watcher.on('add', handleFile)
    watcher.on('change', handleFile)

    closers.push({ close: () => watcher.close() })
  }

  if (remoteSandboxes.length > 0 && state) {
    const knownBundles = new Map<string, Set<string>>()
    for (const name of remoteSandboxes) {
      knownBundles.set(name, new Set())
    }

    const pollTimer = setInterval(async () => {
      for (const name of remoteSandboxes) {
        try {
          const sandboxState = state.sandboxes[name]
          if (!sandboxState) continue

          const transport = createTransport(workspacePath, sandboxState)
          const known = knownBundles.get(name)!

          if (await transport.exists('.sandbox/bundles')) {
            const entries = await transport.listDir('.sandbox/bundles')
            for (const entry of entries) {
              if (known.has(entry)) continue
              const metaExists = await transport.exists(
                `.sandbox/bundles/${entry}/meta.yaml`,
              )
              if (!metaExists) continue

              known.add(entry)
              logger.info(`[${name}] New remote bundle: ${entry}`)
              callbacks?.onBundleCreated?.(name, entry)

              const recipients = sendsTo.get(name) ?? []
              for (const recipient of recipients) {
                try {
                  const recipientState = state.sandboxes[recipient]
                  if (!recipientState) continue
                  const toTransport = createTransport(workspacePath, recipientState)
                  const { mkdtemp } = await import('node:fs/promises')
                  const { tmpdir } = await import('node:os')
                  const tempDir = await mkdtemp(join(tmpdir(), 'ao-route-'))
                  await sendBundleViaTransport({
                    fromTransport: transport,
                    toTransport,
                    fromSandbox: name,
                    bundleId: entry,
                    tempDir,
                  })
                  const { rm } = await import('node:fs/promises')
                  await rm(tempDir, { recursive: true, force: true })
                  logger.info(`  -> Routed to ${recipient}`)
                } catch (err) {
                  logger.error(
                    `  -> Failed to route to ${recipient}: ${err instanceof Error ? err.message : err}`,
                  )
                }
              }
            }
          }
        } catch (err) {
          logger.error(
            `[${name}] Poll error: ${err instanceof Error ? err.message : err}`,
          )
        }
      }
    }, pollInterval)

    closers.push({
      close: async () => {
        clearInterval(pollTimer)
      },
    })
  }

  return {
    close: async () => {
      for (const c of closers) {
        await c.close()
      }
    },
  }
}
