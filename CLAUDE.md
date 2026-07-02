# Quimby

CLI tool for orchestrating multiple AI agents working on a single project in isolated environments.

## Design References

@tools/agents/docs/design.md @tools/agents/docs/cli-surface.md @tools/agents/docs/design-decisions.md @tools/agents/docs/user-workflow.md @tools/agents/docs/build-and-tooling.md

- **design.md** — authoritative product/architecture design (concepts, behaviors, lifecycles); links out to the two companion docs below
- **cli-surface.md** — the complete command and flag reference (split out of design.md)
- **design-decisions.md** — the key-design-decisions rationale log (split out of design.md)
- **user-workflow.md** — the real-world multi-agent workflow quimby is built to support
- **build-and-tooling.md** — build system (`tsc -b` project references), monorepo tsconfig layout, governance scripts, packaging model, interactive config + tmux. **Read before touching `tsconfig.*`, build scripts, or `scripts/`.**

## Tech Stack

- TypeScript, ESM, Node 22+
- Citty (unjs) for CLI; `@clack/prompts` for interactive walkthroughs
- `tsc -b` project references build the libraries; tsup bundles only the `quimby` CLI binary (see build-and-tooling.md)
- execa for process spawning
- consola for logging
- vitest for testing

## Project Structure

An npm-workspace monorepo. The domain is split into one package per capability so each can mature independently; `apps/cli` is a thin command layer over them. No catch-all `core` package — name packages by capability.

- `apps/cli/` — the `quimby` binary; commands only. A command parses args, calls **one operation** in a capability package, then renders the result and enacts CLI-only side effects (tmux `execa`, `process.exit`, the live-session nudge). The domain logic — assign/handoff/merge/sync/dispatch flows, tmux launch — lives in the packages, not here
  - `src/cli.ts` — entry point (citty root command, flat subcommands; intercepts `help`/`-h`/`--help`)
  - `src/index.ts` — public API (type re-exports)
  - `src/commands/` — one file per command (add, config, run, start, stop, list, status, assign, nudge, diff, handoff, dispatch, apply, merge, sync, rebuild, rename, remove, set, serve, subscribe, unsubscribe)
  - `src/reporter.ts` — `consolaReporter`: the one binding of consola to the `@quimbyhq/reporter` `Reporter` contract; passed into operations so packages narrate progress without importing consola
  - `src/banner.ts` — colored wordmark on root help; `src/help.ts` — grouped root-help renderer; `src/walkthrough.ts` — interactive agent config (`@clack/prompts`)
