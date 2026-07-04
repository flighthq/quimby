import { intro, isCancel, outro, select, text } from '@clack/prompts'
import { QuimbyError } from '@quimbyhq/errors'
import { parseSSHHostSpec } from '@quimbyhq/transport'
import type { QuimbyConfig, QuimbyState, SSHLocation } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'
import type { HostAliasBinding } from '@quimbyhq/workspace'
import { loadQuimbyConfig, resolveSSHConnection, saveHostAliasBinding } from '@quimbyhq/workspace'

/**
 * Resolve a stored SSH location to a connection-ready one. A concrete host passes
 * through; an unbound alias is prompted for and the binding persisted to ignored
 * config (so the address never reaches the tracked repo), then reflected into the
 * in-memory `config` so sibling agents sharing the alias resolve without re-asking.
 * Non-interactive callers get a QuimbyError naming the exact bind command.
 */
export async function resolveSSHLocationInteractive(
  repoRoot: string,
  config: QuimbyConfig,
  loc: Readonly<SSHLocation>,
): Promise<SSHLocation & { host: string }> {
  const res = resolveSSHConnection(config, loc)
  if (res.location) return res.location

  const binding = await promptForHostAlias(res.unboundAlias)
  config.hosts = { ...(config.hosts ?? {}), [res.unboundAlias]: { type: 'ssh', ...binding.value } }
  const path = await saveHostAliasBinding(repoRoot, res.unboundAlias, binding.value, {
    global: binding.global,
  })
  outro(`Saved host alias "${res.unboundAlias}" → ${binding.value.host} in ${path}`)

  const bound = resolveSSHConnection(config, { ...loc, alias: res.unboundAlias })
  // Just bound it above, so resolution now yields a concrete location.
  return bound.location!
}

/**
 * Resolve every named SSH agent's location to a connection-ready host in place,
 * prompting once per still-unbound alias. Local agents and already-concrete SSH
 * agents are left untouched. Loads config lazily, only when an SSH agent is present.
 */
export async function ensureAgentConnections(
  repoRoot: string,
  state: Readonly<QuimbyState>,
  names: readonly string[],
): Promise<void> {
  let config: QuimbyConfig | undefined
  for (const name of names) {
    const agent = state.agents[name]
    if (!agent || !isSSH(agent.location)) continue
    config ??= await loadQuimbyConfig(repoRoot)
    // Mutating the in-memory location is safe: the resolved location retains `alias`,
    // so even if a later saveState bakes the host, the next launch still re-resolves
    // through config and a rebinding propagates.
    agent.location = await resolveSSHLocationInteractive(repoRoot, config, agent.location)
  }
}

async function promptForHostAlias(
  name: string,
): Promise<{ value: HostAliasBinding; global: boolean }> {
  if (!process.stdout.isTTY) {
    throw new QuimbyError(
      `Host alias "${name}" has no address bound. Bind it with \`quimby host ${name} --set <user@host> [--global]\` and retry.`,
    )
  }

  intro(`Host alias "${name}" isn't bound to an address yet`)
  const spec = await text({
    message: `SSH target for "${name}" (user@host, optionally host:/base/dir)`,
    placeholder: 'user@host',
    validate: (v) => (v && v.trim() ? undefined : 'An address is required'),
  })
  if (isCancel(spec)) throw new QuimbyError('Cancelled — host alias not bound.')

  const portStr = await text({
    message: 'SSH port (leave blank for the default)',
    placeholder: '22',
    validate: (v) => (!v || /^\d+$/.test(v.trim()) ? undefined : 'Port must be a number'),
  })
  if (isCancel(portStr)) throw new QuimbyError('Cancelled — host alias not bound.')

  const scope = await select({
    message: 'Where should this binding be saved?',
    options: [
      { value: 'local', label: 'This project only (.quimby/local.yaml)' },
      { value: 'global', label: 'All my projects (~/.config/quimby/config.yaml)' },
    ],
    initialValue: 'local',
  })
  if (isCancel(scope)) throw new QuimbyError('Cancelled — host alias not bound.')

  const { host, base } = parseSSHHostSpec(String(spec).trim())
  const port = String(portStr).trim() ? Number.parseInt(String(portStr).trim(), 10) : undefined
  return {
    value: { host, ...(base ? { base } : {}), ...(port ? { port } : {}) },
    global: scope === 'global',
  }
}
