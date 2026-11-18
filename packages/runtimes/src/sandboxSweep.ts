import { execa } from 'execa'

/** Runs a shell script (with optional stdin) where the sandboxes live, returning its stdout. */
export type SandboxShellRunner = (script: string, input?: string) => Promise<string>

/** One quimby-named sandbox a runtime CLI reports. */
export interface QuimbySandbox {
  cli: SandboxCli
  name: string
}

export type SandboxCli = 'sbx' | 'openshell'

/** What a sweep found and did. `clis` empty means no sandbox CLI exists there to ask. */
export interface SandboxSweepResult {
  clis: SandboxCli[]
  removed: QuimbySandbox[]
  failed: QuimbySandbox[]
}

/** The 8-hex agent-id prefix every sandbox quimby names for that agent carries. */
export function getSandboxAgentPrefix(name: string): string | null {
  return SANDBOX_NAME.exec(name)?.[1] ?? null
}

/**
 * Every quimby-named sandbox the installed runtime CLIs report, plus which CLIs were found.
 *
 * Discovery rather than recomputation: a sandbox name hashes the agent dir AND the entrypoint
 * command, so recomputing it at teardown needs the exact command the agent last launched with —
 * which the old teardown did not have, so it removed a name that never existed, silently, every
 * time. An agent that switched commands also owns one sandbox per command. Listing and matching on
 * the stable `qb-<agentId[:8]>-` prefix finds all of them without knowing any of that.
 */
export async function listQuimbySandboxes(
  run: SandboxShellRunner,
): Promise<{ clis: SandboxCli[]; sandboxes: QuimbySandbox[] }> {
  return parseSandboxListing(await run(LIST_SCRIPT))
}

/** Run a sweep script on this machine. */
export function localSandboxShellRunner(): SandboxShellRunner {
  return async (script, input) => {
    const { stdout } = await execa('sh', ['-c', script], {
      reject: false,
      ...(input === undefined ? {} : { input }),
    })
    return stdout
  }
}

export function parseSandboxListing(stdout: string): {
  clis: SandboxCli[]
  sandboxes: QuimbySandbox[]
} {
  const clis: SandboxCli[] = []
  const seen = new Set<string>()
  const sandboxes: QuimbySandbox[] = []
  for (const line of stdout.split('\n')) {
    const [tag, cli, name] = line.split('\t')
    if (!isSandboxCli(cli)) continue
    if (tag === 'QBSBXCLI' && !clis.includes(cli)) clis.push(cli)
    if (tag === 'QBSBX' && name && getSandboxAgentPrefix(name) && !seen.has(`${cli}\t${name}`)) {
      seen.add(`${cli}\t${name}`)
      sandboxes.push({ cli, name })
    }
  }
  return { clis, sandboxes }
}

export function parseSandboxRemoval(stdout: string): {
  removed: QuimbySandbox[]
  failed: QuimbySandbox[]
} {
  const removed: QuimbySandbox[] = []
  const failed: QuimbySandbox[] = []
  for (const line of stdout.split('\n')) {
    const [tag, cli, name, outcome] = line.split('\t')
    if (tag !== 'QBSBXRM' || !isSandboxCli(cli) || !name) continue
    ;(outcome === 'ok' ? removed : failed).push({ cli, name })
  }
  return { removed, failed }
}

/** Remove exactly these sandboxes. Names are re-checked against the quimby pattern before use. */
export async function removeQuimbySandboxes(
  run: SandboxShellRunner,
  sandboxes: readonly QuimbySandbox[],
): Promise<{ removed: QuimbySandbox[]; failed: QuimbySandbox[] }> {
  const safe = sandboxes.filter((s) => getSandboxAgentPrefix(s.name))
  if (safe.length === 0) return { removed: [], failed: [] }
  // Names travel on stdin, so an unbounded list never lands on a command line.
  const input = `${safe.map((s) => `${s.cli}\t${s.name}`).join('\n')}\n`
  return parseSandboxRemoval(await run(REMOVE_SCRIPT, input))
}

/** The sandboxes belonging to these agents (by id), out of a listing. */
export function selectAgentSandboxes(
  sandboxes: readonly QuimbySandbox[],
  agentIds: readonly string[],
): QuimbySandbox[] {
  const prefixes = new Set(agentIds.map((id) => id.slice(0, 8).toLowerCase()))
  return sandboxes.filter((s) => prefixes.has(getSandboxAgentPrefix(s.name) ?? ''))
}

/**
 * Find and remove every sandbox belonging to these agents, wherever `run` executes (the host for a
 * local agent, the SSH host for a remote one). Runtime-agnostic: it asks every sandbox CLI present,
 * so it does not depend on resolving which runtime an agent last launched with — a role- or
 * profile-backed agent records none on its state, which is how the old teardown skipped it.
 */
export async function sweepAgentSandboxes(
  run: SandboxShellRunner,
  agentIds: readonly string[],
): Promise<SandboxSweepResult> {
  if (agentIds.length === 0) return { clis: [], removed: [], failed: [] }
  const { clis, sandboxes } = await listQuimbySandboxes(run)
  const { removed, failed } = await removeQuimbySandboxes(
    run,
    selectAgentSandboxes(sandboxes, agentIds),
  )
  return { clis, removed, failed }
}

function isSandboxCli(value: string | undefined): value is SandboxCli {
  return value === 'sbx' || value === 'openshell'
}

// A non-interactive SSH shell often lacks the login PATH a user installed the CLI onto.
const PATH_PREFIX = 'PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin"; export PATH;'

// Tokenize whatever the CLI prints (table, JSON, plain names) and keep only exact quimby names, so
// this never depends on a column layout. `openshell` gets two spellings of its list verb.
const LIST_SCRIPT = [
  PATH_PREFIX,
  'for c in sbx openshell; do',
  'command -v "$c" >/dev/null 2>&1 || continue;',
  `printf 'QBSBXCLI\\t%s\\n' "$c";`,
  'if [ "$c" = sbx ]; then out=$(sbx ls </dev/null 2>/dev/null);',
  'else out=$(openshell sandbox list </dev/null 2>/dev/null || openshell sandbox ls </dev/null 2>/dev/null); fi;',
  `printf '%s\\n' "$out" | tr -cs 'A-Za-z0-9-' '\\n' |`,
  "grep -E '^qb-[0-9a-f]{8}-[0-9a-f]{12}$' | sort -u |",
  `while IFS= read -r n; do printf 'QBSBX\\t%s\\t%s\\n' "$c" "$n"; done;`,
  'done',
].join(' ')

// Every removal reads </dev/null: the script's own stdin IS the list of names, and a CLI that
// prompts for confirmation would otherwise consume the rest of it as its answer.
const REMOVE_SCRIPT = [
  PATH_PREFIX,
  `t=$(printf '\\t');`,
  'while IFS="$t" read -r c n; do',
  'case "$n" in qb-*) ;; *) continue;; esac;',
  'if [ "$c" = sbx ]; then',
  'sbx rm --force "$n" </dev/null >/dev/null 2>&1 || sbx rm "$n" </dev/null >/dev/null 2>&1;',
  'elif [ "$c" = openshell ]; then',
  'openshell sandbox rm "$n" </dev/null >/dev/null 2>&1 || openshell sandbox delete "$n" </dev/null >/dev/null 2>&1;',
  'else false; fi && r=ok || r=fail;',
  `printf 'QBSBXRM\\t%s\\t%s\\t%s\\n' "$c" "$n" "$r";`,
  'done',
].join(' ')

const SANDBOX_NAME = /^qb-([0-9a-f]{8})-[0-9a-f]{12}$/
