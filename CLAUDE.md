# Quimby

CLI tool for orchestrating multiple AI agents working on a single project in isolated workers.

## Design References

@tools/agents/docs/design-v2.md @tools/agents/docs/user-workflow.md

## Tech Stack

- TypeScript, ESM, Node 22+
- Citty (unjs) for CLI
- tsup for bundling
- execa for process spawning
- consola for logging
- vitest for testing

## Project Structure

An npm-workspace monorepo. The domain is split into one package per capability so each can mature independently; `apps/cli` is a thin command layer over them. No catch-all `core` package — name packages by capability (see Conventions).

- `apps/cli/` — the `quimby` binary; commands only
  - `src/cli.ts` — entry point (citty root command, flat subcommands)
  - `src/index.ts` — public API (type re-exports)
  - `src/commands/` — one file per command (add, run, list, status, assign, diff, pack, apply, send, sync, advance, reset, rename, remove, set, serve, subscribe, unsubscribe, flush)
- `packages/types/` — `@quimbyhq/types` — shared types, **one PascalCase file per interface** (`QuimbyState.ts`, `WorkerState.ts`, `PackMeta.ts`, `CommitMeta.ts`, `WorkerLocation.ts`, `LocalLocation.ts`, `SSHLocation.ts`, `RuntimeAdapter.ts`, `RuntimeContext.ts`, `RunSpec.ts`, `RuntimeType.ts`); `index.ts` is the barrel
- `packages/errors/` — `@quimbyhq/errors` — error taxonomy (QuimbyError, GitError, WorkerError, PackError, ConflictError)
- `packages/utils/` — `@quimbyhq/utils` — tiny generic helpers only: fs, yaml, logger
- `packages/paths/` — `@quimbyhq/paths` — quimby on-disk + remote layout (getWorkerDir, remote\*, tmuxSessionName)
- `packages/template/` — `@quimbyhq/template` — worker CLAUDE.md / instruction generation
- `packages/git/` — `@quimbyhq/git` — typed wrapper over the git CLI
- `packages/transport/` — `@quimbyhq/transport` — LocalTransport / SSHTransport abstraction (`sq`, getTransport, getSSHTransport)
- `packages/runtimes/` — `@quimbyhq/runtimes` — execution adapters (local, sbx, openshell) + registry + buildContext
- `packages/workspace/` — `@quimbyhq/workspace` — `.quimby/` state lifecycle (resolve/ensure/load/save, migrations)
- `packages/worker/` — `@quimbyhq/worker` — worker lifecycle (add, remove, rename, reset, advance, sync targets)
- `packages/pack/` — `@quimbyhq/pack` — pack lifecycle + apply, the membrane (create, list, read, apply, send)
- `packages/server/` — `@quimbyhq/server` — HTTP server + status poller + client (CLI → server API)

Dependency flow is a DAG: leaves (types, errors, utils, paths, template) → git/transport/runtimes → workspace → worker/pack → server → apps/cli.

## Development

```bash
npm install
npm run build         # build with tsup
npm run dev           # build with watch
npm run typecheck     # tsc --noEmit
npm test              # vitest (watch)
npm run test:run      # vitest run (no watch)
npm run test:coverage # vitest run with coverage
npm run fix           # lint:fix + format (auto-fix all)
npm run check         # typecheck + lint + format check
npm run ci            # build + check + test (full gate)
```

## CLI Commands

```
quimby add <worker> [-H <host>] [--port <n>] [-s <ref>]  # create a worker (--host for SSH, --sync sets the advance target)
quimby run <worker> [-a <agent>] [-r <runtime>]     # launch agent interactively
quimby sync <worker>                                 # rsync project to SSH worker host
quimby set <worker> [-r <rt>] [-a <agent>] [-H <host>] [--port <n>] [-c <cmd>] [-s <ref>]  # update worker config (-c sets verification command, -s retargets the advance ref)
quimby list                                          # show workers, packs, subscriptions
quimby status [worker]                               # show agent-written status
quimby assign <worker> -m "..." [-p <pack>]          # push assignment
quimby diff <worker|pack> [other]                    # show changes
quimby pack <worker> [-n <name>] [-m <msg>] [--rebase] [--skip-check]  # package worker's work (auto-commits dirty tree; --rebase rebases onto host HEAD first; runs the worker's check)
quimby apply <pack> [--commits|--patch] [--3way]     # apply pack to host repo (--3way: merge conflicts instead of aborting)
quimby send <worker> <pack>                          # route pack to worker
quimby advance <worker...> [--all]                   # fast-forward worker(s) to their recorded syncRef tip (preserves assignment/status/inbox); --all skips busy workers
quimby reset <worker> --force                        # nuclear reset worker (requires --force; wipes assignment/status)
quimby rename <worker> <new-name>                    # rename worker
quimby remove <worker> [--force]                     # remove worker (--force skips remote cleanup)
quimby serve [-p <port>] [--poll <secs>]             # start the server
quimby subscribe <worker> <target>                   # worker receives target's status
quimby unsubscribe <worker> <target>                 # remove subscription
```

## Conventions

- Workers are isolated clones in `.quimby/workers/<name>/repo/`
- Packs are flat in `.quimby/packs/<name>/` — decoupled from workers
- Seed ref is `quimby/seed` tag in worker repos
- Each worker records a `syncRef` (default: host branch at `add` time); `quimby advance` resolves that ref's tip in the host repo as the new baseline — it does not follow the host's live HEAD. Retarget explicitly with `quimby set <worker> --sync <ref>`
- Subscriptions stored in `state.yaml`, routed by server
- Server writes `.quimby/server.json` pidfile when running
- All file paths use pathe for cross-platform consistency
- Prefer the unjs ecosystem (citty, consola, pathe)
- Pack meta.yaml is always written last (signals completion)
- No config file required — `quimby add` initializes everything
- CLI grammar: `verb target [qualifiers]`
- Flags: `-x` short + `--xxx` long (e.g., `-m`/`--message`, `-p`/`--pack`, `-n`/`--name`)
- `QuimbyState.id` and `WorkerState.id` are stable UUIDs; existing state is migrated on load
- SSH workers are initialized lazily on first `quimby run` (no SSH required at `quimby add`)
- SSH workers use tmux sessions named `qb-<projectId[:8]>-<workerId[:8]>` for stable identity
- Remote layout: `~/.quimby/workspaces/<projectId>/.quimby/workers/<name>/`
- `sq()` in transport.ts: POSIX single-quote escaping for safe SSH command arguments
- Each command exports a named `run` function at module level (not inline in defineCommand)
- No `.js` extensions in imports — `moduleResolution: "bundler"` handles resolution
- Split by domain: every package names one capability with a clean dependency boundary. No catch-all `core`/`utils` drawers — `utils` is only for genuinely tiny, generic, domain-less helpers (fs/yaml/logger). Anything with a domain (paths, errors, git, …) gets its own package. New domains get their own package even when small, so they have room to grow
- `@quimbyhq/types` holds one PascalCase file per interface; the `types/` listing is meant to read as the API surface
- Cross-package references go through the package name (`@quimbyhq/<pkg>`), never a deep relative path; a package's own modules use relative imports

## Coding Style

**Naming**

- Prefer globally unique exported function names — a name should identify its domain without context
- Exported function names include the full, unabbreviated type name they operate on (e.g. `resolveWorkerPath`, not `resolvePath` if it's worker-specific)
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
