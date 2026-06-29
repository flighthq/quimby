# Quimby — Design

This is the authoritative design document.

## Overview

Quimby is a CLI tool for orchestrating multiple AI agents working on a single project. Each **agent** is an isolated environment — a local clone of the source repo inside a sandbox, where an AI tool (the agent's _entrypoint_) does the work. Agents can't see each other; Quimby is the **courier** that hand-carries work between them, and across the boundary into the user's real repository.

Named after Chief Quimby from Inspector Gadget — the user dispatches the work, agents deliver, and Quimby hand-delivers the briefings in between. The unit it carries is a **handoff**: a parcel of work moved from one place to another and then done with. Quimby is a courier, not a post office — it carries parcels, it does not run a mailroom. There is no standing archive of past work; durable history lives in git.

This is infrastructure for multi-agent orchestration, not a thin wrapper around scripts. Networking, a local server, persistent state, and subscription management are all in scope.

## Core Concepts

**Agent** — An isolated working environment. Each agent gets its own clone of the source repo, runs an AI tool (its _entrypoint_), can commit locally, and produces handoffs. Agents run inside sandboxes (Docker Sandbox, OpenShell, etc.) that prevent them from seeing each other — all cross-agent communication is mediated by the host. Agents can run locally or on a remote machine over SSH.

**Handoff** — A _parcel_ Quimby hand-carries from one agent to another (or out to the user's repo). It is always a folder with one uniform shape, and it carries whichever of these it has:

- a **note** — `README.md`, the human-readable message
- a **diff** — the agent's code as `squashed.diff` plus `commits/` patches
- any other **files** the sender chose to include

A `meta.yaml` manifest (sender, recipient, `createdAt`, code source) is written **last**, which signals the parcel is complete. A handoff with code and no note, a note and no code, or both, are all the same kind of thing — "pack vs instruction" is not a type distinction, just different contents. A handoff is named `<from>-<contentHash>` (a hash of its payload — diff plus note) — content-derived, so it needs no counter, dedupes identical sends, and reads back as "from whom, carrying what". The diff is also the wire format that lets work cross the boundary at all: an agent in a sandbox or over SSH is not a reachable git remote, so the host cannot `git fetch` it — Quimby carries the diff instead.

**Seed** — The `quimby/seed` git tag in each agent's repo marking the baseline. A handoff's diff is the agent's working tree (committed + uncommitted + untracked) against this tag.

**Boundary** — The boundary between the workspace (where agents work) and the user's real repository. Work only crosses the boundary through explicit user action (`quimby apply`), landing in git — the durable side of the boundary.

**Server** — The host-side process that enables cross-agent visibility. Agents in sandboxes are isolated from each other — the server is the only entity that can see all agents. It polls for status changes and routes updates to subscribing agents.

**Transport** — The abstraction layer over local filesystem vs SSH. `LocalTransport` operates on local paths; `SSHTransport` wraps all operations via `ssh` and `rsync`. Commands and core modules interact with agents through this abstraction without knowing where the agent lives.

## Three Modes of Agent Interaction

These are distinct concepts that coexist, not alternatives:

### 1. Interactive Agent (`quimby run`)

Takes over a terminal. The user is in a live CLI session with the agent (like running `claude` directly). This is the onramp and never goes away — sometimes you want to pair with the agent. For SSH agents, this attaches to (or creates) a named tmux session on the remote host. Implemented.

### 2. Headless Agent (`quimby start`)

Launches an agent in the background. The user interacts via `quimby assign`, reads results via `quimby status` and `quimby diff`. The agent runs to completion or waits for new assignments. Not yet implemented — depends on sandbox ecosystem support for headless operation.

### 3. Server (`quimby serve`)

The host-side process that enables everything requiring cross-agent visibility:

- Polls agent `status.md` files for changes (local and SSH agents)
- Routes status updates to subscribing agents' `inbox/status/` directories
- Exposes an HTTP API on localhost for status aggregation and subscription management

The server doesn't replace `run` or `start` — it enables the connections between agents that sandbox isolation otherwise prevents. Implemented.

```
quimby serve                        # start the server
quimby add backend                  # create an agent
quimby run backend                  # interactive session (server optional)
quimby subscribe reviewer backend   # reviewer gets backend's status
quimby assign backend -m "..."      # works with or without server
```

## Directory Layout

### Local Layout

An agent has two staging areas for parcels: an **outbox** (parcels it wants Quimby to carry, addressed by recipient) and an **inbox** (parcels delivered to it, named by sender + contents). Quimby picks up from the outbox and hand-delivers to the inbox.

```
my-project/
  .quimby/
    state.yaml              # workspace state (agents, subscriptions, stable IDs)
    server.json             # server pidfile (when running)
    staging/                # host loading dock: a parcel mid-apply (kept only on conflict)
    agents/
      backend/
        repo/               # cloned source tree, tagged quimby/seed
        assignment.md       # current task (set by `quimby assign`)
        status.md           # agent-written status (mirrored to subscribers)
        CLAUDE.md           # generated agent instructions
        outbox/             # parcels staged for pickup, addressed by recipient
          reviewer/         # a parcel bound for the `reviewer` agent
            README.md       #   the note (optional; may carry `attach:` in frontmatter)
            ...             #   any extra files (optional)
          .sent/            # delivery receipts — parcels already carried (the progress ledger)
            reviewer/
        inbox/
          frontend-a1b2c3d4/   # a parcel delivered from `frontend`
            meta.yaml          #   manifest: from, to, createdAt, codeSource — written LAST
            README.md          #   the note (optional)
            squashed.diff      #   the diff (optional)
            commits/           #   the diff as patches (optional)
          status/              # live status mirrors from subscribed agents
            frontend.md
          .done/               # parcels this agent has processed
      frontend/
        ...
  src/
  package.json
  ...
```

Two naming schemes, deliberately, because the two staging areas answer different questions:

- The **outbox** is addressed by recipient (`outbox/<recipient>/`) — when authoring, the question is "who is this for".
- The **inbox** is named by origin + contents (`inbox/<from>-<hash>/`) — when receiving, the question is "what did I get, and from whom".

`status/` is **not** a parcel — it is a live mirror the server overwrites each poll, pulled by subscribers. Parcels are immutable, discrete deliveries; status is a continuously-updated reflection. They stay separate.

### Remote Layout (SSH Agents)

SSH agents use a stable project ID to namespace the remote layout. The project ID is a UUID stored in `state.yaml` and never changes.

```
~/.quimby/workspaces/<projectId>/       # remote project root (rsync target)
  src/                                  # project source files (rsynced from host)
  package.json
  .quimby/
    agents/
      backend/
        repo/               # cloned from the rsynced project root
        assignment.md
        status.md
        CLAUDE.md
        outbox/             # picked up and carried back to the host by Quimby
        inbox/              # parcels delivered here over transport
          status/
```

## SSH Agents

SSH agents allow an agent to run on a remote machine, with the source repo synced via rsync.

### Adding an SSH agent

```
quimby add researcher --host user@gpu-box
quimby add researcher --host user@gpu-box:/custom/base/path
quimby add researcher --host user@gpu-box --port 2222
```

The agent is recorded in `state.yaml` immediately. No SSH connection is made at `add` time — the remote environment is initialized lazily on first `quimby run`.

### Running an SSH agent

```
quimby run researcher
```

1. Rsyncs the local project to `~/.quimby/workspaces/<projectId>/` on the remote
2. If first run: clones the rsynced source, tags `quimby/seed`, writes scaffolding files
3. Attaches to (or creates) a tmux session named `qb-<projectId[:8]>-<agentId[:8]>`
4. The agent runs in the agent directory (parent of `repo/`) on the remote

The tmux session name is stable across renames because it is based on the agent's UUID, not its name.

### Explicit sync

```
quimby sync researcher    # rsync the project to the remote and bring the agent onto its base
```

For an SSH agent, `sync` rsyncs the project to the remote before fast-forwarding — useful to pre-stage the project (and push local commits) without launching the agent. See [Sync Targets](#sync-targets) for the full behavior (`-f`, `--base`, `--all`).

### Updating SSH config

```
quimby set researcher --host user@new-box
quimby set researcher --port 2222
quimby set researcher --host user@box:/different/path
```

### Removing an unreachable SSH agent

```
quimby remove researcher --force
```

`--force` skips the remote `rm -rf` and removes only the local state entry. Use this when the SSH host is unreachable and you want to clean up state.

## CLI Surface

All commands follow `verb target [qualifiers]`. The first positional is the target — almost always an agent. Work moves along a few axes:

- **sideways**, agent → agent (direct), or host → agent: `handoff`
- **outbox routing**, an agent's authored queue → its recipients: `dispatch`
- **out**, agent → your repo (across the boundary): `apply`
- **in**, you → an agent's task: `assign`

```
quimby add <agent> [-H <host>] [--port <n>] [-s <ref>]   Create an agent; flag-less runs the interactive walkthrough (flags skip it, staying scriptable)
quimby config <agent>                                Interactively (re)configure an agent (runtime, entrypoint, local/remote, tmux, sync)
quimby run <agent> [-c <cmd>] [-r <runtime>]        Launch the agent interactively (default entrypoint: claude; local tmux agents attach to a named session)
quimby set <agent> [-r <rt>] [-c <cmd>] [-H <host>] [--port <n>] [-s <ref>]   Update agent config
quimby help [command]                                 Root help (grouped, with banner) or usage for a single command
quimby list                                           Show agents and subscriptions
quimby status [agent]                                Show agent-written status
quimby assign <agent> -m "..." | @file               Set an agent's current task (writes assignment.md)
quimby diff <agent> [agent2]                         Show an agent's live diff against its seed
quimby handoff <from> <to> | <to> [-m "..."] [--attach <w>]   Carry <from>'s work to <to>; with one arg, the host's work → that agent
quimby dispatch <agent>                              Deliver the agent's queued outbox parcels to their recipients
quimby apply <agent> [--commits|--patch] [--3way] [-b] [-t]   Apply the agent's work to your repo (the boundary)
quimby sync <agent...> [--all] [-f] [--base <ref>]   Sync agent(s) to their base, keeping work (-f hard-resets; --base retargets)
quimby rebuild <agent> --force                       Recreate an agent from current source (discards its work and mailbox)
quimby rename <agent> <new-name>                     Rename agent
quimby remove <agent> [--force]                      Remove agent (--force: skip remote cleanup)
quimby serve [-p <port>] [--poll <secs>]              Start the server
quimby subscribe <agent> <target>                    Agent receives target's status
quimby unsubscribe <agent> <target>                  Remove subscription
```

### Planned (not yet implemented)

```
quimby start <agent>                       Launch agent headless
quimby assign <agent> --status <agent>    Embed another agent's status in assignment
```

#### Deferred: a verification guard

An earlier version let each agent carry a `guard` command (e.g. `npm run ci`) that quimby ran before `handoff`/`apply`. It was **removed** because it could not be made honest: quimby is a host-side courier that runs _outside_ the agent's sandbox, while the agent installs its dependencies _inside_ it. So the guard ran in the wrong environment every time — wrong architecture, wrong permissions, missing version-manager PATH — failing on the environment rather than the work. Moving it host-side doesn't help either: the host has no copy of the agent's deps (and a worktree sharing the host's `node_modules` breaks the moment the agent adds a dependency), so the only correct host-side check is a full clean install per apply.

The only place a build is verifiable is where the deps were installed — inside the agent's sandbox. So a guard can return **only** once runtimes expose **headless command execution in the sandbox** (`RuntimeAdapter.execSpec`), letting quimby run the check in the agent's own environment, or once agents **attest** their own result (write the outcome into the parcel `meta.yaml`) for quimby to display rather than re-run. Until then there is no guard: `apply` lands work on a branch (the real boundary) and the user verifies in their normal dev loop, where a dependency change is just a natural `npm install`.

### Flag conventions

All flags support `-x` short and `--xxx` long forms:

- `-m` / `--message` (assign, handoff)
- `--attach` (handoff — carry a different agent's diff than the source)
- `-p` / `--port` (serve, add, set)
- `-c` / `--cmd` (run, set, add — the agent's entrypoint command)
- `-r` / `--runtime` (run, set)
- `-H` / `--host` (add, set)
- `-b` / `--branch` (apply)
- `-t` / `--target` (apply)
- `-s` / `--sync` (add, set)
- `-f` / `--force` (sync — hard reset; rebuild, remove — confirm)
- `--stat` (diff)
- `--commits`, `--patch`, `--3way` (apply)
- `--rebase` (handoff, dispatch, apply)
- `--poll` (serve)

## No Config File (For Now)

Quimby works without a config file. `quimby add <name>` implicitly creates `.quimby/` and initializes the workspace. A `quimby.config.ts` with `defineWorkspace()` may be added in the future for declaring roles, routing rules, and runtime overrides — populated via `quimby up`.

### Configuration is per-agent

There are deliberately **no workspace-level defaults**. An agent's configuration (runtime, entrypoint, location, tmux, sync ref) lives only on that agent's entry in `state.yaml` — a single source of truth, avoiding a second "defaults vs per-agent" config to reconcile.

`quimby config <agent>` is an interactive walkthrough (arrow-key selects via `@clack/prompts`) over exactly those fields — effectively an interactive `set`. A flag-less `quimby add <agent>` runs the same walkthrough to configure the new agent; passing config flags skips the prompts so `add` stays scriptable for unattended use. See build-and-tooling.md for the implementation.

## No Init Command

There is no `quimby init`. The first `quimby add` creates the workspace. The `.quimby/` directory is added to `.gitignore` automatically.

## Communication Model

Agents run in sandboxes and cannot see each other. All cross-agent communication is mediated by the host through two mechanisms:

### Manual (Quimby as courier)

`handoff` is the direct courier channel — Quimby picks up a parcel from one agent and hand-delivers it to another's inbox. A parcel carries whichever halves exist: the sender's diff, a note, or both.

```
quimby handoff builder review -m "review this"   # builder's code (+ note) → review's inbox
quimby handoff review builder -m "fix the null case in Y"   # review's note → builder's inbox
quimby handoff review -m "look at my local tweak"   # the HOST's work → review's inbox (sender "host")
```

The recipient is the **last** positional; a leading positional overrides the default source (the host). So `handoff A B` is A → B and `handoff B` is host → B — `git`-style `.`/path sources are deliberately avoided, so a source is always either a known agent or the host (no `handoff ../random/path B` to leave unfulfillable). The diff comes from the source (or `--attach <other>`); the note comes from `-m`. A handoff **delivers to the inbox** — it never overwrites the recipient's `assignment.md`. Setting an agent's standing task is `assign`'s job; a handoff is a delivery to consider, not a new marching order.

For agent-authored routing, `quimby dispatch <agent>` enacts that agent's outbox — Quimby carries every queued parcel to its addressee in one run. This is how a reviewer routes work without the human relaying it: review fills its outbox with "fix Y" → builder and "promote this" (with `attach: builder`) → integration, and one `quimby dispatch review` delivers the lot. `handoff` is the immediate, human-driven move; `dispatch` enacts the queue — separate verbs because the outbox is a distinct mechanism.

### Automatic (Server)

`quimby serve` polls agent directories and routes based on subscriptions:

```
quimby subscribe reviewer backend   # reviewer gets backend's status changes
```

When backend's `status.md` changes, the server pushes a snapshot to `reviewer/inbox/status/backend.md`. For SSH agents, the server writes to the remote inbox via transport. This happens continuously without user intervention.

Subscriptions are the "to whom it may concern" channel: an agent publishes status, and anyone who subscribed pulls it. The discernment is the subscription, set once — so broadcasts don't pile copies into every inbox or make every agent read-and-filter. Subscriptions are stored in `state.yaml` and can be added/removed whether or not the server is running. The server reloads state on each poll cycle.

## Server Architecture

The server (`quimby serve`) runs two components:

### HTTP API (localhost, default port 7749)

```
GET  /api/status                              Server health + overview
GET  /api/agents                             All agents with cached status
GET  /api/agents/:name                       Single agent detail
GET  /api/subscriptions                       All subscriptions
POST /api/subscriptions {subscriber, target}  Add subscription
DELETE /api/subscriptions/:subscriber/:target Remove subscription
```

### Status Poller (default 5s interval)

1. Check `state.yaml` mtime — reload if changed (picks up new agents/subscriptions)
2. For each agent, check `status.md` (local: mtime; SSH: content comparison)
3. If changed, read content, update cache, route to subscribers
4. Route = write to subscriber's `inbox/status/<target>.md` (local or remote)

The server writes `.quimby/server.json` (pid, port, startedAt) on startup and removes it on shutdown. CLI commands use this file to detect a running server and display its status.

## Handoff Lifecycle

A handoff is assembled on demand and carried; it is not deposited in any archive. The lifecycle is non-destructive — nothing an agent authored is lost to a failed delivery.

**Direct carry (`quimby handoff`).** Quimby:

1. Resolves the diff. For `handoff A B`, that is A's working tree (committed + uncommitted + untracked) against `quimby/seed` — captured commit-free — or the `--attach` source's, with an optional `--rebase` (sync) first. For `handoff B` (host source), it is the host working tree vs B's seed, squashed. Sender name is the reserved `host`.
2. Validates the recipient against the agent roster. An unknown recipient (a typo) is reported and nothing is carried — it bounces, never silently dropped.
3. Assembles the parcel — note, diff — writes `meta.yaml` **last**, delivers it to `<to>/inbox/<from>-<hash>/` (local copy or rsync), then discards the staging copy.

**Outbox routing (`quimby dispatch <agent>`).** Agent-authored routing rather than an immediate human move:

- **Authoring (the agent).** Inside its sandbox an agent stages parcels in its outbox, addressed by recipient: `outbox/<recipient>/README.md` (the note) plus any files. Frontmatter `attach: <agent>` carries that agent's diff instead of the sender's own. The agent decides the routing; the host enacts it.
- **Enacting.** `dispatch` carries every queued parcel to its addressee. An unknown recipient is **left in the outbox to fix** (bounce). On success the draft is **moved** to `outbox/.sent/<recipient>/` (timestamped) — the progress ledger: active `outbox/*` = queued, `.sent/*` = carried and when. A failed carry leaves the draft active for a clean retry.

**Consumption (the recipient).** Parcels sit in `inbox/` until the agent processes them and moves them to `inbox/.done/`. Identity is content-derived, so a re-carried identical parcel overwrites in place rather than piling up.

**Garbage collection.** `.sent/` and `.done/` are caches, not the hot path — bounded by agent lifetime (everything dies with the agent) and pruned by an explicit step (a cleanup, or folded into `sync`/`rebuild`). GC is archiving-then-pruning, never silent deletion on carry.

## Apply (crossing the boundary)

`quimby apply <agent>` is the one verb that moves work **out** to the user's real repository. It assembles the agent's working-tree parcel in the host loading dock (`.quimby/staging/`), applies it to the target repo, and discards the staging copy on success. The agent is never committed to in the process — capture is commit-free; the commit (if any) happens here, at the boundary.

- **Squashed by default** — one commit, message auto-filled from the parcel (`-m` overrides; it never prompts). `--patch` leaves the changes in your working tree uncommitted (curate your own commits). `--commits` replays the agent's individual commits and then applies any uncommitted remainder on top. `--3way` merges (leaving conflict markers) instead of aborting.
- `-b` lands it on a fresh branch; `-t` targets a repo path other than the cwd.
- On conflict the staged parcel is **kept** and its path reported, so the apply can be finished by hand.

Persisting an agent's work is git's job, reached through apply: `quimby apply <agent> -b feature/x` lands it on a branch you keep. There is no separate "save this work" store.

## Sync Targets

An agent is a _synchronization relationship_, not a checkout. It records two things:

- **`seedCommit`** (mirrored by the `quimby/seed` tag) — the base the agent's work is measured from. A handoff's diff is the agent's working tree against this tag.
- **`syncRef`** — the ref the agent synchronizes against (e.g. `main`, `refs/heads/release`). Defaults to the host branch at `quimby add` time; an explicit `--sync` wins.

`quimby sync <agent>` resolves `syncRef`'s tip _in the host repo_ (not the host's live `HEAD`, so syncing is deterministic) and brings the agent onto it, with three behaviors:

- **default (safe)** — auto-stash the agent's uncommitted + untracked work, rebase its commits onto the new base, retag `quimby/seed`, then restore the stash. The agent's work is kept. A rebase or restore conflict aborts and reports, leaving the work intact.
- **`-f` (hard)** — `reset --hard` to the base, discarding the agent's commits and working changes — but its **mailbox** (inbox/outbox/assignment/status) is untouched. For "my work shipped; snap me to the latest and keep me in the conversation."
- **`--base <ref>`** — retarget `syncRef` to `<ref>` (persisted), then sync onto it. The way to move an agent to a different branch. (`set --sync` records the ref without syncing.)

`--all` syncs every agent, skipping any with conflicts. Agents created before sync targets existed are migrated on state load: a missing `syncRef` is backfilled from the workspace `sourceRef`. The apply target is independent of `syncRef` — `quimby apply <agent> -t <branch>` lands work wherever you choose.

## Rebuild

`quimby rebuild <agent> --force` recreates the agent: it deletes the agent's repo, re-clones from the current source, **clears its mailbox** (inbox/outbox), and resets assignment/status to empty/idle. `--force` is required. This is for "this agent is done or broken — start a blank one." When you only want to reset the _code_ but keep the agent in the conversation, `sync -f` is the gentler tool (it leaves the mailbox alone).

For SSH agents, rebuild rsyncs the latest source to the remote, deletes and re-clones the remote repo, retags `quimby/seed`, and clears the remote mailbox.

## diff Semantics

- `quimby diff <agent>` — live diff of the agent's commits against its seed (a preview of what a handoff or apply would carry)
- `quimby diff <a> <b>` — show two agents' diffs side-by-side
- `--stat` — diffstat summary only

Diff operates on agents only. Handoffs are carried, not stored, so there is nothing frozen to diff — preview the live agent instead.

## Key Design Decisions

- **Quimby is a courier, not a post office**: It hand-carries parcels between agents and across the boundary; it does not run a mailroom. There is no standing archive of past work — a handoff is assembled, carried, and dropped. This deletes a whole class of maintenance overhead: no sequence counter, no orphaned artifacts outliving removed agents, no unbounded store to curate. Durable history is git's job.
- **A handoff is one shape, carrying whichever halves exist**: Always a folder — note and/or diff and/or files, with a `meta.yaml` written last as the completion signal. "Pack vs instruction" is not a type distinction, just different contents, so there is one object and one set of verbs to learn.
- **Content-derived names, time in the manifest**: A parcel is `<from>-<contentHash>` — no counter, dedupes identical carries, self-describing. `createdAt` lives in `meta.yaml`, not the name, so identical re-sends stay idempotent instead of piling up; chronology comes from the manifest and the `.sent/` ledger.
- **Addressed outbox, content-named inbox**: The two staging areas answer different questions — "who is this for" when authoring, "what did I get and from whom" when receiving — so they name parcels differently on purpose.
- **Non-destructive delivery**: Carry drains a draft only on success, and to a `.sent/` receipt rather than a delete; a bad address bounces and stays put. An agent never has to rewrite a parcel because a delivery failed.
- **A verb per movement**: `handoff` moves sideways (agent → agent, or host → agent), `dispatch` enacts an agent's outbox queue, `apply` moves out (across the boundary), `assign` sets an agent's task. Handoffs land in the inbox and never clobber `assignment.md`. `handoff` and `dispatch` are separate verbs because the outbox is a distinct mechanism, and because keeping the host the only non-agent source avoids unfulfillable path sources.
- **Directed handoff vs broadcast**: Directed work uses `handoff` (addressed, validated); "to whom it may concern" uses `status` + `subscribe` (pull, set once). Broadcast is deliberately not a handoff mode — it would copy into every inbox and make every agent filter, the token cost we are avoiding.
- **The diff is the wire format across the boundary**: A sandboxed/SSH agent is not a reachable git remote, so the host cannot `git fetch` it. Carrying the diff is what makes cross-agent and agent→host movement possible at all.
- **Squashed apply by default**: Agent commit history is useful context but shouldn't leak into the real repo. The boundary ensures the user curates what enters.
- **Server is infrastructure, not convenience**: Agents in sandboxes can't see each other. The server is the only entity with cross-agent visibility. It's architecturally necessary, not a nice-to-have.
- **Three interaction modes coexist**: Interactive (run), headless (start), and server (serve) are separate concerns. run/start manage individual agents; serve manages the connections between them.
- **Stable IDs, not names**: `QuimbyState.id` and `AgentState.id` are UUIDs generated at creation and never change. tmux session names are derived from IDs, so renaming an agent doesn't orphan a running session.
- **SSH lazy init**: SSH agents are not set up remotely at `quimby add` time. The remote clone, tagging, and scaffolding happen on first `quimby run`. This allows adding SSH agents without an active SSH connection.
- **rsync as transport**: SSH agents sync the project source via rsync before each run. The remote clone is a local clone of the rsynced source tree — no direct git remote needed on the agent side.
- **tmux for SSH persistence**: SSH agents run in named tmux sessions. Disconnecting from a session doesn't kill the agent. `quimby run` reattaches to an existing session if one exists. Local agents can opt into the same behavior via the `tmux` field on `AgentState` — `quimby run` then wraps the local agent in `tmux new-session -A` against the stable-ID session name.
- **Transport abstraction**: All agent I/O goes through `LocalTransport` or `SSHTransport`. Commands don't need to know where an agent lives — they call `transport.exec`, `transport.writeFile`, `transport.rsyncTo`, etc.
- **Transport never commits**: Work is captured from the agent's working tree (committed + uncommitted + untracked) via a throwaway index, so `handoff`/`dispatch`/`sync` never make a commit in an agent — frequent use never litters its history, and agents needn't use git at all. The only commit is the optional one at `apply`, the boundary.
- **Three levels of "catch up"**: `sync` keeps the agent's work (rebases it); `sync -f` drops the work but keeps the agent (mailbox intact); `rebuild --force` recreates the agent (mailbox cleared). `sync -f` resets the code; `rebuild` resets the agent. Destructive levels require an explicit flag.
- **remove --force for unreachable hosts**: When an SSH host is gone, `quimby remove --force` removes the local state entry without attempting remote cleanup.
- **No artificial simplicity**: This is infrastructure for multi-agent orchestration. Networking, servers, persistent state, SSH transport, and subscription management are all in scope.
