import type { AgentLocation } from './AgentLocation'
import type { FocusPolicy } from './FocusPolicy'
import type { NudgePolicy } from './NudgePolicy'

export interface CheckConfig {
  command?: string
  verifyByDefault?: boolean
}

export interface AgentRoleConfig {
  runtimeProfile?: string
  runtime?: string
  entrypoint?: string
  check?: string | CheckConfig
  verifyByDefault?: boolean
  syncRef?: string
  tmux?: boolean
  /**
   * Host alias every agent resolving through this role (or, on `defaults`, every agent) runs on.
   * Declared here so "this fleet lives on the remote box" is stated once instead of repeated on
   * each preset entry — the omission that silently lands a whole fleet on the local machine.
   * An agent entry's own `hostAlias` overrides it, and an explicit `location` overrides both.
   */
  hostAlias?: string
  /**
   * Coordination edges declared for the whole role (coordination-proposals §6), so a fleet of
   * replicas — or an agent created with a bare `quimby add --role <role>`, which has no preset
   * entry — inherits them. An agent's own entry overrides these.
   */
  directs?: string[]
  escalatesTo?: string | string[]
  /** Which parcels wake agents of this role (`all` | `directed` | `never`). */
  nudge?: NudgePolicy
  /** What a nudge does when an agent of this role is the focused pane (`hold` | `nudge`). */
  whenFocused?: FocusPolicy
  /**
   * The role's standing charter, rendered into every agent of this role's `CLAUDE.md`/`AGENTS.md`.
   * This is who the agent *is* — it persists across tasks, where `assignment.md` is the current
   * task and is overwritten by the next `quimby assign`.
   */
  instructions?: string
}

export interface ConfiguredAgent {
  role?: string
  runtimeProfile?: string
  runtime?: string
  entrypoint?: string
  check?: string | CheckConfig
  verifyByDefault?: boolean
  syncRef?: string
  tmux?: boolean
  /** This agent's host alias, overriding its role's and the workspace `defaults`. */
  hostAlias?: string
  /** An explicit location, overriding every `hostAlias` above it. */
  location?: AgentLocation
  /**
   * How many instances of this entry to create — a replica count. `up` reconciles to it, naming
   * them `<entry>`, `<entry>-2`, … `<entry>-N`, each sharing the entry's config. Omitted or ≤ 1 is
   * a single agent. Combine with a `@role` layout slot to place a whole fleet in one pane.
   */
  count?: number
  /**
   * The coordination edge (coordination-proposals §6/§6a): agents this one may DIRECT on its own
   * initiative. A directed handoff along a declared edge is host-stamped `userDirected` and is the
   * only kind that interrupts (nudges) the recipient — advisory handoffs and status stay passive.
   * Entries are agent names or a `@role` slot (expands to every instance of that role). Absent ⇒
   * an ordinary advisory peer (default-deny). Escalation is the inverse of this edge.
   */
  directs?: string[]
  /**
   * Who this agent may escalate to (coordination-proposals §6b), overriding the default (every
   * agent that directs it). A list is an allow-list the agent picks one recipient from per
   * escalation — never a fan-out that wakes them all. Entries may be `@role` slots.
   */
  escalatesTo?: string | string[]
  /**
   * Which parcels wake THIS agent (`all` | `directed` | `never`), overriding its role and the
   * workspace default. The recipient's setting governs — it is the one being interrupted.
   */
  nudge?: NudgePolicy
  /**
   * What a nudge does when THIS agent's pane is the focused one (`hold` | `nudge`), overriding its
   * role and the workspace default. Orthogonal to `nudge`: that decides which parcels are worth
   * waking it for, this decides whether typing over live keystrokes is acceptable.
   */
  whenFocused?: FocusPolicy
  /** This agent's standing charter, replacing its role's. See {@link AgentRoleConfig.instructions}. */
  instructions?: string
}

export interface LayoutConfig {
  expr: string
}

export interface PresetConfig {
  agents?: Record<string, ConfiguredAgent | string>
  layout?: string | LayoutConfig
}

