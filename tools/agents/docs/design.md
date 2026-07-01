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
quimby assign <agent> -m "..." | @file [--no-sync] [--no-nudge] [-c]  Set an agent's current task; syncs the agent to its base first (--no-sync to skip), then writes assignment.md and wakes a running agent via its tmux session (--no-nudge to skip); -c/--clear types /clear before the nudge
quimby diff <agent> [agent2]                         Show an agent's live diff against its seed
quimby nudge <agent> [-m "..."] [-c] | --all [-m "..."] [-c]   Wake a running agent by typing a message (default "continue") into its tmux session; -c/--clear types /clear first to reset context; --all broadcasts to every agent with a live tmux session (probed); -m also carries CLI control commands ("/clear", "/model …")
quimby handoff <from> <to> | <to> [-m "..."] [--attach <w>] [--nudge|--no-nudge] [-c]   Carry <from>'s work to <to>; with one arg, the host's work → that agent (nudges the recipient by default only when a note is present); -c/--clear types /clear before the nudge
quimby dispatch <agent> | --all [--no-nudge]         Deliver the agent's queued outbox parcels to their recipients (--all dispatches every outbox; wakes each running recipient via its tmux session by default)
quimby apply <agent> [--commits|--patch] [--3way] [-b] [-t]   Apply the agent's work to your repo (the boundary)
quimby sync <agent...> [--all] [-f] [--base <ref>] [--current]   Sync agent(s) to their base, keeping work (-f hard-resets; --base/--current retarget)
quimby rebuild <agent> --force                       Recreate an agent from current source (discards its work and mailbox)
quimby rename <agent> <new-name>                     Rename agent
quimby remove <agent> [--force]                      Remove agent (--force: skip remote cleanup)
quimby serve [-p <port>] [--poll <secs>] [-it] [--no-dispatch]   Start the server (status routing + outbox auto-dispatch); -it stacks a live shell on top
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
- `-m` / `--message` (nudge — the text to type; defaults to `"continue"`)
- `--all` (sync — every agent; dispatch — every outbox; nudge — every live tmux session)
- `--sync` / `--no-sync` (assign — sync the agent to its base before assigning, on by default)
- `--nudge` / `--no-nudge` (assign, dispatch — wake a running recipient via its tmux session, on by default; handoff — same, but auto-decided by note presence unless forced)
- `-c` / `--clear` (assign, nudge, handoff — type `/clear` into the recipient's session before the nudge, resetting its context)
- `--attach` (handoff — carry a different agent's diff than the source)
- `-p` / `--port` (serve, add, set)
- `-c` / `--cmd` (run, set, add — the agent's entrypoint command)
- `-r` / `--runtime` (run, set)
- `-H` / `--host` (add, set)
- `-b` / `--branch` (apply)
- `-t` / `--target` (apply)
- `-s` / `--sync` (add, set)
- `--base` / `--current` (sync — retarget the sync ref; `--current` uses the host's current branch)
- `-f` / `--force` (sync — hard reset; rebuild, remove — confirm)
- `--stat` (diff)
- `--commits`, `--patch` (apply)
- `--3way` (apply — accepted for compatibility; the merge-based flow is inherently 3-way)
- `--rebase` (handoff, dispatch, apply)
- `--poll` (serve)
- `-i` / `--interactive`, `-t` / `--tty` (serve — stack a live shell on top; `-it` reads like `docker run -it`)
- `--dispatch` / `--no-dispatch` (serve — auto-carry settled outbox drafts, on by default)

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

The server also **auto-dispatches outboxes**: on the same poll cycle it scans each agent's outbox and carries any _settled_ draft to its recipient — the automatic twin of `quimby dispatch`, so a reviewer's authored parcel is enacted without a human relaying it. A draft is dispatched only once its newest file has been unchanged for a full poll cycle; that debounce is the completion signal, keeping the server from carrying a half-written parcel while the agent is still authoring it (no `.ready` marker or agent cooperation required). Each exact draft version is attempted at most once, so a bounced (unknown recipient) or failed carry never retries in a loop, and a re-authored draft (new mtime) is treated as fresh. A running recipient is nudged, exactly as with manual dispatch. This is **additive to** subscriptions, not a replacement: dispatch carries directed, discrete parcels; subscriptions mirror ambient status. Auto-dispatch is on by default; `quimby serve --no-dispatch` disables it, leaving only status routing.

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
5. Scan each agent's outbox; auto-dispatch any draft whose newest mtime was unchanged since the previous cycle (settled), then nudge the recipient — skipped entirely under `--no-dispatch`

The server writes `.quimby/server.json` (pid, port, startedAt) on startup and removes it on shutdown. CLI commands use this file to detect a running server and display its status.

### Interactive mode (`serve -it`)

`quimby serve -it` (or `--interactive`) starts the server and then stacks a shell on top of it, so `quimby` (and any other) commands run live against the server underneath — one terminal instead of two. The shell owns the terminal, so its own Ctrl+C just interrupts the current command; `exit`/Ctrl+D — or a quick double Ctrl+C — stops the server and quits. (A single Ctrl+C deliberately does _not_ tear the server down, so interrupting a command is never fatal.) The `-it` spelling reads like `docker run -it`.

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

`quimby apply <agent>` is the one verb that moves work **out** to the user's real repository. It uses a **merge-based** strategy: the agent's diff is reconstructed on a temporary branch rooted at the agent's seed commit (where it applies cleanly by definition), then merged into the target. The agent is never committed to in the process — capture is commit-free; the commit (if any) happens here, at the boundary.

### Merge-based strategy

The agent's diff was generated against its seed. Applying it directly to a target repo that has moved past the seed fails — context lines don't match, `git apply` aborts, and the user faces a conflict they can't interpret (is it real overlap, or just a stale diff?). The merge-based flow solves this:

1. Stage the parcel in `.quimby/staging/` (diff + patches + meta, same as before)
2. Create a temp branch (`quimby/apply-<agent>-<seed>`) from the seed commit in the target repo
3. Apply the diff on that branch — guaranteed clean, since the diff is against that exact commit
4. Merge the temp branch into the target

The merge is where git's 3-way machinery kicks in. It knows what the agent changed (seed → temp branch) and what the user changed (seed → HEAD), and merges them with full context about both sides' intent. Conflicts are standard git merge conflicts — resolvable with `git mergetool`, the editor, or any workflow the user already knows. No special quimby commands needed.

### Modes

- **Squashed** (default) — one commit on the temp branch, then a plain (fast-forward-if-possible) merge into the target. When the target is still at the seed this fast-forwards to the agent's own commit — clean linear history, no boundary node — with the commit message auto-filled from the parcel (an explicit `-m` overrides it). When the target has moved past the seed, git creates a standard merge commit with its default `Merge branch …` message: visibly a merge, and an obvious candidate to rebase away if you want a linear history. (Earlier this forced `--no-ff` plus a parcel-derived merge message, which produced a same-message work-commit + merge-commit pair for every apply — the "duplicate commits" that read as noise.)
- **`--commits`** — replay the agent's individual commits on the temp branch via `git am`, then merge (fast-forward when possible). Preserves the agent's commit history in the target repo.
- **`--patch`** — one commit on the temp branch, merged with `--squash --no-commit`. Changes land in the working tree uncommitted — curate your own commits.
- `-b` lands it on a fresh branch; `-t` targets a repo path other than the cwd.

### Conflict handling

On conflict, the merge is left in progress. The user resolves with standard git tooling, then `git merge --continue`. The staged parcel is kept so a retry doesn't re-download from SSH agents.

### Why merge, not patch

The previous approach applied the diff as a patch directly onto the target's working tree. This failed whenever the target had moved past the seed — which is the common case with multiple agents (you apply agent A's work, agent B's diff is now stale). The patch approach led to a cascade of workarounds: `--3way` mode, classification (settled/drifted/fresh), pre-emption, reduced diffs. The merge-based approach eliminates all of this by letting git do what it does best: three-way merge.

Persisting an agent's work is git's job, reached through apply: `quimby apply <agent> -b feature/x` lands it on a branch you keep. There is no separate "save this work" store.

## Sync Targets

An agent is a _synchronization relationship_, not a checkout. It records two things:

- **`seedCommit`** (mirrored by the `quimby/seed` tag) — the base the agent's work is measured from. A handoff's diff is the agent's working tree against this tag.
- **`syncRef`** — the ref the agent synchronizes against (e.g. `main`, `refs/heads/release`). Defaults to the host branch at `quimby add` time; an explicit `--sync` wins.

`quimby sync <agent>` resolves `syncRef`'s tip _in the host repo_ (not the host's live `HEAD`, so syncing is deterministic) and brings the agent onto it, with three behaviors:

- **default (safe)** — auto-stash the agent's uncommitted + untracked work, rebase its commits onto the new base, retag `quimby/seed`, then restore the stash. The agent's work is kept. A rebase or restore conflict aborts and reports, leaving the work intact.
- **`-f` (hard)** — `reset --hard` to the base, discarding the agent's commits and working changes — but its **mailbox** (inbox/outbox/assignment/status) is untouched. For "my work shipped; snap me to the latest and keep me in the conversation."
- **`--base <ref>`** — retarget `syncRef` to `<ref>` (persisted), then sync onto it. The way to move an agent to a different branch. (`set --sync` records the ref without syncing.)
- **`--current`** — sugar for `--base <the host's current branch>`, resolved once at call time. The everyday "snap onto where I am" — pair it with `-f` for the most common move after integrating (`quimby sync <agent> --current -f`: drop the agent's now-shipped work and rebase it on the branch you just landed work onto). It still **persists** the resolved branch as `syncRef`, so plain `sync` stays deterministic afterward; only the one-time read of live `HEAD` is implicit, and it errors on a detached HEAD (no branch to track). Orthogonal to `-f`: without `-f` it rebases the agent's work onto your branch; with `-f` it resets. Unlike `--base`, it is allowed with `--all` (retarget every agent onto your integration branch in one call).

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
- **Apply is a merge, not a patch**: The agent's diff is reconstructed on a temp branch from the seed, then merged into the target — not patched directly onto the working tree. A patch fails when the target has moved past the seed (the common case with multiple agents); a merge handles it with git's 3-way machinery, producing standard merge conflicts the user can resolve with tools they already know. The agent is never touched — no non-working state inside a sandbox. Conflicts live on the host where the user has full tooling. The merge is a **plain, fast-forward-when-possible** merge, deliberately **not** `--no-ff`: when the target hasn't moved past the seed the agent's commit fast-forwards into clean linear history; a merge commit appears only when the target genuinely diverged, and then it is a standard `Merge branch …` node the user recognizes and can rebase away. Forcing `--no-ff` (with a parcel-derived merge message) was rejected because it stamped a same-message work-commit + merge-commit pair onto history for every apply — visual duplication with no upside for a user who prefers the landed work to read as the newest commit.
- **Assign syncs by default, but never loses the message**: Assigning to a stale agent wastes tokens — the agent works off wrong files, discovers issues that are already fixed, or produces diffs that conflict on apply. `assign` writes `assignment.md` first (the user's intent is durable), then syncs the agent to its base. If sync fails (rebase conflict), the assignment is still on disk — the user's message is never lost — but the nudge is suppressed (don't wake an agent on a stale baseline). The user resolves the conflict and runs `quimby sync` manually. `--no-sync` opts out entirely.
- **Server is infrastructure, not convenience**: Agents in sandboxes can't see each other. The server is the only entity with cross-agent visibility. It's architecturally necessary, not a nice-to-have.
- **Auto-dispatch enacts the outbox; it doesn't replace subscribe**: while running, the server carries settled outbox drafts to their recipients on the poll cycle — the final removal of the human-as-messenger from the directed channel, since `dispatch` was already agent-authored routing the human merely triggered. It is deliberately **additive** to subscriptions, not a replacement for them: the two solve orthogonal problems. `dispatch` carries **directed, discrete parcels** (a diff and/or note addressed to one recipient); `subscribe` mirrors **ambient, continuous status** ("to whom it may concern," set once, pulled). Folding status into re-sent parcels would be chattier and lose the publish-once/pull property, so both stay. The safety comes from the same courier invariants automation needs: content-hashed names dedupe, bounces stay in the outbox, `.sent/` is the ledger — plus a **settle debounce** (a draft carries only after its files are unchanged for a full cycle) so a half-written parcel is never shipped, and an **attempt-once** rule so a bad address never nudges in a loop. Because human-gated dispatch was also the accidental rate limiter against the #1 pain point (token exhaustion), auto-dispatch is opt-out per server run (`--no-dispatch`), never per-agent config.
- **`serve -it` binds the server's life to a terminal, like `docker run -it`**: the server is a background daemon, but running it in one terminal and typing commands in another is friction. `-it` starts the server and stacks a shell on top in the same terminal, so commands run live against the server underneath and the server dies when you leave the shell. Ctrl+C is deliberately **not** a single-press kill — the shell owns it for interrupting commands, and only `exit`/Ctrl+D or a quick **double** Ctrl+C tears the server down, so interrupting a long command never accidentally takes the server with it. The server library returns a `stop()` handle rather than installing its own `process.exit`, so the command layer owns lifecycle in both the plain and interactive modes.
- **Three interaction modes coexist**: Interactive (run), headless (start), and server (serve) are separate concerns. run/start manage individual agents; serve manages the connections between them.
- **Stable IDs, not names**: `QuimbyState.id` and `AgentState.id` are UUIDs generated at creation and never change. tmux session names are derived from IDs, so renaming an agent doesn't orphan a running session.
- **One UUID is an agent's identity across every surface; the name is only a display label**: an agent's `id` keys its on-disk directory (`.quimby/agents/<id>/`, local and remote), its tmux session (`qb-<projectId[:8]>-<agentId[:8]>`), and its sandbox name. The friendly name is a pure display attribute — stored in `state.yaml`, shown in `quimby list`, and set as the tmux **window** title (`rename-window`) on each `run` so the on-screen label tracks renames. Because nothing on disk or in a live session is keyed by the name, **rename is a pure relabel**: the directory never moves (no `fs.rename`/`mv`), so the sandbox and tmux session bound to that path survive, and no running work is orphaned. Existing name-keyed workspaces migrate on state load (local: `fs.rename` to the id-dir; remote: a guarded `mv` on next `run`).
- **The sandbox name is a path-hash over the UUID-keyed directory**: `sbx` is path-sensitive — it persists the working directory's absolute path behind its `--name` — so the name must track the path, not pin it. The runtime passes `--name qb-<agentId[:8]>-<hash>`, where the hash covers the project id, agent id, and agent directory. Since the directory is UUID-keyed, the path (and thus the hash) is **stable across a rename**, so the sandbox is reused; a genuine **relocation** (the `.quimby` tree moving, or a clone mounted at a different path) changes the absolute path, flips the hash, and lets a fresh sandbox fall out instead of a stale name pointing at a directory that is gone. This is why a path-hash beats keying the sandbox on the bare UUID: a UUID name would survive rename but go stale on relocation (the original "workspace directory no longer exists" failure). The friendly name is deliberately **not** in the sandbox name — it changes on rename and would needlessly break reuse; the `agentId[:8]` prefix is a stable, greppable handle for `sbx ls`. The name is independent of the entrypoint, so `run` and `exec` for one agent share a sandbox.
- **SSH lazy init**: SSH agents are not set up remotely at `quimby add` time. The remote clone, tagging, and scaffolding happen on first `quimby run`. This allows adding SSH agents without an active SSH connection.
- **rsync as transport**: SSH agents sync the project source via rsync before each run. The remote clone is a local clone of the rsynced source tree — no direct git remote needed on the agent side.
- **tmux for SSH persistence**: SSH agents run in named tmux sessions. Disconnecting from a session doesn't kill the agent. `quimby run` reattaches to an existing session if one exists. Local agents can opt into the same behavior via the `tmux` field on `AgentState` — `quimby run` then wraps the local agent in `tmux new-session -A` against the stable-ID session name. On every (re)attach the window label is refreshed to the agent's display name (so it tracks renames).
- **Quimby owns its tmux, on a dedicated server**: rather than depend on whether the user has a good `~/.tmux.conf`, Quimby runs all its tmux on an **isolated server socket** (`tmux -L quimby`) started from a **bundled config** (`-f .quimby/tmux.conf`, generated by `renderTmuxConfig`; the remote twin is written over transport). The isolation is the point: Quimby's settings never leak into the user's default server, and its sessions never clutter the user's `tmux ls`. The config is **layered** — calm aesthetic defaults (a muted status bar showing the agent/window name, instead of tmux's default bright-green bar) → `source-file -q ~/.tmux.conf` so the user's own keybindings/theme still apply → Quimby's functional must-haves set _last_ so they win: true-color passthrough (`terminal-overrides ",*:Tc"`), `mouse on` (scroll wheel reaches scrollback — default tmux needs copy-mode), a generous `history-limit`, and stable window names. This fixes what session-scoped options couldn't: true-color (needs `default-terminal`/overrides at server start) and scrollback depth (needs `history-limit` before the pane is created). Every quimby tmux call — `new-session`, `has-session`, `send-keys` (nudge) — targets `-L quimby`, so they all see the same sessions. Trade-offs: `-f` is read only at server start, so config changes apply after the quimby server is next empty and restarts; and with mouse mode on, click-drag selects into tmux's copy buffer (hold Shift for the terminal's native selection). To reach a session by hand, use `tmux -L quimby attach` (but `quimby run` handles attach for you).
- **Nudge: wake a live agent in place, policy per movement**: writing `assignment.md` or dropping a parcel in an inbox is silent — a running interactive agent won't notice until its next prompt, leaving the user to switch terminals and type by hand. So quimby can inject `<text>` + Return into the agent's tmux session (`tmux send-keys`, keyed by the agent's stable UUID, so a rename never loses it). The default policy follows how directed the movement is: **assign** always nudges (you named one agent and gave it a task), **dispatch** nudges by default (the boss agent authored an addressed note with intent), **handoff** nudges only when the parcel carries a **note** — the instruction half — since a handoff is often pure data (a diff with no note); `--nudge`/`--no-nudge` force either way. The standalone **`quimby nudge <agent> [-m]`** is the explicit, ad-hoc live channel: no `-m` types `"continue"` (the lightest kick), and `-m` types arbitrary text verbatim — including CLI control commands like `/clear` or `/model …`. The text is the wake-up; the durable work still lives in `assignment.md`/the inbox, so a missed or skipped nudge only delays, never loses. A local non-tmux agent runs in the foreground (the user is already attached), so there is nothing to wake. There is deliberately **no separate `send` verb**: a first-class "send the agent instructions" command would compete with `assign` for the task-giving slot and tempt users onto an ephemeral channel when they need a durable task; folding arbitrary/control sends into `nudge -m` keeps the capability without advertising a verb that cannibalizes `assign`. Durable task-of-record is `assign`'s job; `nudge` is the live, ephemeral poke. **`nudge --all`** broadcasts (e.g. `--all -m "/clear"`) but first **probes tmux for live sessions** (`has-session`) and targets only those — so it never spams dead agents, and the logged target list shows exactly which live sessions received it.
- **Transport abstraction**: All agent I/O goes through `LocalTransport` or `SSHTransport`. Commands don't need to know where an agent lives — they call `transport.exec`, `transport.writeFile`, `transport.rsyncTo`, etc.
- **Transport never commits**: Work is captured from the agent's working tree (committed + uncommitted + untracked) via a throwaway index, so `handoff`/`dispatch`/`sync` never make a commit in an agent — frequent use never litters its history, and agents needn't use git at all. The only commit is the optional one at `apply`, the boundary.
- **Three levels of "catch up"**: `sync` keeps the agent's work (rebases it); `sync -f` drops the work but keeps the agent (mailbox intact); `rebuild --force` recreates the agent (mailbox cleared). `sync -f` resets the code; `rebuild` resets the agent. Destructive levels require an explicit flag.
- **remove --force for unreachable hosts**: When an SSH host is gone, `quimby remove --force` removes the local state entry without attempting remote cleanup.
- **No artificial simplicity**: This is infrastructure for multi-agent orchestration. Networking, servers, persistent state, SSH transport, and subscription management are all in scope.
