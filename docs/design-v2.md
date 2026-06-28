# Quimby — Design (v2)

This is the authoritative design document.

## Overview

Quimby is a CLI tool for orchestrating multiple AI agents working on a single project. Each agent operates in an isolated **worker** — a local clone of the source repo inside a sandbox. Workers produce **packs** (packaged units of work) that can be reviewed, routed to other workers, or applied to the user's real repository.

Named after Chief Quimby from Inspector Gadget — the user assigns work, agents deliver packages.

This is infrastructure for multi-agent orchestration, not a thin wrapper around scripts. Networking, a local server, persistent state, and subscription management are all in scope.

## Core Concepts

**Worker** — An isolated agent environment. Each worker gets its own clone of the source repo, can commit locally, and produces packs. Workers are ephemeral; packs are permanent. Workers run inside sandboxes (Docker Sandbox, OpenShell, etc.) that prevent them from seeing each other — all cross-worker communication is mediated by the host. Workers can run locally or on a remote machine over SSH.

**Pack** — A packaged unit of work output from a worker. Contains a squashed diff, individual commit patches, and metadata. Packs live in a flat namespace (not nested under workers) and survive worker resets/removal.

**Seed** — The `quimby/seed` git tag in each worker's repo marking the baseline. All pack diffs are computed against this tag.

**Membrane** — The boundary between the workspace (where agents work) and the user's real repository. Work only crosses the membrane through explicit user action (`quimby apply`).

**Server** — The host-side process that enables cross-worker visibility. Workers in sandboxes are isolated from each other — the server is the only entity that can see all workers. It polls for status changes and routes updates to subscribing workers.

**Transport** — The abstraction layer over local filesystem vs SSH. `LocalTransport` operates on local paths; `SSHTransport` wraps all operations via `ssh` and `rsync`. Commands and core modules interact with workers through this abstraction without knowing where the worker lives.

## Three Modes of Worker Interaction

These are distinct concepts that coexist, not alternatives:

### 1. Interactive Worker (`quimby run`)

Takes over a terminal. The user is in a live CLI session with the agent (like running `claude` directly). This is the onramp and never goes away — sometimes you want to pair with the agent. For SSH workers, this attaches to (or creates) a named tmux session on the remote host. Implemented.

### 2. Headless Worker (`quimby start`)

Launches an agent in the background. The user interacts via `quimby assign`, reads results via `quimby status` and `quimby diff`. The agent runs to completion or waits for new assignments. Not yet implemented — depends on sandbox ecosystem support for headless operation.

### 3. Server (`quimby serve`)

The host-side process that enables everything requiring cross-worker visibility:

- Polls worker `status.md` files for changes (local and SSH workers)
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

### Local Layout

```
my-project/
  .quimby/
    state.yaml              # workspace state (workers, subscriptions, stable IDs)
    server.json             # server pidfile (when running)
    workers/
      backend/
        repo/               # cloned source tree, tagged quimby/seed
        assignment.md       # current task
        status.md           # agent-written status
        CLAUDE.md           # generated agent instructions
        inbox/
          packs/            # packs routed to this worker
            pack-name/      # a routed pack
          status/           # status updates from subscribed workers
            frontend.md     # latest status from frontend worker
      frontend/
        ...
    packs/
      backend-1/
        meta.yaml           # name, worker, description, commits
        squashed.diff       # combined diff against seed
        commits/            # individual .patch files
      auth-refactor/        # explicitly named pack
        ...
  src/
  package.json
  ...
```

### Remote Layout (SSH Workers)

SSH workers use a stable project ID to namespace the remote layout. The project ID is a UUID stored in `state.yaml` and never changes.

```
~/.quimby/workspaces/<projectId>/       # remote project root (rsync target)
  src/                                  # project source files (rsynced from host)
  package.json
  .quimby/
    workers/
      backend/
        repo/               # cloned from the rsynced project root
        assignment.md
        status.md
        CLAUDE.md
        inbox/
          packs/
          status/
    packs/                  # packs created on remote (also copied back locally)
```

Packs are flat — no hierarchy, no slashes. Auto-named `<worker>-<N>` or explicitly named via `--name`.

## SSH Workers

SSH workers allow an agent to run on a remote machine, with the source repo synced via rsync.

### Adding an SSH worker

```
quimby add researcher --host user@gpu-box
quimby add researcher --host user@gpu-box:/custom/base/path
quimby add researcher --host user@gpu-box --port 2222
```

The worker is recorded in `state.yaml` immediately. No SSH connection is made at `add` time — the remote environment is initialized lazily on first `quimby run`.

### Running an SSH worker

```
quimby run researcher
```

1. Rsyncs the local project to `~/.quimby/workspaces/<projectId>/` on the remote
2. If first run: clones the rsynced source, tags `quimby/seed`, writes scaffolding files
3. Attaches to (or creates) a tmux session named `qb-<projectId[:8]>-<workerId[:8]>`
4. The agent runs in the worker directory (parent of `repo/`) on the remote

The tmux session name is stable across renames because it is based on the worker's UUID, not its name.

### Explicit sync

