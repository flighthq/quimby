# Quimby

CLI tool for orchestrating multiple AI agents working on a single project in isolated environments.

## Design References

@tools/agents/docs/design.md @tools/agents/docs/user-workflow.md @tools/agents/docs/build-and-tooling.md

- **design.md** — authoritative product/architecture design (concepts, CLI surface, behaviors)
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

An npm-workspace monorepo. The domain is split into one package per capability so each can mature independently; `apps/cli` is a thin command layer over them. No catch-all `core` package — name packages by capability (see Conventions).

- `apps/cli/` — the `quimby` binary; commands only
  - `src/cli.ts` — entry point (citty root command, flat subcommands; intercepts `help`/`-h`/`--help`)
  - `src/index.ts` — public API (type re-exports)
  - `src/commands/` — one file per command (add, config, run, start, stop, list, status, assign, nudge, diff, handoff, dispatch, apply, merge, sync, rebuild, rename, remove, set, serve, subscribe, unsubscribe)
  - `src/courier.ts` — shared `stageParcel` (optional rebase → assemble a commit-free working-tree parcel), reused by apply and handoff
  - `src/launch.ts` — shared tmux launch prep (`prepareLocalTmuxLaunch`, `prepareSshLaunch`): SSH sync + lazy init, runtime spec, bundled tmux config; reused by run (attach) and start (detached)
  - `src/banner.ts` — colored wordmark on root help; `src/help.ts` — grouped root-help renderer; `src/walkthrough.ts` — interactive agent config (`@clack/prompts`)
- `packages/types/` — `@quimbyhq/types` — shared types, **one PascalCase file per interface** (`QuimbyState.ts`, `AgentState.ts`, `AgentSessionState.ts`, `HandoffMeta.ts`, `CommitMeta.ts`, `AgentLocation.ts`, `LocalLocation.ts`, `SSHLocation.ts`, `RuntimeAdapter.ts`, `RuntimeContext.ts`, `RunSpec.ts`, `RuntimeType.ts`); `index.ts` is the barrel
- `packages/errors/` — `@quimbyhq/errors` — error taxonomy (QuimbyError, GitError, AgentError, HandoffError, ConflictError)
- `packages/utils/` — `@quimbyhq/utils` — tiny generic helpers only: fs, yaml, logger
- `packages/paths/` — `@quimbyhq/paths` — quimby on-disk + remote layout (getAgentDir, remote\*, tmuxSessionName, getTmuxConfigPath, `quimbyTmuxSocket`)
- `packages/template/` — `@quimbyhq/template` — generated text: agent CLAUDE.md (renderAgentClaudeMd) and the bundled tmux config (renderTmuxConfig)
- `packages/git/` — `@quimbyhq/git` — typed wrapper over the git CLI
- `packages/transport/` — `@quimbyhq/transport` — LocalTransport / SSHTransport abstraction (`sq`, getTransport, getSSHTransport)
- `packages/runtimes/` — `@quimbyhq/runtimes` — execution adapters (local, sbx, openshell) + registry + buildContext
- `packages/session/` — `@quimbyhq/session` — a live agent's tmux session: waking it (nudgeAgentSession, hasAgentSession) and reading its state (getAgentSessionState → running/attached/stopped); reused by the CLI nudge/assign/dispatch/handoff/start/stop/list and the server's auto-dispatch
- `packages/workspace/` — `@quimbyhq/workspace` — `.quimby/` state lifecycle (resolve/ensure/load/save, migrations)
- `packages/agent/` — `@quimbyhq/agent` — agent lifecycle (add, remove, rename, sync, rebuild, sync targets)
- `packages/handoff/` — `@quimbyhq/handoff` — parcel lifecycle + apply, the boundary (assemble, deliver, apply, discard, readOutbox\*, markHandoffSent, dispatchOutbox — the shared outbox-enact core reused by the CLI `dispatch` and the server)
- `packages/server/` — `@quimbyhq/server` — HTTP server + status poller + outbox auto-dispatch + client (CLI → server API)

Dependency flow is a DAG: leaves (types, errors, utils, paths, template) → git/transport/runtimes/session → workspace → agent/handoff → server → apps/cli.

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

## CLI Commands

