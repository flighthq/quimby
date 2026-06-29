import { cancel, confirm, intro, isCancel, outro, select, text } from '@clack/prompts'
import { runtimeTypes } from '@quimbyhq/runtimes'
import type { RuntimeType, SSHLocation, WorkerLocation } from '@quimbyhq/types'

export interface WorkerConfig {
  runtime: RuntimeType
  agent: string
  location?: SSHLocation
  syncRef?: string
  check?: string
  tmux?: boolean
}

export interface WalkthroughSeed {
  runtime?: string
  agent?: string
  location?: WorkerLocation
  syncRef?: string
  check?: string
  tmux?: boolean
}

// Parse a `user@host` or `user@host:/remote/path` spec (plus optional port) into
// an SSHLocation. Shared shape with the flag-driven path in add/set.
export function buildSSHLocation(host: string, port?: number): SSHLocation {
  const colonSlash = host.indexOf(':/')
  const sshHost = colonSlash >= 0 ? host.slice(0, colonSlash) : host
  const base = colonSlash >= 0 ? host.slice(colonSlash + 1) : undefined
  return {
    type: 'ssh',
    host: sshHost,
    ...(port ? { port } : {}),
    ...(base ? { base } : {}),
  }
}

// Interactive, arrow-key walkthrough that collects a worker's full configuration.
// Returns null if the user cancels at any step.
export async function runWorkerWalkthrough(
  name: string,
  seed: WalkthroughSeed = {},
): Promise<WorkerConfig | null> {
  intro(`Configure worker "${name}"`)

  const seededRuntime = runtimeTypes.find((rt) => rt === seed.runtime) ?? runtimeTypes[0]
  const runtime = await prompt(
    select({
      message: 'Runtime',
      options: runtimeTypes.map((rt, i) => ({ value: rt, label: `${i + 1}. ${rt}` })),
      initialValue: seededRuntime,
    }),
  )
  if (runtime === null) return cancelled()

  const agent = await prompt(
    text({
      message: 'Agent',
      placeholder: 'claude, codex, …',
      initialValue: seed.agent ?? 'claude',
    }),
  )
  if (agent === null) return cancelled()

  const seedLocal = !seed.location || seed.location.type !== 'ssh'
  const where = await prompt(
    select({
      message: 'Where does this worker run?',
      options: [
        { value: 'local', label: '1. Local' },
        { value: 'ssh', label: '2. Remote (SSH)' },
      ],
      initialValue: seedLocal ? 'local' : 'ssh',
    }),
  )
  if (where === null) return cancelled()

  let location: SSHLocation | undefined
  if (where === 'ssh') {
    const seedSSH = seed.location?.type === 'ssh' ? seed.location : undefined
    const host = await prompt(
      text({
        message: 'SSH host',
        placeholder: 'user@box or user@box:/remote/path',
        initialValue: seedSSH ? formatSSHHost(seedSSH) : '',
        validate: (value) => (value?.trim() ? undefined : 'A host is required for a remote worker'),
      }),
    )
    if (host === null) return cancelled()

    const portInput = await prompt(
      text({
        message: 'SSH port',
        placeholder: '22',
        initialValue: seedSSH?.port ? String(seedSSH.port) : '',
        validate: (value) =>
          !value || /^\d+$/.test(value.trim()) ? undefined : 'Port must be a number',
      }),
    )
    if (portInput === null) return cancelled()

    const port = portInput.trim() ? Number.parseInt(portInput.trim(), 10) : undefined
    location = buildSSHLocation(host.trim(), port)
  }

  // SSH workers always run in tmux for persistence; only local workers choose.
  let tmux = false
  if (where === 'local') {
    const useTmux = await prompt(
      confirm({ message: 'Run inside a tmux session?', initialValue: seed.tmux ?? false }),
    )
    if (useTmux === null) return cancelled()
    tmux = useTmux
  }

  const syncRef = await prompt(
    text({
      message: 'Sync ref (advance target)',
      placeholder: 'current host branch',
      initialValue: seed.syncRef ?? '',
    }),
  )
  if (syncRef === null) return cancelled()

  const check = await prompt(
    text({
      message: 'Verification command (run by `quimby pack`)',
      placeholder: 'e.g. npm test',
      initialValue: seed.check ?? '',
    }),
  )
  if (check === null) return cancelled()

  outro(`Worker "${name}" configured`)

  return {
    runtime: runtime as RuntimeType,
    agent: agent.trim() || 'claude',
    location,
    ...(syncRef.trim() ? { syncRef: syncRef.trim() } : {}),
    ...(check.trim() ? { check: check.trim() } : {}),
    ...(tmux ? { tmux: true } : {}),
  }
}

function formatSSHHost(location: SSHLocation): string {
  return location.base ? `${location.host}:${location.base}` : location.host
}

// Normalize a @clack prompt result: a cancellation collapses to null so callers
// can bail with a single check instead of importing the cancel symbol.
async function prompt<T>(answer: Promise<T | symbol>): Promise<T | null> {
  const value = await answer
  return isCancel(value) ? null : value
}

function cancelled(): null {
  cancel('Cancelled — no changes made.')
  return null
}