export interface HostAliasConfig {
  type?: 'ssh'
  /**
   * The concrete connection target ("user@host"). Optional so a tracked
   * `quimby.yaml` can *declare* an alias without committing a private address —
   * the binding is filled in per-machine from ignored local/user config (or an
   * interactive prompt at first use). An alias whose `host` is absent, empty, or
   * equal to its own name is treated as unbound.
   */
  host?: string
  port?: number
  base?: string
}

export interface OllamaRuntimeConfig {
  host?: string
  model?: string
}

export interface RuntimeProfileConfig {
  runtime?: string
  entrypoint?: string
  /** Extra argv appended to the entrypoint when no per-run --cmd override is used. */
  args?: string[]
  env?: Record<string, string>
  requiredTools?: string[]
  provider?: string
  model?: string
  ollama?: OllamaRuntimeConfig
  permissions?:
    | string
    | {
        mode?: string
        allow?: string[]
      }
}

export interface QuimbyConfig {
  defaults?: AgentRoleConfig
  roles?: Record<string, AgentRoleConfig>
  runtimeProfiles?: Record<string, RuntimeProfileConfig>
  layouts?: Record<string, string | LayoutConfig>
  presets?: Record<string, PresetConfig>
  /** @deprecated Renamed to `presets`; still read (and folded into `presets`) for back-compat. */
  recipes?: Record<string, PresetConfig>
  hosts?: Record<string, HostAliasConfig>
  /**
   * Named host-side commands a layout can place with a `$name` token (e.g.
   * `server: quimby serve`). The command runs in a dashboard-local pane, so it is
   * torn down when the dashboard exits.
   */
  services?: Record<string, string>
  /** Name of the preset bare `quimby run` opens and bare `quimby up` creates. */
  default?: string
  /**
   * Default mode for a bare `quimby merge` (no `--commits`/`--patch`/`--squashed`). One of
   * "squashed" (the built-in default when unset), "commits", or "patch" — the values match
   * `@quimbyhq/handoff`'s `ApplyMode`. Set per-repo or user-global with
   * `quimby merge <agent> --<mode> --default [--global]`, mirroring the git config model.
   */
  mergeMode?: 'squashed' | 'commits' | 'patch' | 'auto'
  /** Machine-wide agent-pool limits. Agents compete for one machine, so both keys count
   * sessions across *every* quimby project on the tmux socket, not just this workspace. */
  pool?: PoolConfig
  /**
   * Which delivered parcels wake an agent (`all` | `directed` | `never`), for every agent that
   * declares none of its own. Does NOT govern the focus guard — see `whenFocused`.
   */
  nudge?: NudgePolicy
  /**
   * What an automated nudge does when it lands on the pane a human is working in (§7): `hold` (the
   * default) stands down rather than type over live keystrokes; `nudge` types anyway. The workspace
   * default for every agent that declares none of its own.
   */
  whenFocused?: FocusPolicy
  /**
   * How long after your last keystroke a pane still counts as one you are working in (`45s`, `2m`,
   * or a bare number of MINUTES — write `45s` when you mean seconds). Defaults to 45s.
   *
   * This is the watching-vs-typing line. tmux reports a client's last *input*, not its mere
   * attachment, so a pane you are only reading stops holding once this elapses. It was a hardcoded
   * 180s, which meant supervising an agent — type a correction, then watch — held its nudges for
   * three minutes after every keystroke, and holding forever if you interjected periodically.
   * Too short is the dangerous direction: a nudge typed while you pause mid-prompt appends to your
   * draft and submits it, so raise it rather than lower it if you compose slowly.
   */
  focusGrace?: string | number
}

export interface PoolConfig {
  /**
   * Live agent sessions this machine should hold. Advisory: launching past it warns and names
   * the idlest sessions, but never refuses — the ceiling is a budget, not a lock.
   */
  maxLive?: number
  /**
   * How long an unattached agent session may sit idle before a running `quimby serve` reaps it
   * (`30s`/`45m`/`2h`/`1d`, or a bare number of minutes). Unset means never — auto-reaping is
   * opt-in, since it ends a live session's context (the work on disk is untouched).
   */
  idleTimeout?: string | number
}