```
quimby add <agent> [-H <host>] [--port <n>] [-s <ref>]  # create an agent; with no config flags, runs the interactive walkthrough (flags skip it and stay scriptable)
quimby config <agent>                               # interactively (re)configure an agent (runtime, entrypoint, local/remote, tmux, sync)
quimby run <agent> [-c <cmd>] [-r <runtime>]       # launch the agent interactively (local tmux agents attach to a named session)
quimby start <agent> [-c <cmd>] [-r <runtime>]     # launch the agent headless in a detached tmux session (idempotent; enrolls a local agent into tmux); drive with assign/nudge, attach with run, stop with stop
quimby stop <agent>                                 # kill the agent's tmux session (headless or attached); work on disk is untouched
quimby set <agent> [-r <rt>] [-c <cmd>] [-H <host>] [--port <n>] [-s <ref>]  # update agent config (-c sets the entrypoint command, -s retargets the sync ref)
quimby list                                          # show agents and subscriptions (with each agent's live session state: running / attached / stopped)
quimby help [command]                                # root help (grouped + banner), or usage for one command
quimby status [agent]                               # show agent-written status
quimby assign <agent> -m "..." [--no-sync] [--no-nudge] [-c]  # set an agent's current task; syncs to base first (--no-sync to skip), writes assignment.md, wakes a running agent (--no-nudge to skip); -c/--clear types /clear before the nudge
quimby diff <agent> [agent2]                        # show an agent's live diff against its seed
quimby nudge <agent> [-m <msg>] [-c] | --all [-m <msg>] [-c]  # wake a running agent by typing a message (default "continue") + Return into its tmux session; -c/--clear types /clear first to reset context; --all broadcasts to every agent with a live tmux session (probed, so dead ones are skipped); -m also carries CLI control commands ("/clear", "/model …")
quimby handoff <from> <to> | <to> [-m <note>] [--attach <w>] [--rebase] [--nudge|--no-nudge] [-c]  # carry <from>'s work to <to>; with one arg, the host's work → that agent (sender "host"); nudges the recipient by default only when a note (-m) is present; -c/--clear types /clear before the nudge
quimby dispatch <agent> | --all [--rebase] [--no-nudge]  # deliver the agent's queued outbox parcels to their recipients (--all dispatches every agent's outbox; bounces unknown recipients; drains to outbox/.sent on success); nudges each running recipient via tmux by default
quimby apply <agent> [--commits|--patch] [-b] [-t] [--rebase]  # package the agent's work and merge it into your repo (merge-based: builds on a temp branch from the seed, then a fast-forward-when-possible merge into target — linear when the target is still at the seed, a standard merge commit only when it diverged; conflicts are standard git merge conflicts)
quimby sync <agent...> [--all] [-f] [--base <ref>] [--current]  # sync agent(s) to their syncRef tip, keeping work (auto-stash/rebase/pop); -f hard-resets (drops work, keeps mailbox); --base retargets; --current retargets to the host's current branch (allowed with --all); rsyncs SSH agents
quimby rebuild <agent> --force                       # recreate agent from current source (requires --force; discards work + clears inbox/outbox/assignment/status)
quimby rename <agent> <new-name>                    # rename agent
quimby remove <agent> [--force]                     # remove agent (--force skips remote cleanup)
quimby serve [-p <port>] [--poll <secs>] [-it] [--no-dispatch]  # start the server; polls status, auto-dispatches settled outbox drafts (--no-dispatch to skip), routes subscriptions; -it/--interactive stacks a shell on top (run commands live; `exit` or double Ctrl+C stops it)
quimby subscribe <agent> <target>                   # agent receives target's status
quimby unsubscribe <agent> <target>                 # remove subscription
```

## Conventions

