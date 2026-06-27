# Quimby — Design (v2)

This is the authoritative design document.

## Overview

Quimby is a CLI tool for orchestrating multiple AI agents working on a single project. Each agent operates in an isolated **worker** — a local clone of the source repo inside a sandbox. Workers produce **packs** (packaged units of work) that can be reviewed, routed to other workers, or applied to the user's real repository.

Named after Chief Quimby from Inspector Gadget — the user assigns work, agents deliver packages.

This is infrastructure for multi-agent orchestration, not a thin wrapper around scripts. Networking, a local server, persistent state, and subscription management are all in scope.

## Core Concepts

**Worker** — An isolated agent environment. Each worker gets its own clone of the source repo, can commit locally, and produces packs. Workers are ephemeral; packs are permanent. Workers run inside sandboxes (Docker Sandbox, OpenShell, etc.) that prevent them from seeing each other — all cross-worker communication is mediated by the host.

**Pack** — A packaged unit of work output from a worker. Contains a squashed diff, individual commit patches, and metadata. Packs live in a flat namespace (not nested under workers) and survive worker resets/removal.

**Seed** — The `quimby/seed` git tag in each worker's repo marking the baseline. All pack diffs are computed against this tag.

**Membrane** — The boundary between the workspace (where agents work) and the user's real repository. Work only crosses the membrane through explicit user action (`quimby apply`).

**Server** — The host-side process that enables cross-worker visibility. Workers in sandboxes are isolated from each other — the server is the only entity that can see all workers. It polls for status changes and routes updates to subscribing workers.

## Three Modes of Worker Interaction

These are distinct concepts that coexist, not alternatives:

### 1. Interactive Worker (`quimby run`)

Takes over a terminal. The user is in a live CLI session with the agent (like running `claude` directly). This is the onramp and never goes away — sometimes you want to pair with the agent. Implemented.

### 2. Headless Worker (`quimby start`)

Launches an agent in the background. The user interacts via `quimby assign`, reads results via `quimby status` and `quimby diff`. The agent runs to completion or waits for new assignments. Not yet implemented — depends on sandbox ecosystem support for headless operation.

### 3. Server (`quimby serve`)

The host-side process that enables everything requiring cross-worker visibility:
- Polls worker `status.md` files for changes
- Routes status updates to subscribing workers' `inbox/status/` directories
- Exposes an HTTP API on localhost for status aggregation and subscription management

The server doesn't replace `run` or `start` — it enables the connections between workers that sandbox isolation otherwise prevents. Implemented.

```
quimby serve                        # start the server
quimby add backend                  # create a worker
quimby run backend                  # interactive session (server optional)
quimby subscribe reviewer backend   # reviewer gets backend's status
quimby assign backend -m "..."      # works with or without server
```

## Directory Layout

```
my-project/
  .quimby/
    state.yaml              # workspace state (workers, subscriptions)
    server.json             # server pidfile (when running)
    workers/
      backend/
        repo/               # cloned source tree, tagged quimby/seed
        assignment.md        # current task
        status.md            # agent-written status
        CLAUDE.md            # generated agent instructions
        inbox/               # packs and status routed to this worker
          pack-name/         # a routed pack
          status/            # status updates from subscribed workers
            frontend.md      # latest status from frontend worker
      frontend/
        ...
    packs/
      backend-1/
        meta.yaml            # name, worker, description, commits
        squashed.diff         # combined diff against seed
        commits/              # individual .patch files
      auth-refactor/          # explicitly named pack
        ...
  src/
  package.json
  ...
```

Packs are flat — no hierarchy, no slashes. Auto-named `<worker>-<N>` or explicitly named via `--name`.

## CLI Surface

All commands follow `verb target [qualifiers]`. First positional is always the target (worker or pack).

### Implemented

```
quimby add <worker>                         Create a worker
quimby run <worker> [-c <cmd>]              Launch agent interactively (default: claude)
quimby list                                 Show workers, packs, and subscriptions
quimby status [worker]                      Show agent-written status
quimby assign <worker> -m "..." [-p <pack>] Push assignment (optionally with packs)
quimby diff <worker|pack> [worker2|pack2]   Show diff (live or frozen)
quimby pack <worker> [-n <name>]            Package worker's work into a pack
quimby apply <pack> [--commits|--patch]     Apply pack to host repo
quimby send <worker> <pack>                 Route pack to worker's inbox
quimby reset <worker>                       Nuclear reset worker to current HEAD
quimby rename <worker> <new-name>           Rename worker
quimby remove <worker>                      Remove worker (keeps packs)
quimby serve [-p <port>] [--poll <secs>]    Start the server
quimby subscribe <worker> <target>          Worker receives target's status
quimby unsubscribe <worker> <target>        Remove subscription
```

### Planned (not yet implemented)

