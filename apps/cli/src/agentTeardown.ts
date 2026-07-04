import { remoteAgentDir, remoteAgentRepoDir, remoteProjectRoot } from '@quimbyhq/paths'
import { buildContext, getRuntime } from '@quimbyhq/runtimes'
import { getSSHTransport, sq } from '@quimbyhq/transport'
import type { AgentState, QuimbyState, RuntimeContext, RuntimeType } from '@quimbyhq/types'
import { isSSH } from '@quimbyhq/types'

/**
 * Best-effort teardown of an agent's runtime sandbox (the sbx/openshell adapter). A `local`
 * runtime has no sandbox and no-ops. For a local agent the removal runs on the host; for an SSH
 * agent it runs on the remote host over the transport, since that is where the sandbox lives —
 * the piece `remove` used to skip. Tearing an agent down should never be blocked by sandbox
 * cleanup, so an unknown runtime, a missing CLI, or an unreachable host is swallowed.
 */
export async function teardownAgentSandbox(opts: {
  state: Readonly<QuimbyState>
  repoRoot: string
  agent: Readonly<AgentState>
  name: string
}): Promise<void> {
  const { state, repoRoot, agent, name } = opts
  const runtime = (agent.defaults?.runtime as RuntimeType) ?? 'local'
  try {
    if (isSSH(agent.location)) {
      // Recompute the sandbox name against the *remote* agent dir — the same path the launch
      // hashed — so the rm targets the sandbox that actually exists on the remote.
      const base = agent.location.base
      const ctx: RuntimeContext = {
        projectId: state.id,
        agentId: agent.id,
        agentName: name,
        agentDir: remoteAgentDir(state.id, agent.id, base),
        repoDir: remoteAgentRepoDir(state.id, agent.id, base),
        repoRoot: remoteProjectRoot(state.id, base),
      }
      const spec = getRuntime(runtime).teardownSpec(ctx)
      if (spec) {
        // Leave the static runtime token (`sbx`/`openshell`) bare; quote the dynamic args (the
        // sandbox name), mirroring how the SSH launch command is assembled.
        const cmd = [spec.command, ...spec.args.map(sq)].join(' ')
        await getSSHTransport(agent.location).exec(cmd)
      }
    } else {
      await getRuntime(runtime).teardown(buildContext(repoRoot, name, state.id, agent.id))
    }
  } catch {
    // Unknown runtime, missing CLI, or unreachable host — sandbox teardown is advisory only.
  }
}