- Agents are isolated clones in `.quimby/agents/<id>/repo/` — directories are keyed by the agent's stable UUID (`AgentState.id`), not its name, so a rename never moves them (the sandbox/tmux bound to that path survive); the name is a display label only. Legacy name-keyed dirs migrate on state load
- Handoffs are ephemeral parcels (folders: optional `README.md` note + optional `squashed.diff`/`commits/` + `meta.yaml`) named `<from>-<contentHash>`, staged transiently in `.quimby/staging/<name>/` then discarded once consumed (kept only on apply conflict) — not an archive; durable work lives in git. Delivered parcels land in `inbox/<from>-<hash>/`
- `handoff` is direct transport: `handoff A B` (agent→agent) or `handoff B` (host→B, sender `host`, diff = host worktree vs B's seed). `dispatch <agent>` enacts the agent's outbox: drafts are addressed by recipient (`outbox/<recipient>/`, optional `attach:` frontmatter), delivered, drained to `outbox/.sent/` only on success, with unknown recipients bounced (left in the outbox). `host` is a reserved agent name
- Seed ref is `quimby/seed` tag in agent repos
- Each agent records a `syncRef` (default: host branch at `add` time); `quimby sync` resolves that ref's tip in the host repo as the new baseline — it does not follow the host's live HEAD. Retarget with `quimby sync <agent> --base <ref>`, or `quimby sync <agent> --current` to retarget to the host's checked-out branch (sugar for `--base <current-branch>`, persisted; allowed with `--all`; errors on detached HEAD) — pair with `-f` for the post-integration "snap onto where I am, drop shipped work" move (or record-only via `quimby set <agent> --sync <ref>`)
- Subscriptions stored in `state.yaml`, routed by server; the server also auto-dispatches settled outbox drafts each poll (debounced on mtime stability; `serve --no-dispatch` opts out) — additive to subscriptions, not a replacement
- Server writes `.quimby/server.json` pidfile when running
- All file paths use pathe for cross-platform consistency
- Prefer the unjs ecosystem (citty, consola, pathe)
- Parcel meta.yaml is always written last (signals completion); `deliverHandoff` only routes a fully-staged parcel
- No config file required — `quimby add` initializes everything
- CLI grammar: `verb target [qualifiers]`
- Flags: `-x` short + `--xxx` long (e.g., `-m`/`--message`, `-c`/`--cmd`, `-s`/`--sync`)
- `QuimbyState.id` and `AgentState.id` are stable UUIDs; existing state is migrated on load
- SSH agents are initialized lazily on first `quimby run` (no SSH required at `quimby add`)
- Every agent runs in its own persistent tmux session named `qb-<agentId[:8]>` for stable identity (universal tmux — local agents no longer opt in; `run` always attaches-or-creates the one canonical session via `new-session -A`, so it grabs the session wherever launched, and enrolls the `tmux` field so `nudge`/`list` recognize it). `quimby run <a> <b>` opens a **dashboard**: one viewport session that `link-window`s each agent's own window in as a tab (local) or ssh-attaches its remote session (SSH) — so closing/rebuilding the dashboard never kills an agent, and a single status bar (the dashboard's) shows with no nested inner bars. All quimby tmux runs on a dedicated server socket (`tmux -L quimby`) started from a bundled config (`renderTmuxConfig` → `.quimby/tmux.conf`), which sources the user's `~/.tmux.conf` then enforces mouse/true-color/history/window-naming. Every tmux call (run, nudge's has-session/send-keys) must pass `-L quimbyTmuxSocket` or it won't see the sessions
- Remote layout: `~/.quimby/workspaces/<projectId>/.quimby/agents/<id>/`
- `sq()` in transport.ts: POSIX single-quote escaping for safe SSH command arguments
- Each command exports a named `run<Name>Command` function at module level (e.g. `runAddCommand`), referenced as `run:` in defineCommand — not inline
- No `.js` extensions in imports — `moduleResolution: "bundler"` handles resolution
- Libraries build via `tsc -b` project references — a new package must be registered in `tsconfig.build.json` references and the `tsconfig.base.json` paths map (`packages:check` enforces this). See build-and-tooling.md
- Split by domain: every package names one capability with a clean dependency boundary. No catch-all `core`/`utils` drawers — `utils` is only for genuinely tiny, generic, domain-less helpers (fs/yaml/logger). Anything with a domain (paths, errors, git, …) gets its own package. New domains get their own package even when small, so they have room to grow
- `@quimbyhq/types` holds one PascalCase file per interface; the `types/` listing is meant to read as the API surface
- Cross-package references go through the package name (`@quimbyhq/<pkg>`), never a deep relative path; a package's own modules use relative imports

## Coding Style

**Naming**

- Prefer globally unique exported function names — a name should identify its domain without context
- Exported function names include the full, unabbreviated type name they operate on (e.g. `resolveAgentPath`, not `resolvePath` if it's agent-specific)
- Accessor functions use the `get*` prefix; boolean-returning functions use `has*` or `is*`
- Choose names whose meaning transfers instantly — if a name requires explanation, find a more precise word

**Types**

- Use `Readonly<T>` for parameters and stored references where mutation is not intended — default to immutable, opt out only when mutation is deliberate
- `import type { Foo }` must be on its own `import type { }` line — never mix type imports with value imports as `import { type Foo, bar }`

**Error handling**

- Return sentinel values (`null`, `false`, `-1`) for expected failure cases — missing lookups, invalid input
- Throw only for programmer errors: precondition violations that represent API misuse and should never occur in correct code

**Source layout**

- Keep exported functions alphabetized within a file unless local readability strongly requires otherwise
- Module-level constants, scratch objects, and private helpers belong at the bottom of the file, after exported functions
- Avoid structural divider comments like `// --- setup ---` — use file and function boundaries instead
- Add comments only when a name cannot carry the full rule: hidden constraints, aliasing, coordination semantics. Do not comment obvious assignments
- Keep transient work notes (TODOs, "half-done") out of source — they belong in `status.md`

**After editing**

- Run `npm run fix` to auto-fix lint and formatting in one step
- Run `npm run check` before committing to catch type errors, lint, and formatting issues
- Run `npm run ci` before broad changes or API reshapes

## Testing

- One test file per source file, colocated in `src/`, named `*.test.ts`
- `describe` blocks alphabetized, mirroring exported function or object names
- Use `npm run test:run` for a single non-watch pass; `npm run test:coverage` to check coverage