```
quimby start <worker>                       Launch agent headless
quimby assign <worker> --status <worker>    Embed another worker's status in assignment
```

### Flag conventions

All flags support `-x` short and `--xxx` long forms:
- `-m` / `--message` (assign, pack)
- `-n` / `--name` (pack)
- `-p` / `--pack` (assign) or `--port` (serve)
- `-c` / `--cmd` (run)
- `-b` / `--branch` (apply)
- `-t` / `--target` (apply)
- `-d` / `--description` (pack)
- `--stat` (diff)
- `--commits`, `--patch` (apply)
- `--poll` (serve)

## No Config File (For Now)

Quimby works without a config file. `quimby add <name>` implicitly creates `.quimby/` and initializes the workspace. A `quimby.config.ts` with `defineWorkspace()` may be added in the future for declaring roles, routing rules, and runtime overrides — populated via `quimby up`.

## No Init Command

There is no `quimby init`. The first `quimby add` creates the workspace. The `.quimby/` directory is added to `.gitignore` automatically.

## Communication Model

Workers run in sandboxes and cannot see each other. All cross-worker communication is mediated by the host through two mechanisms:

### Manual (CLI)

`assign` is the universal instruction channel. It can carry packs:

```
quimby assign reviewer --pack builder-1 -m "Review this"
quimby assign builder --pack reviewer-1 -m "Address this feedback"
```

When `--pack` is used without `-m`, a default message is generated. Assignment messages can also be read from a file with `@file` syntax.

### Automatic (Server)

`quimby serve` polls worker directories and routes based on subscriptions:

```
quimby subscribe reviewer backend   # reviewer gets backend's status changes
```

When backend's `status.md` changes, the server pushes a snapshot to `reviewer/inbox/status/backend.md`. This happens continuously without user intervention.

Subscriptions are stored in `state.yaml` and can be added/removed whether or not the server is running. The server reloads state on each poll cycle.

## Server Architecture

The server (`quimby serve`) runs two components:

### HTTP API (localhost, default port 7749)

```
GET  /api/status                              Server health + overview
GET  /api/workers                             All workers with cached status
GET  /api/workers/:name                       Single worker detail
GET  /api/packs                               All packs
GET  /api/subscriptions                       All subscriptions
POST /api/subscriptions {subscriber, target}  Add subscription
DELETE /api/subscriptions/:subscriber/:target Remove subscription
```

### Status Poller (default 5s interval)

1. Check `state.yaml` mtime — reload if changed (picks up new workers/subscriptions)
2. For each worker, check `status.md` mtime
3. If changed, read content, update cache, route to subscribers
4. Route = write to `.quimby/workers/<subscriber>/inbox/status/<target>.md`

The server writes `.quimby/server.json` (pid, port, startedAt) on startup and removes it on shutdown. CLI commands use this file to detect a running server and display its status.

## Pack Lifecycle

1. Worker makes commits in its clone
2. `quimby pack <worker>` creates a pack: `git format-patch quimby/seed` + `git diff quimby/seed`
3. Pack is stored in `.quimby/packs/<name>/`
4. User reviews: `quimby diff <pack>`
5. User applies: `quimby apply <pack>` (squashed by default, `--commits` or `--patch` available)
6. Or routes to another worker: `quimby send <worker> <pack>` or `quimby assign <worker> -p <pack>`

## Reset

`quimby reset <worker>` is nuclear — deletes the worker's repo and re-clones from the source at current HEAD. Existing packs from this worker are preserved. Assignment and status are reset to empty/idle.

## diff Semantics

- `quimby diff <worker>` — live diff of worker's commits against seed (pack preview)
- `quimby diff <pack>` — frozen diff from pack's squashed.diff
- `quimby diff <a> <b>` — show both diffs side-by-side
- `--stat` — diffstat summary only

Workers and packs have distinct naming patterns (workers are bare names, packs are `worker-N` or custom), so ambiguity is unlikely. Workers are resolved first.

## Key Design Decisions

- **Flat pack namespace**: Packs are decoupled from workers. You can reset a worker and keep its packs.
- **Squashed apply by default**: Agent commit history is useful context but shouldn't leak into the real repo. The membrane ensures the user curates what enters.
- **Server is infrastructure, not convenience**: Workers in sandboxes can't see each other. The server is the only entity with cross-worker visibility. It's architecturally necessary, not a nice-to-have.
- **Three interaction modes coexist**: Interactive (run), headless (start), and server (serve) are separate concerns. run/start manage individual workers; serve manages the connections between them.
- **Remote config is per-machine, not per-repo**: Infrastructure details (IPs, SSH users) belong in local config, not in the repository. This is a future concern but shapes current architecture.
- **No artificial simplicity**: This is infrastructure for multi-agent orchestration. Networking, servers, persistent state, and subscription management are in scope.
