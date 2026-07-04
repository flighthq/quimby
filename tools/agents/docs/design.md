# Quimby — Design

This is the authoritative design document. Two companion docs are split out to keep each readable:

- **[cli-surface.md](./cli-surface.md)** — the complete command and flag reference.
- **[design-decisions.md](./design-decisions.md)** — the rationale log (why each choice was made, and what was rejected).

## Overview

Quimby is a CLI tool for orchestrating multiple AI agents working on a single project. Each **agent** is an isolated environment — a local clone of the source repo inside a sandbox, where an AI tool (the agent's _entrypoint_) does the work. Agents can't see each other; Quimby is the **courier** that hand-carries work between them, and across the boundary into the user's real repository.

Named after Chief Quimby from Inspector Gadget — the user dispatches the work, agents deliver, and Quimby hand-delivers the briefings in between. The unit it carries is a **handoff**: a parcel of work moved from one place to another and then done with. Quimby is a courier, not a post office — it carries parcels, it does not run a mailroom. There is no standing archive of past work; durable history lives in git.

This is infrastructure for multi-agent orchestration, not a thin wrapper around scripts. Networking, a local server, persistent state, and status mirroring are all in scope.

## Core Concepts

**Agent** — An isolated working environment. Each agent gets its own clone of the source repo, runs an AI tool (its _entrypoint_), can commit locally, and produces handoffs. Agents run inside sandboxes (Docker Sandbox, OpenShell, etc.) that prevent them from seeing each other — all cross-agent communication is mediated by the host. Agents can run locally or on a remote machine over SSH.

**Handoff** — A _parcel_ Quimby hand-carries from one agent to another (or out to the user's repo). It is always a folder with one uniform shape, and it carries whichever of these it has:

- a **note** — `README.md`, the human-readable message
- a **diff** — the agent's code as `squashed.diff` plus `commits/` patches
- any other **files** the sender chose to include

A `meta.yaml` manifest (sender, recipient, `createdAt`, code source) is written **last**, which signals the parcel is complete. A handoff with code and no note, a note and no code, or both, are all the same kind of thing — "pack vs instruction" is not a type distinction, just different contents. A handoff is named `<from>-<contentHash>` (a hash of its payload — diff plus note) — content-derived, so it needs no counter, dedupes identical sends, and reads back as "from whom, carrying what". The diff is also the wire format that lets work cross the boundary at all: an agent in a sandbox or over SSH is not a reachable git remote, so the host cannot `git fetch` it — Quimby carries the diff instead.

**Seed** — The `quimby/seed` git tag in each agent's repo marking the baseline. A handoff's diff is the agent's working tree (committed + uncommitted + untracked) against this tag.

**Boundary** — The boundary between the workspace (where agents work) and the user's real repository. Work only crosses the boundary through explicit user action (`quimby merge`), landing in git — the durable side of the boundary.

**Server** — The host-side process that enables cross-agent visibility. Agents in sandboxes are isolated from each other — the server is the only entity that can see all agents. It polls for status changes and mirrors each agent's status into every other agent's `status/` directory.

**Transport** — The abstraction layer over local filesystem vs SSH. `LocalTransport` operates on local paths; `SSHTransport` wraps all operations via `ssh` and `rsync`. Commands and core modules interact with agents through this abstraction without knowing where the agent lives.

## Three Modes of Agent Interaction

These are distinct concepts that coexist, not alternatives:

### 1. Interactive Agent (`quimby run`)

Takes over a terminal. The user is in a live CLI session with the agent (like running `claude` directly). This is the onramp and never goes away — sometimes you want to pair with the agent. For SSH agents, this attaches to (or creates) a named tmux session on the remote host. Implemented.

### 2. Headless Agent (`quimby start` / `quimby stop`)

Launches an agent in the background — in a **detached tmux session** rather than taking over a terminal. The user drives it with `quimby assign` / `quimby nudge` (both wake it in place via the session), reads results via `quimby status` and `quimby diff`, attaches to pair with `quimby run`, and tears it down with `quimby stop`. Implemented: a detached tmux session plus `nudge` is exactly headless execution — the entrypoint runs unattended and picks up new work when nudged, no terminal required. (A later `quimby start` could gain sandbox-native headless execution as runtimes expose it, but the tmux-detached form already delivers the mode.)

tmux is the universal substrate: every agent — local or SSH — always runs in its own persistent tmux session (there is no foreground path). `run` attaches-or-creates that one canonical session (`new-session -A`), so it grabs the session wherever it is launched, and enrolls the `tmux` field so `run`, `nudge`, and `list`'s state all recognize it. `start` creates the same session detached.

### 3. Server (`quimby serve`)

The host-side process that enables everything requiring cross-agent visibility:

- Polls agent `status.md` files for changes (local and SSH agents)
- Mirrors each agent's status into every other agent's `status/` directory (no subscriptions)
- Exposes a read-only HTTP API on localhost for status aggregation

The server doesn't replace `run` or `start` — it enables the connections between agents that sandbox isolation otherwise prevents. Implemented.

```
quimby serve                        # start the server (mirrors status to every agent)
quimby add backend                  # create an agent
quimby run backend                  # interactive session (server optional)
quimby assign backend -m "..."      # works with or without server
```

## Directory Layout

### Local Layout

An agent's mailbox is a single `handoff/` tree with two trays: an **out** tray (parcels it wants Quimby to carry, addressed by recipient) and an **in** tray (parcels delivered to it, named by sender + contents). Each tray has an explicit per-state subdirectory. Quimby picks up from `out/queued/` and hand-delivers to `in/received/`.

```
my-project/
  .quimby/
    state.yaml              # workspace state (agents, stable IDs)
    server.json             # server pidfile (when running)
    staging/                # host loading dock: a parcel mid-merge (kept only on conflict)
    agents/
      backend/
        repo/               # cloned source tree, tagged quimby/seed
        assignment.md       # current task (set by `quimby assign`)
        status.md           # agent-written status (mirrored to every other agent)
        CLAUDE.md           # generated agent instructions
        handoff/            # the mailbox — grouped by direction, one explicit state per level
          out/                 # everything this agent is sending
            draft/             #   authoring space — NOT scanned; the atomic-publish source
              reviewer/        #     a parcel being authored for `reviewer`
                README.md      #       the note (optional; may carry `attach:` in frontmatter)
                ...            #       any extra files (optional)
            queued/            #   finalized, awaiting pickup (published from draft by one `mv`)
              reviewer/
            sent/              #   delivery ledger — parcels already carried
              reviewer/
          in/                  # everything delivered to this agent
            received/            # arrived, to process
              frontend-a1b2c3d4/ #   a parcel delivered from `frontend`
                meta.yaml        #     manifest: from, to, createdAt, codeSource — written LAST
                README.md        #     the note (optional)
                squashed.diff    #     the diff (optional)
                commits/         #     the diff as patches (optional)
            processed/           # parcels this agent has acted on
        status/             # live status mirrors from every other agent (its own root, not a parcel)
          frontend.md
      frontend/
        ...
  src/
  package.json
  ...
```

The mailbox is an explicit-lifecycle tree: **state is a directory level above the party name** (`out/queued/<recipient>`, `in/received/<sender>-<hash>`), never a dot-prefix — self-documenting and collision-safe (an agent may be named anything, even `queued`). Direction (`in`/`out`) groups the two trays. Two naming schemes persist, deliberately, because the trays answer different questions:

- The **out** tray is addressed by recipient (`out/queued/<recipient>/`) — when authoring, the question is "who is this for".
- The **in** tray is named by origin + contents (`in/received/<sender>-<hash>/`) — when receiving, the question is "what did I get, and from whom".

An agent authors under `out/draft/<recipient>/` and **publishes** with a single atomic `mv` into `out/queued/`, so a partial parcel never appears as queued (see the auto-dispatch race fix in the lifecycle section).

`status/` is **not** a parcel — it is a live mirror the server overwrites each poll, read on demand, so it sits at its own root outside `handoff/`. Parcels are immutable, discrete deliveries; status is a continuously-updated reflection. They stay separate.

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
        handoff/            # same tree as local; out/queued is picked up and carried by Quimby
          out/{draft,queued,sent}/
          in/{received,processed}/
        status/             # status mirrors delivered here over transport
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
quimby set researcher --local                    # convert back to a local agent (drops the remote location)
```

`--local` is the flag counterpart to what the `config` walkthrough could already do — it drops the SSH `location` so the agent runs locally. It errors if the agent is already local, and cannot be combined with `--host`/`--port` (which set a remote location).

### Removing an unreachable SSH agent

```
quimby remove researcher --force
```

`quimby remove` is destructive, so — like `rebuild` — a bare `quimby remove <agent>` only warns and removes nothing; `--force` confirms the removal. `--force` cleans up the remote workspace **best-effort**: it attempts the remote `rm -rf`, but if the SSH host is unreachable it tolerates the failure — it removes the local state entry anyway and warns that the remote wasn't cleaned. There is no separate "skip remote" flag: an unreachable host simply degrades to a local-only removal.

### Host aliases (declared shared, bound private)

An SSH agent's connection target is reached through a **host alias** so the address stays out of the tracked repo. A shared `quimby.yaml` _declares_ an alias — either with no `host`, or with the self-referential placeholder `hosts: { remote: { host: remote } }` — which marks it **unbound**. The concrete `user@host` is **bound per machine** into ignored config: `.quimby/local.yaml` (this project, default) or user config (`--global`), so a preset can say `hostAlias: remote` while the worker's real address never enters git.

The agent stores the alias _reference_, not a flattened address (`location: { type: ssh, alias: remote }`), and the address is resolved from layered config **at launch** — so binding it once, or rebinding it later, propagates to every agent on that alias, and `restore` on a fresh machine reconnects by re-resolving rather than carrying a stale IP. When a launch (or `restore`'s own scan) needs an unbound alias, quimby **prompts once** and persists the answer — interactive only; a non-interactive run instead errors with the exact `quimby host <alias> --set …` command rather than a raw DNS failure.

### Reconnecting after `.quimby/` is lost (automatic)

The project's UUID (its `state.yaml` id) namespaces the remote workspace at `~/.quimby/workspaces/<projectId>/`, and it lives only in the ignored `.quimby/`. When that directory is lost (fresh clone, `git clean -x`, a new machine), quimby would otherwise mint a **new** id on the next `add`/`run`/`up` — silently orphaning the old remote agents. To prevent that, workspace resolution **adopts-or-creates**: before minting a fresh id it (1) relinks local durable storage if a match is registered, then (2) scans every **bound** host alias declared in config for a remote workspace whose git origin matches this repo. Exactly one match is **adopted silently** (its id + agent roster rebuilt, reusing the existing remote clone); zero means a genuinely new workspace (create fresh); more than one is the single case that defers to the user (`quimby restore --host <alias> --id <id>`). The scan uses bound aliases only — it never prompts — and an unreachable host is skipped, never fatal, so an offline command degrades to "no match" rather than hanging. A purely-local project (no bound SSH alias) never touches the network. `quimby restore` remains the **explicit** escape hatch for the cases auto-adopt won't guess (a different alias, cross-machine, `--id` disambiguation).

Because provisioning is now idempotent on git origin, a duplicate remote workspace can no longer appear by accident. To clean up ones left by the old always-mint behavior, `quimby storage prune-remote --host <alias>` lists (and with `--force` removes) remote workspaces for this repo that are **not** the active one — it never touches another repo's lanes or the workspace you are on, and refuses entirely when there is no local workspace to protect.

```
quimby host                                   # list aliases with bound / unbound status
quimby host remote --set user@gpu-box         # bind → .quimby/local.yaml (ignored)
quimby host remote --set user@gpu-box --global # bind → ~/.config/quimby/config.yaml (all projects)
quimby host remote                            # print the binding, or prompt to bind when unbound
```

## CLI Surface

The complete command reference, planned commands, advisory checks, and flag conventions live in **[cli-surface.md](./cli-surface.md)**. All commands follow `verb target [qualifiers]`; work moves sideways (`handoff`), routes an authored queue (`dispatch`), crosses out to your repo (`merge`), or sets a task in (`assign`).

## Configuration

Quimby still works without a config file. The first `quimby add` creates `.quimby/` and initializes the workspace. Ignored project-local `.quimby/local.yaml` is the primary saved-config path for a checkout: it can remember roles, presets, runtime profiles, dashboard layouts, and host bindings without leaking private machine details.

Configuration is split by boundary:

- **Ignored project-local `.quimby/local.yaml`** — per-checkout roles, presets, dashboard layouts, runtime profiles, private host aliases, and provider settings.
- **User config `~/.config/quimby/config.yaml`** — personal defaults and reusable private aliases across projects.
- **Tracked `quimby.yaml`** — optional team-safe shared intent only, when a repository deliberately wants to share role/profile names or layouts.
- **Ignored `.quimby/state.yaml`** — concrete generated state: UUIDs, seeds, and created agents.

Resolution order is concrete to general: CLI flags, existing agent state, project-local config, user config, tracked project config, then built-ins.

### Roles, Presets, And Layouts

Roles describe what an agent is for: runtime, entrypoint, tmux behavior, sync ref, and advisory check command. Presets create a named workspace shape from roles (formerly "recipes" — a legacy `recipes:` key still loads, folded into `presets`). Layouts name dashboard expressions, including panel dashboards. An optional top-level `default:` names the preset a bare `quimby up` creates and a bare `quimby run` opens. **Services** are named host-side commands a layout can place with a `$name` token: `services: { server: "quimby serve" }` plus `… / (host $server):30` runs `quimby serve` in a dashboard pane beside a plain host shell. A service pane is dashboard-local (it is not a retained agent session), so it is torn down when the dashboard exits — start-with-the-dashboard, stop-on-exit. Bare `$`/`host` stay plain shells; `$name` is the service form.

```yaml
default: review-loop

roles:
  builder:
    runtime: sbx
    entrypoint: claude
    check:
      command: npm run ci
      verifyByDefault: false

  reviewer:
    runtime: local
    entrypoint: claude

layouts:
  review:
    expr: 'reviewer | (builder integration) / ($ $):30'

presets:
  review-loop:
    agents:
      builder:
        role: builder
        hostAlias: gpu
      reviewer:
        role: reviewer
      integration:
        role: builder
    layout: review
```

`quimby add builder --role builder` creates one agent from a role. `quimby up review-loop` creates any missing agents from the preset; bare `quimby up` or `quimby up --default` creates from the configured default preset. `quimby run --layout review` opens the saved dashboard layout; `quimby run --layout review --default` also records it as the default, and a bare `quimby run` then opens it. The `default:` key (like host bindings) is auto-saved to ignored `.quimby/local.yaml` by default, or user config with `--global`; a tracked `quimby.yaml` may set it by hand for a team-shared default, but the tools never auto-write there.

Host aliases should resolve from private local/user config, so even when a shared preset says `hostAlias: gpu`, the worker name or IP address stays out of git.

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

`quimby serve` polls agent directories and **mirrors every agent's status to every other agent** — no subscriptions:

When backend's `status.md` changes, the server writes a snapshot into every other agent's `status/backend.md` mirror (for SSH agents, over transport). This happens continuously without user intervention.

Status is the "to whom it may concern" channel, and availability is universal because it's near-free (status files are tiny). The discernment is on the **reading** side, not the routing side: agents don't slurp the whole roster each cycle — they `ls status/` and read a peer's file **on demand** (the generated agent context says so), so wide availability never inflates any agent's context. This replaces the earlier subscribe model: subscriptions bounded what got mirrored to bound what an agent read; pull-on-demand bounds reading directly, so mirroring can be universal and the "forgot to subscribe" silent miss disappears. The human still sees every agent via `quimby status`. The split is deliberate: **directed** work is pushed (a `handoff` parcel + nudge); **ambient** status is pulled (a `status/` peek).

The server also **auto-dispatches queued parcels**: on the same poll cycle it scans each agent's `out/queued/` and carries any _settled_ parcel to its recipient — the automatic twin of `quimby dispatch`, so a reviewer's authored parcel is enacted without a human relaying it. The partial-write race is prevented **by construction**: agents author under the unscanned `out/draft/` and publish with one atomic `mv` into `out/queued/`, so a parcel appears in the queue complete or not at all. The settle-debounce is kept as a cheap **fallback** (protecting an agent that writes directly into `out/queued/`, skipping draft): a parcel is dispatched only once its newest file has been unchanged for a full poll cycle. An atomically-published parcel lands complete and settles in one cycle, so net latency is ≤1 poll cycle. Each exact parcel version is attempted at most once, so a bounced (unknown recipient) or failed carry never retries in a loop, and a re-authored parcel (new mtime) is treated as fresh. A running recipient is nudged, exactly as with manual dispatch. Dispatch (directed, discrete parcels) and status mirroring (ambient status) are orthogonal channels; auto-dispatch is on by default, and `quimby serve --no-dispatch` disables it, leaving only status mirroring.

## Server Architecture

The server (`quimby serve`) runs two components:

### HTTP API (localhost, default port 7749)

The server prefers **7749**, but that is a preference, not a pin: when no `-p` is given and 7749 is already taken, it falls back to an OS-assigned free port rather than failing, so two workspaces can each run a server without a clash. An explicit `-p <port>` is pinned — if that port is taken the server errors cleanly instead of silently moving. The chosen port is recorded in `.quimby/server.json`, so CLI clients always find the running server regardless of which port it landed on. Stop a background server with `quimby serve --stop`.

```
GET  /api/status                              Server health + overview
GET  /api/agents                             All agents with cached status
GET  /api/agents/:name                       Single agent detail
```

The API is read-only — status routing is automatic (mirror-to-all), so there is nothing to POST.

### Status Poller (default 5s interval)

1. Check `state.yaml` mtime — reload if changed (picks up new agents)
2. For each agent, check `status.md` (local: mtime; SSH: content comparison)
3. If changed, read content, update cache, and mirror it into **every other agent's** `status/<name>.md` (local or remote) — no subscription filter
4. Scan each agent's `out/queued/`; auto-dispatch any parcel whose newest mtime was unchanged since the previous cycle (settled), then nudge the recipient — skipped entirely under `--no-dispatch`

The server writes `.quimby/server.json` (pid, port, startedAt) on startup and removes it on shutdown. CLI commands use this file to detect a running server and display its status.

### Interactive mode (`serve -it`)

`quimby serve -it` (or `--interactive`) starts the server and then stacks a shell on top of it, so `quimby` (and any other) commands run live against the server underneath — one terminal instead of two. The shell owns the terminal, so its own Ctrl+C just interrupts the current command; `exit`/Ctrl+D — or a quick double Ctrl+C — stops the server and quits. (A single Ctrl+C deliberately does _not_ tear the server down, so interrupting a command is never fatal.) The `-it` spelling reads like `docker run -it`.

## Handoff Lifecycle

A handoff is assembled on demand and carried; it is not deposited in any archive. The lifecycle is non-destructive — nothing an agent authored is lost to a failed delivery.

**Direct carry (`quimby handoff`).** Quimby:

1. Resolves the diff. For `handoff A B`, that is A's working tree (committed + uncommitted + untracked) against `quimby/seed` — captured commit-free — or the `--attach` source's, with an optional `--rebase` (sync) first. For `handoff B` (host source), it is the host working tree vs B's seed, squashed. Sender name is the reserved `host`.
2. Validates the recipient against the agent roster. An unknown recipient (a typo) is reported and nothing is carried — it bounces, never silently dropped.
3. Assembles the parcel — note, diff — writes `meta.yaml` **last**, delivers it to `<to>/handoff/in/received/<from>-<hash>/` (local copy or rsync), then discards the staging copy.

**Outbox routing (`quimby dispatch <agent>`).** Agent-authored routing rather than an immediate human move:

- **Authoring (the agent).** Inside its sandbox an agent authors a parcel under `handoff/out/draft/<recipient>/README.md` (the note) plus any files, then **publishes** it with one atomic `mv` into `handoff/out/queued/<recipient>/`. Frontmatter `attach: <agent>` carries that agent's diff instead of the sender's own. The agent decides the routing; the host enacts it.
- **Enacting.** `dispatch` scans `out/queued/` and carries every queued parcel to its addressee. An unknown recipient is **left queued to fix** (bounce). On success the parcel is **moved** to `out/sent/<recipient>/` (timestamped) — the progress ledger: active `out/queued/*` = queued, `out/sent/*` = carried and when. A failed carry leaves the parcel queued for a clean retry.

**Consumption (the recipient).** Parcels sit in `handoff/in/received/` until the agent processes them and moves them to `handoff/in/processed/`. Identity is content-derived, so a re-carried identical parcel overwrites in place rather than piling up.

**Garbage collection.** `out/sent/` and `in/processed/` are caches, not the hot path — bounded by agent lifetime (everything dies with the agent) and pruned by `sync`/`rebuild` rather than a dedicated `gc` verb. `quimby sync` sweeps the `out/sent/` ledger and `in/processed/` archive after it advances the agent (best-effort — a prune failure never fails the sync), leaving active queued/received parcels, `assignment.md`, and `status.md` untouched; `rebuild` clears the whole mailbox anyway. GC is archiving-then-pruning, never silent deletion on carry.

## Merge (crossing the boundary)

`quimby merge <agent>` is the one verb that moves work **out** to the user's real repository. It uses a **merge-based** strategy: the agent's diff is reconstructed on a temporary branch rooted at the agent's seed commit (where it applies cleanly by definition), then merged into the target. The agent is never committed to in the process — capture is commit-free; the commit (if any) happens here, at the boundary.

### Merge-based strategy

The agent's diff was generated against its seed. Patching it directly onto a target repo that has moved past the seed fails — context lines don't match, `git apply` aborts, and the user faces a conflict they can't interpret (is it real overlap, or just a stale diff?). The merge-based flow solves this:

1. Stage the parcel in `.quimby/staging/` (diff + patches + meta, same as before)
2. Create a temp branch from the seed commit in the target repo
3. Reconstruct the diff on that branch — guaranteed clean, since the diff is against that exact commit
4. Merge the temp branch into the target

The merge is where git's 3-way machinery kicks in. It knows what the agent changed (seed → temp branch) and what the user changed (seed → HEAD), and merges them with full context about both sides' intent. Conflicts are standard git merge conflicts — resolvable with `git mergetool`, the editor, or any workflow the user already knows. No special quimby commands needed.

### Modes

- **Squashed** (default) — one commit on the temp branch, then a plain (fast-forward-if-possible) merge into the target. When the target is still at the seed this fast-forwards to the agent's own commit — clean linear history, no boundary node. When the target has moved past the seed, git creates a standard merge commit with its default `Merge branch …` message: visibly a merge, and an obvious candidate to rebase away if you want a linear history. (Earlier this forced `--no-ff` plus a parcel-derived merge message, which produced a same-message work-commit + merge-commit pair for every merge — the "duplicate commits" that read as noise.) **You author the squash commit's message**: with no `-m`, git's editor opens prefilled with the agent's own subject (save-quit accepts it, empty aborts). Crossing the boundary is an explicit act, so its one new commit is curated, not auto-stamped.
- **`--commits`** — replay the agent's individual commits on the temp branch via `git am`, then merge (fast-forward when possible), preserving the agent's commit history in the target. Any **uncommitted remainder** (work the agent hadn't committed) is applied to the working tree **after** the merge and **left uncommitted** — the agent didn't commit it, so quimby doesn't either. `--commits -m "…"` opts that remainder into one trailing commit with your message.
- **`--patch`** — one commit on the temp branch, merged with `--squash --no-commit`. Changes land in the working tree uncommitted — curate your own commits.
- `-b` lands it on a fresh branch; `-t` targets a repo path other than the cwd.

The unifying rule: **the boundary never fabricates a commit message.** A commit that lands carries either the agent's own message (`--commits`) or one you author (the squash, or a `--commits -m` remainder). When quimby can't ask you to name a commit it would otherwise synthesize — no `-m` and no TTY — it doesn't invent one: squashed **degrades to `--patch`** (the work lands uncommitted, with the suggested message printed), and `--commits` simply leaves its remainder loose. So the interactive squashed loop opens an editor; scripts fall back to an uncommitted landing; a generic auto-message never reaches your history.

### Conflict handling

On conflict, the merge is left in progress. The user resolves with standard git tooling, then `git merge --continue` — no special quimby command. The staged parcel is kept so a retry doesn't re-download from SSH agents.

If the user instead **abandons** the merge (`git merge --abort`), that staged parcel would linger. There is deliberately no `quimby merge --abort`/`--continue` to clean it up; quimby **auto-heals** instead. The next `quimby merge` (when it stages fresh work) silently clears a leftover staging area **only when no git merge is in progress** in the target — an in-progress merge is the live retry path, so its parcel is preserved. Nothing for the user to remember.

### Advancing the seed after a merge (on by default)

An agent's diff is always its working tree against `quimby/seed` — **cumulative**. So when you iterate with one agent (merge its work, then ask it for a revision), its next diff still re-contains everything already merged. Re-merging that on a target that now has the earlier work is fragile: the moment the regenerated diff isn't byte-identical to what landed, git flags a conflict on lines the agent never touched. The fix is to advance the agent's seed onto what just landed, so the next diff carries only new work.

`merge` does this automatically on a clean, committed merge (`--no-sync` opts out; `--sync <ref>` advances _and_ retargets the agent's sync ref to `<ref>`) by running `sync -f` for the agent — but only when it is provably lossless:

- **The merge settled onto the branch the agent tracks**, in the host repo — no `-b`, no divergent `-t`, and `HEAD` resolves to the agent's `syncRef` tip. Otherwise the work isn't on `syncRef`, and advancing would snap the agent to a base that lacks it (reintroducing the cumulative-diff conflicts). A landing-branch or foreign-target merge is a deliberate deferral, so the seed stays put.
- **The agent is unchanged since the snapshot the merge captured** — checked by recomputing the agent's live parcel name (its content hash) and comparing to the merged parcel's. Equal ⇒ identical tree ⇒ the `reset --hard` in `sync -f` loses nothing. If it drifted (the agent kept working), the seed is left alone with a pointer to `quimby sync <agent> --current -f`.

Only a **fully-committed landing** (a "clean base hit") advances — squashed-committed, or `--commits` with no loose remainder. Anything that leaves work uncommitted (explicit `--patch`, the no-TTY degrade, a `--commits` remainder) is an incomplete landing: nothing has settled, so the seed stays put. In every case where the seed is _not_ advanced but a standard merge would have — an uncommitted landing, a condition-skip (`-b`/`-t`/off-branch or drift), or `--no-sync` — `merge` prints the catch-up (`quimby sync <agent> --current -f`) so the agent doesn't silently go stale and walk back into the cumulative-diff trap. When the advance does run it logs `Advanced "<agent>" seed → <sha>`, mirroring `assign`'s sync line. The celebratory quip fires only on a clean base hit, so a committed landing reads as success and an uncommitted one reads as "more to do."

### Why merge, not patch

The previous approach applied the diff as a patch directly onto the target's working tree. This failed whenever the target had moved past the seed — which is the common case with multiple agents (you merge agent A's work, agent B's diff is now stale). The patch approach led to a cascade of workarounds: `--3way` mode, classification (settled/drifted/fresh), pre-emption, reduced diffs. The merge-based approach eliminates all of this by letting git do what it does best: three-way merge.

Persisting an agent's work is git's job, reached through merge: `quimby merge <agent> -b feature/x` lands it on a branch you keep. There is no separate "save this work" store.

## Sync Targets

An agent is a _synchronization relationship_, not a checkout. It records two things:

- **`seedCommit`** (mirrored by the `quimby/seed` tag) — the base the agent's work is measured from. A handoff's diff is the agent's working tree against this tag.
- **`syncRef`** — the ref the agent synchronizes against (e.g. `main`, `refs/heads/release`). Defaults to the host branch at `quimby add` time; an explicit `--sync` wins.

`quimby sync <agent>` resolves `syncRef`'s tip _in the host repo_ (not the host's live `HEAD`, so syncing is deterministic) and brings the agent onto it, with three behaviors:

- **default (safe)** — auto-stash the agent's uncommitted + untracked work, rebase its commits onto the new base, retag `quimby/seed`, then restore the stash. The agent's work is kept. A rebase or restore conflict aborts and reports, leaving the work intact.
- **`-f` (hard)** — `reset --hard` to the base, discarding the agent's commits and working changes — but its **mailbox** (`handoff/`, `status/`, `assignment.md`, `status.md`) is untouched. For "my work shipped; snap me to the latest and keep me in the conversation."
- **`--base <ref>`** — retarget `syncRef` to `<ref>` (persisted), then sync onto it. The way to move an agent to a different branch. (`set --sync` records the ref without syncing.)
- **`--current`** — sugar for `--base <the host's current branch>`, resolved once at call time. The everyday "snap onto where I am" — pair it with `-f` for the most common move after integrating (`quimby sync <agent> --current -f`: drop the agent's now-shipped work and rebase it on the branch you just landed work onto). It still **persists** the resolved branch as `syncRef`, so plain `sync` stays deterministic afterward; only the one-time read of live `HEAD` is implicit, and it errors on a detached HEAD (no branch to track). Orthogonal to `-f`: without `-f` it rebases the agent's work onto your branch; with `-f` it resets. Unlike `--base`, it is allowed with `--all` (retarget every agent onto your integration branch in one call).

`--all` syncs every agent, skipping any with conflicts. Agents created before sync targets existed are migrated on state load: a missing `syncRef` is backfilled from the workspace `sourceRef`. The merge target is independent of `syncRef` — `quimby merge <agent> -t <branch>` lands work wherever you choose.

## Rebuild

`quimby rebuild <agent> --force` recreates the agent: it deletes the agent's repo, re-clones from the current source, **clears its mailbox** (`handoff/` and `status/`), and resets assignment/status to empty/idle. `--force` is required. This is for "this agent is done or broken — start a blank one." When you only want to reset the _code_ but keep the agent in the conversation, `sync -f` is the gentler tool (it leaves the mailbox alone).

For SSH agents, rebuild rsyncs the latest source to the remote, deletes and re-clones the remote repo, retags `quimby/seed`, and clears the remote mailbox.

## diff Semantics

- `quimby diff <agent>` — live diff of the agent's commits against its seed (a preview of what a handoff or merge would carry)
- `quimby diff <a> <b>` — show two agents' diffs side-by-side
- `--stat` — diffstat summary only

Diff operates on agents only. Handoffs are carried, not stored, so there is nothing frozen to diff — preview the live agent instead.

## Key Design Decisions

The full rationale log — every choice and what was rejected — lives in **[design-decisions.md](./design-decisions.md)**. It covers: courier-not-post-office; the one-shape handoff; content-derived names; the explicit-lifecycle `handoff/` tree (no dot-dirs); addressed-out / content-named-in; author-then-publish atomic rename; non-destructive delivery; a verb per movement; directed-handoff-vs-broadcast; the diff as wire format; squashed-merge-by-default; merge-is-a-merge-not-a-patch; merge-advances-the-seed-when-lossless; the-boundary-never-fabricates-a-commit-message; assign-syncs-by-default; server-as-infrastructure; status-mirrors-to-all-with-pull-on-demand; auto-dispatch; `serve -it`; the three coexisting interaction modes; stable-IDs-not-names; the UUID identity and path-hash sandbox naming; SSH lazy init; rsync as transport; tmux-as-universal-substrate and the dashboard viewport; quimby-owns-its-tmux; nudge policy per movement; headless = detached-tmux + nudge; `list` session-state probing; the transport abstraction and its never-commit rule; the three levels of "catch up"; `remove --force`; and no-artificial-simplicity.