```
quimby sync researcher    # rsync project to remote without launching the agent
```

Useful to pre-stage the project before a run, or to push local commits without starting a session.

### Updating SSH config

```
quimby set researcher --host user@new-box
quimby set researcher --port 2222
quimby set researcher --host user@box:/different/path
```

### Removing an unreachable SSH worker

```
quimby remove researcher --force
```

`--force` skips the remote `rm -rf` and removes only the local state entry. Use this when the SSH host is unreachable and you want to clean up state.

## CLI Surface

All commands follow `verb target [qualifiers]`. First positional is always the target (worker or pack).

### Implemented

```
quimby add <worker> [-H <host>] [--port <n>]        Create a worker (--host for SSH)
quimby run <worker> [-a <agent>] [-r <runtime>]     Launch agent interactively (default: claude)
quimby sync <worker>                                 Rsync project to SSH worker host
quimby set <worker> [-r <rt>] [-a <agent>] [-H <host>] [--port <n>]  Update worker config
quimby list                                          Show workers, packs, and subscriptions
quimby status [worker]                               Show agent-written status
quimby assign <worker> -m "..." [-p <pack>]          Push assignment (optionally with packs)
quimby diff <worker|pack> [worker2|pack2]            Show diff (live or frozen)
quimby pack <worker> [-n <name>]                     Package worker's work into a pack
quimby apply <pack> [--commits|--patch]              Apply pack to host repo
quimby send <worker> <pack>                          Route pack to worker's inbox
quimby reset <worker> --force                        Nuclear reset worker to current HEAD
quimby rename <worker> <new-name>                    Rename worker
quimby remove <worker> [--force]                     Remove worker (--force: skip remote cleanup)
quimby serve [-p <port>] [--poll <secs>]             Start the server
quimby subscribe <worker> <target>                   Worker receives target's status
quimby unsubscribe <worker> <target>                 Remove subscription
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
- `-p` / `--pack` (assign) or `--port` (serve, add, set)
- `-a` / `--agent` (run, set)
- `-r` / `--runtime` (run, set)
- `-H` / `--host` (add, set)
- `-b` / `--branch` (apply)
- `-t` / `--target` (apply)
- `-d` / `--description` (pack)
- `-f` / `--force` (reset, remove)
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

When backend's `status.md` changes, the server pushes a snapshot to `reviewer/inbox/status/backend.md`. For SSH workers, the server writes to the remote inbox via transport. This happens continuously without user intervention.

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
2. For each worker, check `status.md` (local: mtime; SSH: content comparison)
3. If changed, read content, update cache, route to subscribers
4. Route = write to subscriber's `inbox/status/<target>.md` (local or remote)

The server writes `.quimby/server.json` (pid, port, startedAt) on startup and removes it on shutdown. CLI commands use this file to detect a running server and display its status.

## Pack Lifecycle

1. Worker makes commits in its clone
2. `quimby pack <worker>` creates a pack: `git format-patch quimby/seed` + `git diff quimby/seed`
   - For SSH workers: runs on remote, patches rsync'd back, pack also pushed to remote packs dir
3. Pack is stored in `.quimby/packs/<name>/`
4. User reviews: `quimby diff <pack>`
5. User applies: `quimby apply <pack>` (squashed by default, `--commits` or `--patch` available)
6. Or routes to another worker: `quimby send <worker> <pack>` or `quimby assign <worker> -p <pack>`

## Reset

`quimby reset <worker> --force` is nuclear — deletes the worker's repo and re-clones from the source at current HEAD. `--force` is required to prevent accidental data loss. Existing packs from this worker are preserved. Assignment and status are reset to empty/idle.

For SSH workers, reset: rsyncs the latest source to the remote, deletes and re-clones the remote repo, retags `quimby/seed`.

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
- **Stable IDs, not names**: `QuimbyState.id` and `WorkerState.id` are UUIDs generated at creation and never change. tmux session names are derived from IDs, so renaming a worker doesn't orphan a running session.
- **SSH lazy init**: SSH workers are not set up remotely at `quimby add` time. The remote clone, tagging, and scaffolding happen on first `quimby run`. This allows adding SSH workers without an active SSH connection.
- **rsync as transport**: SSH workers sync the project source via rsync before each run. The remote clone is a local clone of the rsynced source tree — no direct git remote needed on the agent side.
- **tmux for SSH persistence**: SSH workers run in named tmux sessions. Disconnecting from a session doesn't kill the agent. `quimby run` reattaches to an existing session if one exists.
- **Transport abstraction**: All worker I/O goes through `LocalTransport` or `SSHTransport`. Commands don't need to know where a worker lives — they call `transport.exec`, `transport.writeFile`, `transport.rsyncTo`, etc.
- **reset requires --force**: Nuclear operations require explicit opt-in. `quimby reset` without `--force` warns and exits.
- **remove --force for unreachable hosts**: When an SSH host is gone, `quimby remove --force` removes the local state entry without attempting remote cleanup.
- **No artificial simplicity**: This is infrastructure for multi-agent orchestration. Networking, servers, persistent state, SSH transport, and subscription management are all in scope.
