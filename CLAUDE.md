# Quimby

CLI tool for orchestrating multiple AI agents working on a single project in isolated workers.

## Design References

@docs/design-v2.md
@docs/user-workflow.md

## Tech Stack

- TypeScript, ESM, Node 22+
- Citty (unjs) for CLI
- tsup for bundling
- execa for process spawning
- consola for logging
- vitest for testing

## Project Structure

- `src/cli.ts` — CLI entry point (citty root command, flat subcommands)
- `src/index.ts` — public API (type exports)
- `src/commands/` — CLI command implementations (one file per command)
  - `add.ts`, `run.ts`, `list.ts`, `status.ts`, `assign.ts`
  - `diff.ts`, `pack.ts`, `apply.ts`, `send.ts`, `sync.ts`
  - `reset.ts`, `rename.ts`, `remove.ts`, `set.ts`
  - `serve.ts`, `subscribe.ts`, `unsubscribe.ts`
- `src/core/` — business logic
  - `workspace.ts` — resolve .quimby/ from git root, load/save state
  - `worker.ts` — add, remove, rename, reset workers
  - `pack.ts` — create, list, read, apply, send packs
  - `server.ts` — HTTP server + status poller for cross-worker routing
  - `client.ts` — CLI → server communication (check if running, API calls)
  - `template.ts` — generate CLAUDE.md for workers
  - `transport.ts` — LocalTransport / SSHTransport abstraction
- `src/runtimes/` — runtime adapters (local, sbx, openshell)
  - `index.ts` — registry + buildContext
  - `local.ts`, `sbx.ts`, `openshell.ts`
- `src/types/` — type definitions
  - `workspace.ts` — QuimbyState, WorkerState
  - `pack.ts` — PackMeta, CommitMeta
  - `location.ts` — WorkerLocation, LocalLocation, SSHLocation
  - `runtime.ts` — RuntimeAdapter, RuntimeContext, RunSpec
- `src/utils/` — utilities (git, fs, paths, yaml, logger, errors)

## Development

```bash
npm install
npm run build         # build with tsup
npm run dev           # build with watch
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run test:run      # vitest run (no watch)
npm run check         # typecheck + lint + format check
```

## CLI Commands

```
quimby add <worker> [-H <host>] [--port <n>]        # create a worker (--host for SSH)
quimby run <worker> [-a <agent>] [-r <runtime>]     # launch agent interactively
quimby sync <worker>                                 # rsync project to SSH worker host
quimby set <worker> [-r <rt>] [-a <agent>] [-H <host>] [--port <n>]  # update worker config
quimby list                                          # show workers, packs, subscriptions
quimby status [worker]                               # show agent-written status
quimby assign <worker> -m "..." [-p <pack>]          # push assignment
quimby diff <worker|pack> [other]                    # show changes
quimby pack <worker> [-n <name>]                     # package worker's work
quimby apply <pack> [--commits|--patch]              # apply pack to host repo
quimby send <worker> <pack>                          # route pack to worker
quimby reset <worker> --force                        # nuclear reset worker (requires --force)
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