- `packages/types/` — `@quimbyhq/types` — shared types, **one PascalCase file per interface** (`QuimbyState.ts`, `AgentState.ts`, `AgentSessionState.ts`, `HandoffMeta.ts`, `CommitMeta.ts`, `AgentLocation.ts`, `LocalLocation.ts`, `SSHLocation.ts`, `RuntimeAdapter.ts`, `RuntimeContext.ts`, `RunSpec.ts`, `RuntimeType.ts`); `index.ts` is the barrel
- `packages/errors/` — `@quimbyhq/errors` — error taxonomy (QuimbyError, GitError, AgentError, HandoffError, ConflictError)
- `packages/utils/` — `@quimbyhq/utils` — tiny generic helpers only: fs, yaml, logger (the consola primitive; only `apps/cli` consumes it)
- `packages/paths/` — `@quimbyhq/paths` — quimby on-disk + remote layout (getAgentDir, remote\*, tmuxSessionName, getTmuxConfigPath, `quimbyTmuxSocket`)
- `packages/reporter/` — `@quimbyhq/reporter` — the `Reporter` progress-sink contract (start/success/info/warn/error) + `silentReporter` + `collectingReporter` (tests). Operations take a `Reporter` so package logic never imports consola; the consola-backed impl lives in `apps/cli`
- `packages/template/` — `@quimbyhq/template` — generated text: agent CLAUDE.md (renderAgentClaudeMd) and the bundled tmux config (renderTmuxConfig)
- `packages/git/` — `@quimbyhq/git` — typed wrapper over the git CLI
- `packages/transport/` — `@quimbyhq/transport` — LocalTransport / SSHTransport abstraction (`sq`, getTransport, getSSHTransport) + SSHLocation parsing primitives (parseSSHHostSpec, buildSSHLocation, mergeSSHLocation)
- `packages/runtimes/` — `@quimbyhq/runtimes` — execution adapters (local, sbx, openshell) + registry + buildContext
- `packages/session/` — `@quimbyhq/session` — a live agent's tmux session: waking it (nudgeAgentSession, hasAgentSession) and reading its state (getAgentSessionState → running/attached/stopped); reused by the CLI nudge/assign/dispatch/handoff/start/stop/list and the server's auto-dispatch
- `packages/workspace/` — `@quimbyhq/workspace` — `.quimby/` state lifecycle (resolve/ensure/load/save, migrations) + subscription mutations (addSubscriptionToState/removeSubscriptionFromState, shared by the CLI and the server)
- `packages/agent/` — `@quimbyhq/agent` — agent lifecycle (add, remove, rename, rebuild, sync targets) + operations: `assignAgentTask` (write→sync→nudge directive), `syncAgents` (multi-agent sync with outcome classification), `rebaseAgentOntoBase` (the `--rebase` beforeStage seam). `syncAgent` drives the pure `runSyncAlgorithm` (in `syncAlgorithm.ts`) over a `RepoSyncOps` backend — local (git CLI) and SSH (git over transport) share one stash/rebase/reset/tag algorithm, tested against a fake. Agent provisioning is factored into primitives too: `cloneAndSeedAgentRepo`/`writeAgentScaffold` (local) and the exported `cloneAndSeedRemoteAgentRepo`/`writeRemoteAgentScaffold` (SSH, reused by `@quimbyhq/launch`'s `prepareSshLaunch`), so `addAgent`/`rebuildAgent`/first-run init share one clone+seed+scaffold path
- `packages/handoff/` — `@quimbyhq/handoff` — parcel lifecycle + the boundary. Primitives (assemble, deliver, apply, discard, readOutbox\*, markHandoffSent, dispatchOutbox) plus the command-level operations: `handoffWork` (direct carry, host-vs-agent), `mergeAgentWork` (stage→apply→discard, conflict as a thrown `ConflictError`), `dispatchOutboxes` (multi-sender), `stageParcel`, `inboxNoticeText`. `assembleHandoff`/`assembleRemoteHandoff` are thin adapters over the pure `assembleParcel` (in `assembleParcel.ts`) driven by a `RepoAssembleOps` backend — one assembly algorithm for local + SSH, tested against a fake
- `packages/launch/` — `@quimbyhq/launch` — tmux launch orchestration for run/start/dashboard: `resolveRuntimeSelection`, `prepareLocalTmuxLaunch`/`localNewSessionArgs`, `prepareSshLaunch` (SSH sync + lazy init, one place), `buildForegroundLaunch`, `buildDashboardWindows`/`buildDashboardPlan`. Returns specs/arg-vectors; the CLI does the `execa`/`process.exit`
- `packages/server/` — `@quimbyhq/server` — HTTP server + status poller + outbox auto-dispatch + client (CLI → server API); takes a `Reporter` for all output

Dependency flow is a DAG: leaves (types, errors, utils, paths, reporter, template) → git/transport/runtimes/session → workspace → agent/handoff → launch → server → apps/cli.

## Development

```bash
npm install
npm run build         # tsc -b project references (libs) + tsup (CLI binary)
npm run build:libs    # tsc -b tsconfig.build.json (libraries only)
npm run typecheck     # tsc -b --noEmit
npm test              # vitest (watch)
npm run test:run      # vitest run (no watch)
npm run test:coverage # vitest run with coverage
npm run fix           # order:fix + lint:fix + format (auto-fix all)
npm run check         # packages:check + typecheck + lint + format check + order:check
npm run ci            # build + check + test (full gate)
```

Governance scripts (see build-and-tooling.md for what each enforces):

```bash
npm run packages:check  # per-package structure/registration invariants (gates check)
npm run order:check     # describe blocks alphabetized (gates check); order:fix to repair
npm run exports:check   # describe-per-exported-function coverage (informational)
```

## Conventions

**Architecture**

- Split by domain: every package names one capability with a clean dependency boundary. No catch-all `core`/`utils` drawers — `utils` is only for genuinely tiny, generic, domain-less helpers (fs/yaml/logger). New domains get their own package even when small
- `@quimbyhq/types` holds one PascalCase file per interface; the `types/` listing is meant to read as the API surface
- Cross-package references go through the package name (`@quimbyhq/<pkg>`), never a deep relative path; a package's own modules use relative imports
- Libraries build via `tsc -b` project references — a new package must be registered in `tsconfig.build.json` references and the `tsconfig.base.json` paths map (`packages:check` enforces this). See build-and-tooling.md

**CLI patterns**

- CLI grammar: `verb target [qualifiers]`
- Flags: `-x` short + `--xxx` long (e.g., `-m`/`--message`, `-c`/`--cmd`, `-s`/`--sync`)
- Each command exports a named `run<Name>Command` function at module level (e.g. `runAddCommand`), referenced as `run:` in defineCommand — not inline
- Prefer the unjs ecosystem (citty, consola, pathe)
- All file paths use pathe for cross-platform consistency
- No `.js` extensions in imports — `moduleResolution: "bundler"` handles resolution

**Identity and state**

- `QuimbyState.id` and `AgentState.id` are stable UUIDs; directories keyed by UUID, not name — rename is a pure relabel. Existing name-keyed dirs migrate on state load
- tmux sessions named `qb-<agentId[:8]>` on a dedicated server socket (`tmux -L quimby`); every tmux call must pass `-L quimbyTmuxSocket`
- `host` is a reserved agent name
- Parcel `meta.yaml` is always written last (signals completion)
- No config file required — `quimby add` initializes everything

See design.md for the full CLI surface, handoff lifecycle, apply/sync/rebuild semantics, communication model, and key design decisions.

## Coding Style

**Naming**

- Prefer globally unique exported function names — a name should identify its domain without context
- Exported function names include the full, unabbreviated type name they operate on (e.g. `resolveAgentPath`, not `resolvePath` if it's agent-specific)
- Accessor functions use the `get*` prefix; boolean-returning functions use `has*` or `is*`

**Types**

- Use `Readonly<T>` for parameters and stored references where mutation is not intended — default to immutable, opt out only when mutation is deliberate
- `import type { Foo }` must be on its own `import type { }` line — never mix type imports with value imports as `import { type Foo, bar }`

**Error handling**

- Return sentinel values (`null`, `false`, `-1`) for expected failure cases — missing lookups, invalid input
- Throw only for programmer errors: precondition violations that represent API misuse and should never occur in correct code

**Source layout**

- Keep exported functions alphabetized within a file unless local readability strongly requires otherwise
- Module-level constants, scratch objects, and private helpers belong at the bottom of the file, after exported functions
- Avoid structural divider comments — use file and function boundaries instead
- Add comments only when a name cannot carry the full rule: hidden constraints, aliasing, coordination semantics
- Keep transient work notes (TODOs, "half-done") out of source — they belong in `status.md`

**After editing**

- Run `npm run fix` to auto-fix lint and formatting in one step
- Run `npm run check` before committing to catch type errors, lint, and formatting issues
- Run `npm run ci` before broad changes or API reshapes

## Testing

- One test file per source file, colocated in `src/`, named `*.test.ts`
- `describe` blocks alphabetized, mirroring exported function or object names
- Use `npm run test:run` for a single non-watch pass; `npm run test:coverage` to check coverage
