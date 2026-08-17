# Quimby — Design

This is the authoritative design document (shipped behavior). Companion docs are split out to keep each readable — see the [docs index](../README.md) for the full map and the idea lifecycle:

- **[cli-surface.md](./cli-surface.md)** — the complete command and flag reference.
- **[design-decisions.md](./design-decisions.md)** — the rationale log (why each choice was made, and what was rejected).
- **[developing.md](./developing.md)** — contributor on-ramp: architecture tour and how to add a package, command, or type.
- **[ideas.md](./ideas.md)** — the living catalog of prospective (not-yet-shipped) ideas, with status.
- **[coordination-proposals.md](./coordination-proposals.md)** — _proposed, not yet implemented_: a scaffolded `agent.sh` orient/recover/checkpoint set, a read-only `commons/` channel, directed-relationship authority (`directs`), and the attached-session nudge rule.

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
quimby set researcher --host-alias remote        # repoint at a declared alias (stores the reference, not an address)
quimby set researcher --local                    # convert back to a local agent (drops the remote location)
```

`--local` is the flag counterpart to what the `config` walkthrough could already do — it drops the SSH `location` so the agent runs locally. It errors if the agent is already local, and cannot be combined with `--host`/`--host-alias`/`--port` (which set a remote location).

`--host-alias` is the migration path **off** a flattened address. An agent created before aliases (or with an explicit `--host`) stores a concrete `location.host`, which is never re-resolved — so moving that worker meant a `set --host` per agent, or hand-editing `state.yaml`. Passing `--host-alias <alias>` stores the alias _reference_ instead, and from then on the address resolves from layered config at launch, so rebinding the alias once reaches every agent that shares it. The alias must at least be declared (a typo fails immediately rather than at launch), and `--host` and `--host-alias` cannot be combined — they store different things, so quimby asks rather than guessing.

### Removing an unreachable SSH agent

```
quimby remove researcher --force
```

`quimby remove` is destructive, so — like `rebuild` — a bare `quimby remove <agent>` only warns and removes nothing; `--force` confirms the removal. `--force` cleans up the remote workspace **best-effort**: it attempts the remote `rm -rf`, but if the SSH host is unreachable it tolerates the failure — it removes the local state entry anyway and warns that the remote wasn't cleaned. There is no separate "skip remote" flag: an unreachable host simply degrades to a local-only removal.

### Host aliases (declared shared, bound private)

An SSH agent's connection target is reached through a **host alias** so the address stays out of the tracked repo. A shared `quimby.yaml` _declares_ an alias — either with no `host`, or with the self-referential placeholder `hosts: { remote: { host: remote } }` — which marks it **unbound**. The concrete `user@host` is **bound per machine** into ignored config: `.quimby/local.yaml` (this project, default) or user config (`--global`), so a preset can say `hostAlias: remote` while the worker's real address never enters git.

The agent stores the alias _reference_, not a flattened address (`location: { type: ssh, alias: remote }`), and the address is resolved from layered config **at launch** — so binding it once, or rebinding it later, propagates to every agent on that alias, and `restore` on a fresh machine reconnects by re-resolving rather than carrying a stale IP. When a launch (or `restore`'s own scan) needs an unbound alias, quimby **prompts once** and persists the answer — interactive only; a non-interactive run instead errors with the exact `quimby host <alias> --set …` command rather than a raw DNS failure.

### Reconnecting after `.quimby/` is lost (automatic)

The project's UUID (its `state.yaml` id) namespaces the remote workspace at `~/.quimby/workspaces/<projectId>/`, and it lives only in the ignored `.quimby/`. When that directory is lost (fresh clone, `git clean -x`, a new machine), quimby would otherwise mint a **new** id on the next `add`/`run`/`up` — silently orphaning the old remote agents. To prevent that, workspace resolution **adopts-or-creates**: before minting a fresh id it (1) relinks local durable storage if a match is registered, then (2) scans every **bound** host alias declared in config for a remote workspace whose git origin matches this repo. Exactly one match is **adopted silently** (its id + agent roster rebuilt, reusing the existing remote clone); zero means a genuinely new workspace (create fresh); more than one is the single case that defers to the user (`quimby restore --host <alias> --id <id>`). The scan uses bound aliases only — it never prompts — and an unreachable host is skipped, never fatal, so an offline command degrades to "no match" rather than hanging. A purely-local project (no bound SSH alias) never touches the network. Seeing and pruning storage has to work as well over SSH as locally, because SSH is where a fleet of any size actually lives — a laptop runs out of sandboxes long before a remote box does. So the remote side mirrors the local verbs: `quimby storage list-remote --host <alias>` lists **every** workspace on a host (id, origin, agent count, size, and whether this machine claims it), and `quimby storage remove-remote <id> --host <alias> --force` removes one by id, refusing the workspace the current repo is using. The listing filters nothing on purpose — `prune-remote` shows only the subset matching the repo you run it from, which hides other repos' lanes, the active one, and any half-provisioned directory with no `.quimby/agents` (the adopt/prune scan skips exactly those, so they consume disk while being invisible to every other command).

`quimby restore` remains the **explicit** escape hatch for the cases auto-adopt won't guess (a different alias, cross-machine, `--id` disambiguation).

Both identifiers adoption relies on — the registry's `repoRoot` path and the workspace's `sourceRepo` origin — can go stale, and a **renamed repository** makes them stale together. Four rules keep a rename from turning into an adoption:

- **`sourceRepo` is refreshed from the git origin on every resolve.** It used to be written once at creation, so a repository renamed on its host kept identifying as a name it no longer answered to — and that stale value is copied into the registry, which is what matching reads. (A repo with no remote stores its own path instead; that is re-pointed when the checkout moves, since there the path _is_ the identity. A stored URL is never replaced by a path — losing a remote does not make a project a different one.)
- **A registry path match must not be contradicted by the origin.** `repoRoot` is an absolute path nothing revalidates, so a renamed checkout leaves its old path free for a different project to occupy — which then matched the old entry and inherited its workspace whole. When both identifiers are known and they disagree, the path was recycled.
- **Adoption never overwrites a workspace another live checkout owns.** Reconstruction symlinks `.quimby` at the adopted id's storage and writes `state.yaml` through it, so adopting a workspace someone else holds silently replaces their state. If the registry maps that id to a different `repoRoot` that still exists, quimby stops and names it. A claim whose directory is _gone_ does not block — that is the moved-or-deleted checkout `restore` exists to recover.
- **A real `.quimby/` meeting existing storage for the same id is resolved or reported, never ignored.** An empty storage directory is a husk from an interrupted migration, so the local directory moves in and the link completes; when both hold content there are two `state.yaml` files for one id and quimby will not guess which is authoritative.

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

Quimby still works without a config file. The first `quimby add` creates `.quimby/` and initializes the workspace. When a repository carries a tracked `quimby.yaml`, it is the auditable source of shared workflow intent: roles, presets, runtime profile launch fields, dashboard layouts, and defaults that it defines dominate hidden config. Ignored project-local `.quimby/local.yaml` remembers private checkout details and local-only additions without leaking machine-specific settings.

Configuration is split by boundary:

- **Tracked `quimby.yaml`** — team-safe shared intent: role/profile/layout/preset names, launch defaults, and dashboard shape. When it defines a shared key, it wins over hidden config.
- **Ignored project-local `.quimby/local.yaml`** — private per-checkout details, local-only additions, host alias bindings, provider endpoints, env, and other machine-specific settings.
- **User config `~/.config/quimby/config.yaml`** — personal defaults and reusable private aliases across projects.
- **Ignored `.quimby/state.yaml`** — concrete generated state: UUIDs, seeds, and created agents.

Resolution order is: CLI flags, existing agent state, tracked project config for any shared keys it defines, project-local config for additions/private fills, user config, then built-ins. Host alias addresses are the deliberate exception: tracked config may declare an alias, but private local/user bindings supply the concrete address.

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
    # who a builder may SUMMON when blocked. An allow-list it picks ONE recipient from per
    # escalation — not a fan-out. Receiving an escalation grants no authority back.
    escalatesTo: ['@reviewer', integration]

  reviewer:
    runtime: local
    entrypoint: claude
    # who this role may DIRECT — the edge that makes a parcel interrupt its recipient.
    # An agent's own entry overrides this; `quimby sync` re-reads both.
    directs: ['@builder']

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

A role may also carry **`instructions`** — its standing charter, rendered into every agent of that role's `CLAUDE.md`/`AGENTS.md` as a `## Your role` section (an agent entry's own `instructions` replaces its role's). This is deliberately _not_ `assignment.md`: the assignment is the **current task** and is overwritten by the next `quimby assign`, while the charter is who the agent is across every task it will ever be given — so a fleet's division of labour lives in tracked, reviewable config instead of being re-typed into each agent and lost on the next assign. Like the coordination edges, it is re-rendered on every launch and `quimby sync`, and ingested at the agent's next context reset.

`quimby add builder --role builder` creates one agent from a role. `quimby up review-loop` creates any missing agents from the preset; bare `quimby up` or `quimby up --default` creates from the configured default preset. **Creation is driven by `presets.<name>.agents` alone — the layout only _places_ agents, it never creates them.** A layout leaf that names neither a declared entry nor a live agent (nor a `@role` slot that any of them satisfies) is a hard error that creates nothing, naming the offending leaf and telling you to declare it under `agents:` or drop it from the layout. This is deliberate: without it, removing an agent from `agents:` (and from the workspace) but forgetting the stale layout line silently **regenerates** the agent on the next `up`/`run`. `quimby run --layout review` opens the saved dashboard layout; `quimby run --layout review --default` also records it as the default, and a bare `quimby run` then opens it. The `default:` key (like host bindings) is auto-saved to ignored `.quimby/local.yaml` by default, or user config with `--global`; a tracked `quimby.yaml` may set it by hand for a team-shared default, but the tools never auto-write there.

Host aliases should resolve from private local/user config, so even when a shared preset says `hostAlias: gpu`, the worker name or IP address stays out of git.

**Where an agent runs is declared at whichever level it is true of.** `hostAlias` resolves like every other launch setting — the agent entry's own, else its role's, else `defaults` — so a fleet that lives on one box says so **once**:

```yaml
defaults:
  hostAlias: remote # every agent runs on the remote box…
roles:
  critic:
    hostAlias: '' # …except this one, kept local
```

An explicit `location:` on an entry overrides every `hostAlias` above it, and `--host`/`--host-alias` on `quimby add` override all of it. This matters because the failure is silent and expensive in the wrong direction: an alias that doesn't resolve doesn't error, it just creates the agent **locally**, so a fleet meant for a remote box quietly runs its whole sandbox load on the laptop. For the same reason `defaults` is key-checked like `roles:` and preset entries — a key quimby doesn't read is reported rather than ignored.

### VS Code Extension (Proposed)

The Visual Studio Code integration should be a first-class **Quimby extension**, not a generic terminal layout renderer. It belongs in this monorepo as `apps/vscode`, beside `apps/cli`, and should be backed by the same internal packages rather than depending on a globally installed `quimby` executable for core behavior.

The extension activates when a workspace contains `quimby.yaml`. Activation should resolve the Quimby workspace, start Quimby's background coordination service, and then either restore the user's last open Quimby layout or show a Quimby Home surface. The Home surface is the VS Code equivalent of a launch/control page when no layout is open: current workspace, available presets/layouts, agents, server state, recent/last layout, and commands such as open default layout, restore last layout, and close layout.

The layout experience is still central: opening a saved `quimby.yaml` layout creates side-by-side VS Code terminal groups with named tabs for agents. Each agent panel reconnects by launching the same retained Quimby session semantics as `quimby run <agent>`; host and service panels run their resolved host commands. Panels are disposable views. Every layout open/reopen creates fresh VS Code terminals and relaunches the panel commands, while the durable agent sessions remain owned by Quimby/tmux. A layout is tracked as one extension-owned session, so `Quimby: Close Layout` can dispose every terminal in the group together without killing agent work.

The extension should not independently parse `quimby.yaml`, merge layered config, infer preset agents, or understand the layout grammar. Those semantics belong in shared Quimby package APIs used by both `apps/cli` and `apps/vscode`. The current CLI-owned layout parser/planner should be moved out of `apps/cli` into reusable package code (for example `@quimbyhq/launch`, `@quimbyhq/workspace`, or a focused layout package if that keeps boundaries cleaner). A CLI JSON command remains useful for inspection and external tools, but the extension should prefer direct package calls over shelling out to `quimby`.

The shared plan API should resolve the same inputs as `quimby run --layout`: tracked `quimby.yaml`, ignored local/user config, presets, named layouts, inline layout expressions, host/service tokens, agent existence, missing preset agents, and private host alias bindings. Its output is a renderer-neutral tree:

```json
{
  "version": 1,
  "cwd": "/repo",
  "source": { "name": "review", "expr": "reviewer | builder / $server:30" },
  "root": {
    "type": "cols",
    "children": [
      {
        "type": "tabs",
        "terminals": [
          {
            "kind": "agent",
            "name": "reviewer",
            "command": { "argv": ["tmux", "..."] },
            "cwd": "/repo"
          }
        ]
      },
      {
        "type": "rows",
        "children": [
          { "type": "tabs", "terminals": [{ "kind": "agent", "name": "builder" }] },
          { "type": "tabs", "weight": 30, "terminals": [{ "kind": "service", "name": "$server" }] }
        ]
      }
    ]
  }
}
```

The VS Code extension then renders that plan:

- Activate on `workspaceContains:quimby.yaml`.
- Start `@quimbyhq/server` while the extension is active, using the existing `startServer` API where possible.
- Contribute `Quimby: Home`, `Quimby: Open Layout`, `Quimby: Restore Last Layout`, and `Quimby: Close Layout`.
- Remember the last opened layout in VS Code workspace state and restore it on reopen when the user setting allows it.
- Create named VS Code terminals for leaves (`builder`, `reviewer`, `host`, service names).
- Use editor or panel terminal splitting for `cols`/`rows`; use VS Code terminal tabs/groups for `tabs`.
- Send or spawn each resolved command, normally the library equivalent of `quimby run <agent>` for agents.
- Keep Quimby/tmux as the retained session substrate; VS Code is the operator viewport.

This can reproduce the common dashboard workflow well: "open the review layout, show builder and reviewer beside a host/service pane, with stable names." Exact tmux parity is not the goal. VS Code terminal APIs can create named terminals and split a terminal beside another, but they are not a deterministic tmux layout engine; weights such as `:70` should be best-effort hints in VS Code, while tmux remains the exact renderer for weighted panel dashboards.

## No Init for Workspace Bootstrap

Workspace **state** is never bootstrapped by a mandatory step: the first `quimby add`/`up`/`run` creates `.quimby/` lazily (UUIDs, seeds, agents), and the directory is added to `.gitignore` automatically. You never _have_ to initialize to start.

`quimby init` exists, but for a different concern — **config scaffolding**, not workspace bootstrap. It authors a tracked `quimby.yaml` (roles, runtime profiles, a preset, a layout, a default) from a built-in **starter** so you stop copying config between projects, then `up`/`run` take over. It is the shared-config counterpart to the per-agent `config` walkthrough (which writes an agent's private state), and it is the one command whose job is to _author the tracked file_ — everywhere else the tools auto-write only to ignored config.

```
quimby init                 # interactive: pick a starter, customize engine / builder count / location
quimby init review-loop     # scaffold a named starter non-interactively
quimby init --list          # list the built-in starters (solo, review-loop, fleet)
quimby init --force         # overwrite an existing quimby.yaml (otherwise refused)
```

Starters live in `@quimbyhq/workspace` (`buildStarterConfig`), and the interactive path **reuses your existing config** two ways. **Host aliases**: it scans aliases already bound in your user/local config and offers them, writing a _reference_ (`hostAlias: remote`, with `remote` declared unbound in the tracked file) so an alias you already configured needs no re-entry and its address stays out of git. **Runtime profiles**: it offers profiles you already declared (`listRuntimeProfiles`) as engine choices — picking one references it by name and inlines only its **shareable shape** (`runtime`/`entrypoint`, via `shareableProfileShape`), while the machine/secret fills (`env`, `provider`, `model`, `ollama`, `permissions`) stay in your private config and merge back at resolution. So reuse is uniform: aliases by pure reference, profiles by shape-inline + secret-reuse — the tracked file never carries a secret.

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

Status is the "to whom it may concern" channel, and availability is universal because it's near-free (status files are tiny). The discernment is on the **reading** side, not the routing side: agents don't slurp the whole roster each cycle — they run `./agent.sh peers` and read a peer through the tool **on demand** (the generated agent context says so), so wide availability never inflates any agent's context. This replaces the earlier subscribe model: subscriptions bounded what got mirrored to bound what an agent read; pull-on-demand bounds reading directly, so mirroring can be universal and the "forgot to subscribe" silent miss disappears. The human still sees every agent via `quimby status`. The split is deliberate: **directed** work is pushed (a `handoff` parcel + nudge); **ambient** status is pulled (a peer-status peek).

The server also **auto-dispatches queued parcels**: on the same poll cycle it scans each agent's `out/queued/` and carries any _settled_ parcel to its recipient — the automatic twin of `quimby dispatch`, so a reviewer's authored parcel is enacted without a human relaying it. The partial-write race is prevented **by construction**: agents author under the unscanned `out/draft/` and publish with one atomic `mv` into `out/queued/`, so a parcel appears in the queue complete or not at all. The settle-debounce is kept as a cheap **fallback** (protecting an agent that writes directly into `out/queued/`, skipping draft): a parcel is dispatched only once its newest file has been unchanged for a full poll cycle. An atomically-published parcel lands complete and settles in one cycle, so net latency is ≤1 poll cycle. Each exact parcel version is attempted at most once, so a bounced (unknown recipient) or failed carry never retries in a loop, and a re-authored parcel (new mtime) is treated as fresh. A running recipient is nudged, exactly as with manual dispatch. Dispatch (directed, discrete parcels) and status mirroring (ambient status) are orthogonal channels; auto-dispatch is on by default, and `quimby serve --no-dispatch` disables it, leaving only status mirroring.

### Which parcels wake an agent (`nudge`)

By default only work the graph aims at an agent wakes it: a `directs` handoff, an honored escalation, or a reply to its own question. Routine peer chatter lands passively — read on the recipient's own turn. The `nudge` policy changes that, and the **recipient's** setting governs, since it is the one being interrupted:

```yaml
nudge: directed # workspace default (all | directed | never)

roles:
  builder:
    nudge: all # every parcel wakes a builder…
presets:
  default:
    agents:
      review2:
        nudge: never # …while this one is never interrupted
```

- **`all`** — every delivered parcel wakes the recipient, advisory notes included. This is the "keep the fleet moving unattended" setting: work continues overnight with nobody relaying.
- **`directed`** (default) — only directed / escalation / reply, per §6a.
- **`never`** — nothing wakes it; parcels still arrive and are read on its next turn.

Resolution is recipient's own setting → its role → the workspace default → `directed`. It is stored on agent state and refreshed by `quimby sync`, exactly like the coordination edges, so a config edit reaches a live agent without a rebuild. (`always` and `focus` are accepted as legacy spellings of `all` and `directed`.) A parcel that arrives without waking anyone now says so, and a refused escalation names the missing edge — silence there is indistinguishable from a broken courier.

Human-initiated verbs are unaffected: `quimby assign`, `handoff`, and `delegate` follow their own nudge rules, because you naming one agent is already the decision to interrupt it.

### `whenFocused` — what a nudge does when it lands on the pane you're typing in

**Separately, quimby holds a nudge aimed at the one pane you are actively working in.** That guard is about not clobbering live keystrokes, not about how much work interrupts you: it holds exactly one window and releases the moment you look elsewhere (or after three minutes without a keystroke, so an idle overnight pane never holds forever). It matters for a dashboard, which attaches a client to _every_ pane it shows (and for an SSH agent each tab is a real `ssh … tmux attach` onto the agent's own session), so a session-wide check would hold an entire layout. A bare `quimby run <agent>` in a plain terminal still holds; `quimby nudge <agent>` forces.

`nudge` does **not** govern this — that gate is settled before the guard runs, so `nudge: all` means "every parcel is worth waking this agent for" and the guard may still hold the keystroke. The `whenFocused` key is the separate answer, resolved recipient-first exactly like `nudge`:

- **`directed`** (default) — **derive it from the authority graph**: an agent something `directs` is machine-driven, so a nudge types even into the pane you are watching; an agent nobody directs is the one you converse with, so it holds. This is the inverse-of-`directs` idiom escalation already uses.
- **`hold`** — always stand down; the work is already in the inbox, so the agent picks it up on its next turn, and the held nudge flashes that pane's status line.
- **`nudge`** — always type, even into the agent you converse with.

The derived default is what makes a supervised fleet need no per-agent config. In a `principal → manager → workers` chain only the principal holds, so "wake all but the one I talk to" is stated once by the graph you already declared, and adding a worker needs no config edit:

```yaml
# nothing to declare — the graph already says which agent you talk to
presets:
  fleet:
    agents:
      principal: { role: principal, directs: [manager] }
      manager: { role: manager, directs: ['@builder'] }
      builder: { role: builder, count: 6 }
```

A two-agent project where you converse with neither says so in one line:

```yaml
nudge: all
whenFocused: nudge
```

Resolution is the recipient's own setting → its role → the workspace default → `directed`, stored on agent state and refreshed by `quimby sync` like the coordination edges. `quimby serve` reports both policies at startup and reads them once, so restart it after an edit.

Two knobs because they answer different questions — which parcels are worth waking you for (`nudge`), and whether typing right now is acceptable (`whenFocused`). Folding them into one word is what made `nudge: all` read as "focus included" when it never meant that.

### `focusGrace` — watching is not typing

"The pane you are working in" means the one you are **typing** in, not the one you are **looking** at. tmux reports `client_activity` as the time of a client's last _input_ — an attached-but-idle client's value stays frozen, and a single keystroke bumps it — so the distinction is exact rather than inferred.

`focusGrace` (default **45s**) is how long after a keystroke a pane still counts as yours. It was a hardcoded 180s, which meant supervising an agent — type a correction, then watch it work — held its nudges for three minutes after every keystroke, and held forever if you interjected periodically. Raise it if you compose slowly: too short is the dangerous direction, because a nudge landing while you pause mid-prompt appends to your draft and submits it.

```yaml
focusGrace: 90s # a bare number is MINUTES, so write the unit when you mean seconds
```

**A conflict nudge is never held.** When a `sync` or `merge` fails on a rebase conflict, quimby offers to send the agent the "rebase onto `<ref>` and resolve conflicts" request, forced — it is the direct answer to a command you just ran. Interactive runs ask first (`y/N`, default yes) and print the ready-to-paste `quimby nudge …` if you decline; non-interactively `merge` fires it while `sync` only prints, since waking an agent onto a conflicted baseline stays your call.

### Agent-side mechanics (`agent.sh`)

The comms conventions above are enacted **inside** the sandbox by the agent, and several of the steps are fiddly and silent-failure-prone: assignment/status persistence, the atomic author-then-publish move, the exact `quimby-attest` block with a correctly-keyed `atCommit`, and the inbox received → processed lifecycle. Quimby scaffolds a small **agent-side coordination tool** — `agent.sh` (with a Windows `agent.cmd` twin) — into every agent directory so the agent runs these mechanics reliably instead of hand-formatting them each time. It is regenerated on every launch, so a renamed or updated tool reaches an existing agent with no rebuild; the older `quimby-agent.sh`/`.cmd` names are removed on that same regeneration rather than shimmed, so the agent dir shows only the current tool.

It is written and regenerated exactly like the agent's `CLAUDE.md`/`AGENTS.md` (by `@quimbyhq/template`'s `renderAgentScript`/`renderAgentScriptCmd`, written into the agent dir by the local and remote scaffold paths and `chmod +x`), so a newer tool reaches an existing agent on its next launch. The generated CLAUDE.md points at it as the preferred path, with the prose steps kept as an explicit fallback.

```
agent.sh assignment [set -m msg|--file path|-]
agent.sh status [set|append|done -m msg|--file path|-]
agent.sh handoff <recipient> [-m msg] [--attach agent] [--file path] [--draft]   # reports the commit count + range it carries
agent.sh delegate <recipient> -m msg [--attach agent] [--file path] [--draft]
agent.sh escalate <recipient> [-m msg]   # bounded upward summon — wakes your director (no authority)
agent.sh ask <recipient> -m msg          # a question; opens a reply window
agent.sh reply <recipient> --to <parcel> -m msg   # answer a question, waking the asker
agent.sh publish <recipient>          # publish a parcel drafted with --draft
agent.sh inbox [list | show <p> | done <p> | reopen <p>]  # list / read / mark-processed / restore
agent.sh attest --command CMD --result pass|fail [--summary S]   # append a quimby-attest block, atCommit auto-filled from HEAD
agent.sh peers [name]                 # list peer status mirrors, or read one
agent.sh rebase                       # apply the delivered base (quimby/base); refuses on a dirty tree
```

`inbox` and `inbox show` **name a parcel's attached files** — the listing tags `[+N file(s)]` and the full view prints each path, along with the fact that they sit outside `repo/`. Without that an attachment was invisible unless the sender happened to mention it in prose, which for a parcel whose entire purpose is the attachment is the difference between the feature working and not.

It also **reports what a parcel actually carries** — `carrying N commit(s) (a1b2c3..d4e5f6) + M uncommitted file(s)` — because a parcel is cumulative since `quimby/seed` and a sender who means to hand over one commit routinely hands over six, the rest being work that already landed. That failure has no other gate: a re-sent commit merges without a conflict, so nothing downstream flags it, and one can silently revert a closed decision. When the seed is behind `quimby/base` the tool names that too, since a stale baseline is _why_ the count surprises people. The receiving end sees the same arithmetic — `inbox` tags a parcel `[diff: N commit(s)]`, so the last party who can catch an over-carry before it lands has the number in front of it.

Four properties define its scope:

- **Mechanics, not judgment.** The tool performs the error-prone steps; every judgment call the conventions own — whether and when to send, what to record and where, how to weigh a peer note against your own `assignment.md` — stays in CLAUDE.md. The tool never decides, it only enacts.
- **It never crosses the boundary.** `agent.sh` only ever writes the agent's **own** workspace (assignment/status storage, its outgoing queue, its inbox). Carrying a parcel to a peer, or out to the user's repo, stays the host's job (`quimby dispatch`/`merge`). The agent tool and the host courier stay cleanly separated.
- **A POSIX shell script, so it adds no remote dependency.** It runs where the agent runs, and quimby's guaranteed remote floor is `sh` + `git` + coreutils (git is already a hard remote dependency); Node is **not** — a cheap Ollama/qwen runtime may have no Node at all, and running cheap agents is the point. A shell tool works there for free. The `.cmd` twin covers the one non-POSIX case (a Windows-hosted local agent); it is best-effort, since every remote sandbox is POSIX and the `.sh` is canonical.
- **An optimization, never a replacement.** The tool is DRY where duplication would be fragile: the **host** is always the canonical _parser_ of these formats (in TypeScript), the agent is only ever the _producer_, so there is no second parser to drift — just a producer/consumer contract pinned by a round-trip test. An agent whose runtime lacks `sh`, or that never got the script, still works by following the CLAUDE.md prose.

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
2. Read every agent's `status.md` **concurrently** (local: mtime; SSH: content comparison)
3. Mirror the cycle's changed statuses into **every other agent's** `status/<name>.md` (local or remote) — no subscription filter. Delivery is **batched per recipient** (one call carrying every changed peer) and recipients are written concurrently, so the N×N fan-out costs N round trips rather than N². Serialized one-file-per-round-trip delivery made an 8-agent SSH fleet spend ~16s of every 5s cycle here, overrunning it and delaying the auto-dispatch below. Reporting is one line per source agent (`[builder] status → 7 peer(s)`), with any failed recipient named individually — condensing the success path must not condense away a miss. Each snapshot carries an `Unmerged:` header line — the commits and files that exist only in that agent's clone — because that is the direction of base staleness an agent cannot see for itself (`agent.sh` reports when the base is ahead of _it_, never when a _peer_ is ahead of the base). It is measured only for an agent whose status actually changed, so it stays off the hot path, and it is omitted rather than reported as zero when the repo cannot be read — absence means "not measured", `0` is a claim
4. Scan each agent's `out/queued/`; auto-dispatch any parcel whose newest mtime was unchanged since the previous cycle (settled), then nudge the recipient — skipped entirely under `--no-dispatch`
5. Re-announce any parcels an idle agent still hasn't read (spaced by 10 minutes, and at most 3 **delivered** reminders for an unchanged inbox before it reports the agent as stuck) — the safety net that keeps an unattended fleet from stalling on a lost wake; skipped under `--no-dispatch`. A parcel is never announced **on first sighting**: the sweep is the net for a wake that was lost, and it cannot tell one from a wake another carrier just sent (a CLI `delegate`/`handoff`, or step 4's own wake still inside its bundle window) or deliberately withheld (an advisory parcel under `nudge: directed`). It records the sighting and lets the carrier's rule govern the fresh parcel; anything still unprocessed one interval later is the sweep's business. A reminder the §7 guard **held** delivered nothing, so it neither consumes the cap nor starts the interval: it is retried on the next cycle, landing about one cycle after the human stops typing. Without that, sitting in an agent's pane burned all three reminders without one reaching it, and quimby then went silent and reported a healthy agent as stuck
6. When `pool.idleTimeout` is configured, reap this project's agent sessions idle past it (see [The Agent Pool](#the-agent-pool)) — skipped when unset (the default), and it never touches an attached session

The server writes `.quimby/server.json` (pid, port, startedAt) on startup and removes it on shutdown. CLI commands use this file to detect a running server and display its status.

### Interactive mode (`serve -it`)

`quimby serve -it` (or `--interactive`) starts the server and then stacks a shell on top of it, so `quimby` (and any other) commands run live against the server underneath — one terminal instead of two. The shell owns the terminal, so its own Ctrl+C just interrupts the current command; `exit`/Ctrl+D — or a quick double Ctrl+C — stops the server and quits. (A single Ctrl+C deliberately does _not_ tear the server down, so interrupting a command is never fatal.) The `-it` spelling reads like `docker run -it`.

## Handoff Lifecycle

A handoff is assembled on demand and carried; it is not deposited in any archive. The lifecycle is non-destructive — nothing an agent authored is lost to a failed delivery.

**Attachments (`--file`).** A host → agent handoff can carry arbitrary host files (`quimby handoff <agent> --file <path>`, repeatable). This is the courier's answer to an agent that cannot fetch something itself — a sandbox with no network route to it — and the placement is what makes it safe: an attachment lands in the recipient's **inbox**, outside `repo/`, so git never sees it, no diff can carry it back, and it cannot be committed by accident. `--no-code` sends only the note and the attachments, since handing over a file rarely means "and also everything uncommitted in my checkout". It is host → agent only: the files come from the host's filesystem, so there is nothing coherent to attach them to when the courier is carrying one agent's work to another. Every problem is a **hard** error before anything is carried — a missing path, a directory (parcels are flat), a duplicate basename, or a name a parcel already owns — which is the opposite of the agent-authored draft path, where a bad attachment is skipped and reported: an agent's draft was written earlier and unattended, so refusing the whole parcel would strand the note with it, while a host `--file` was typed by someone standing right there. Attachments are part of the parcel's content hash, so re-sending the same set dedupes and changing one mints a new parcel.

**Direct carry (`quimby handoff`).** Quimby:

1. Resolves the diff. For `handoff A B`, that is A's working tree (committed + uncommitted + untracked) against `quimby/seed` — captured commit-free — or the `--attach` source's, with an optional `--rebase` (sync) first. For `handoff B` (host source), it is the host working tree vs B's seed, squashed. Sender name is the reserved `host`.
2. Validates the recipient against the agent roster. An unknown recipient (a typo) is reported and nothing is carried — it bounces, never silently dropped.
3. Assembles the parcel — note, diff — writes `meta.yaml` **last**, delivers it to `<to>/handoff/in/received/<from>-<hash>/` (local copy or rsync), then discards the staging copy.

**Outbox routing (`quimby dispatch <agent>`).** Agent-authored routing rather than an immediate human move:

- **Authoring (the agent).** Inside its sandbox an agent authors a parcel under `handoff/out/draft/<recipient>/README.md` (the note) plus any files, then **publishes** it with one atomic `mv` into `handoff/out/queued/<recipient>/`. Frontmatter `attach: <agent>` carries that agent's diff instead of the sender's own. The agent decides the routing; the host enacts it.
- **Enacting.** `dispatch` scans `out/queued/` and carries every queued parcel to its addressee. An unknown recipient is **left queued to fix** (bounce). On success the parcel is **moved** to `out/sent/<recipient>/` (timestamped) — the progress ledger: active `out/queued/*` = queued, `out/sent/*` = carried and when. A failed carry leaves the parcel queued for a clean retry.

**Consumption (the recipient).** Parcels sit in `handoff/in/received/` until the agent processes them and moves them to `handoff/in/processed/`. Identity is content-derived, so a re-carried identical parcel overwrites in place rather than piling up.

**Garbage collection.** `out/sent/` and `in/processed/` are caches, not the hot path — bounded by agent lifetime (everything dies with the agent) and pruned by `sync`/`rebuild` rather than a dedicated `gc` verb. `quimby sync` sweeps the `out/sent/` ledger and `in/processed/` archive after it advances the agent (best-effort — a prune failure never fails the sync), leaving active queued/received parcels, `assignment.md`, and `status.md` untouched. One exemption: a processed parcel the agent never **engaged** with — never opened with `inbox show`, never closed by name — is kept rather than swept, because "processed" covers two different things and only one of them is cache. The agent's `handoff/in/.opened` ledger is what tells them apart; `agent.sh inbox` lists any such parcel and `inbox reopen <parcel>` puts it back in the tray. The processed parcels' **names** are appended to `handoff/in/processed.ledger` before they are swept, because the reply-interrupt is authorized by correlation against the inbox — without the ledger, a sync would silently revoke an agent's right to answer a question it had already marked done. `rebuild` clears the whole mailbox anyway. GC is archiving-then-pruning, never silent deletion on carry.

## Merge (crossing the boundary)

`quimby merge <agent>` is the one verb that moves work **out** to the user's real repository. It uses a **merge-based** strategy: the agent's diff is reconstructed on a temporary branch rooted at the agent's seed commit (where it applies cleanly by definition), then merged into the target. The agent is never committed to in the process — capture is commit-free; the commit (if any) happens here, at the boundary.

By default `merge` also brings the agent's base into alignment with the branch at **both ends** (`--no-sync` opts out of both): it **syncs the agent onto the target before landing**, so base-drift conflicts resolve on the agent instead of in your repo, and it **advances the agent's seed after** a clean landing, so the next diff carries only new work. Both ends are gated on merging into the branch the agent tracks; see the two subsections below.

### Merge-based strategy

The agent's diff was generated against its seed. Patching it directly onto a target repo that has moved past the seed fails — context lines don't match, `git apply` aborts, and the user faces a conflict they can't interpret (is it real overlap, or just a stale diff?). The merge-based flow solves this:

1. Stage the parcel in `.quimby/staging/` (diff + patches + meta, same as before)
2. Create a temp branch from the seed commit in the target repo
3. Reconstruct the diff on that branch — guaranteed clean, since the diff is against that exact commit
4. Merge the temp branch into the target

The merge is where git's 3-way machinery kicks in. It knows what the agent changed (seed → temp branch) and what the user changed (seed → HEAD), and merges them with full context about both sides' intent. Conflicts are standard git merge conflicts — resolvable with `git mergetool`, the editor, or any workflow the user already knows. No special quimby commands needed.

### Modes

- **Squashed** — one commit on the temp branch, then a plain (fast-forward-if-possible) merge into the target. When the target is still at the seed this fast-forwards to the agent's own commit — clean linear history, no boundary node. When the target has moved past the seed, git creates a standard merge commit with its default `Merge branch …` message: visibly a merge, and an obvious candidate to rebase away if you want a linear history. (Earlier this forced `--no-ff` plus a parcel-derived merge message, which produced a same-message work-commit + merge-commit pair for every merge — the "duplicate commits" that read as noise.) **You author the squash commit's message**: with no `-m`, git's editor opens prefilled with the agent's own subject (save-quit accepts it, empty aborts). Crossing the boundary is an explicit act, so its one new commit is curated, not auto-stamped.
- **`--commits`** (the built-in default) — replay the agent's individual commits on the temp branch via `git am`, then merge (fast-forward when possible), preserving the agent's commit history in the target. It is **commits-only and idempotent**: it carries only committed commits (patch-id-deduped, so a re-gather lands nothing new), and the agent's **uncommitted remainder is not pulled** — it stays on the agent, reported as a file count with a pointer to `--patch`/`--squashed`/`--commits -m`. It **never synthesizes a commit** from uncommitted work: an agent with no commits (and no `-m`) lands nothing rather than a generic "Apply work from …" commit. `--commits -m "…"` is the explicit opt-in to sweep the uncommitted delta into one trailing commit. The seed-advance is **soft** here (a safe sync that keeps the agent's loose work), so you can pull from a live worker without interrupting it.
- **`--auto`** — pick `--commits` when the agent has committed work since its seed, else `--squashed` (a no-commit worker's whole tree → one commit). The "just do the right thing" mode for mixed fleets; opt-in, never the default (its behavior depends on the agent's commit state).
- **`--patch`** — one commit on the temp branch, merged with `--squash --no-commit`. Changes land in the working tree uncommitted — curate your own commits.
- `-b` lands it on a fresh branch; `-t` targets a repo path other than the cwd.

**Choosing the mode.** An explicit `--commits`/`--patch`/`--squashed`/`--auto` wins (at most one); otherwise the configured `mergeMode` default is used; otherwise `--commits` (the built-in default). The default is set git-style — `quimby merge <agent> --<mode> --default` (or the standalone `quimby merge-mode <mode>`, which sets it without merging) persists it to this repo (`--global` to user config), resolved across the config layers; `--auto --default` persists `auto` (staying adaptive), not the mode it resolved to. `--commits` is the built-in default because its failure is recoverable (some files left for you to commit) where squashed's is destructive (a fresh repo with no config would silently collapse a committing agent's curated history into one mislabeled commit). `--squashed` remains the explicit override of a configured commits/auto default, and the robust choice for a no-commit worker.

The unifying rule: **the boundary never fabricates a commit message.** A commit that lands carries either the agent's own message (`--commits`) or one you author (the squash, or a `--commits -m` remainder). When quimby can't ask you to name a commit it would otherwise synthesize — no `-m` and no TTY — it doesn't invent one: squashed **degrades to `--patch`** (the work lands uncommitted, with the suggested message printed), and `--commits` simply leaves its remainder loose. So the interactive squashed loop opens an editor; scripts fall back to an uncommitted landing; a generic auto-message never reaches your history.

### Conflict handling

On conflict the outcome depends on whether the pre-sync ran, because the two answer different questions about whose repo should hold the mess.

- **Default (pre-sync on).** A same-line overlap that survives the pre-sync fallback is aborted at the boundary: quimby runs `git merge --abort`, so your repo is left untouched — no `MERGE_HEAD`, nothing staged — and resolution is routed back to the agent, which has the code context. This is the "only resolved work crosses" guarantee.
- **`--no-sync`.** No pre-sync ran, so the boundary merge is **left in progress** for you to resolve with standard git tooling and `git merge --continue` — no special quimby command. The staged parcel is kept so a retry doesn't re-download from SSH agents.

If the user instead **abandons** the merge (`git merge --abort`), that staged parcel would linger. There is deliberately no `quimby merge --abort`/`--continue` to clean it up; quimby **auto-heals** instead. The next `quimby merge` (when it stages fresh work) silently clears a leftover staging area **only when no git merge is in progress** in the target — an in-progress merge is the live retry path, so its parcel is preserved. Nothing for the user to remember.

### Syncing the agent onto the target first (on by default)

With multiple agents, a `merge` that crosses from the agent's _old_ seed conflicts often: the branch has accumulated everyone else's landed work since that seed, so the agent's diff — measured against a stale base — textually collides with already-shipped work even where nothing semantically overlaps (context/hunk drift on lines the agent never touched). The merge-based flow is _correct_ regardless (git's 3-way resolves it), but the conflict then lands as a `git merge` in progress in **your** repo, and you — the integration bottleneck — resolve it.

So `merge` first runs the safe pre-sync (`sync`'s non-destructive rebase onto the merge target) **before** it stages the parcel, advancing the merge base to the branch's current tip. That eliminates the stale-base _false_ conflicts by construction; only genuine same-line overlap survives, and it surfaces during the **rebase in the agent's own clone**, which aborts there with the work intact — so a real conflict is resolved on the agent (which has the code context) rather than on the host. A clean pre-sync then makes the boundary crossing a fast-forward, which is exactly the condition the seed post-advance (below) needs, so the clean-landing loop becomes the common case. If the pre-sync brings the agent fully up to date (the work already landed), there's nothing left to carry and `merge` says so cleanly.

**A pre-sync rebase conflict falls back to the boundary merge rather than hard-blocking.** The pre-sync is a _rebase_ (a per-commit replay), which is a strictly harsher test than the boundary merge (git's 3-way of the _net_ change): an intermediate commit can collide with the moved branch even when the cumulative change merges cleanly. Hard-blocking on the rebase would then refuse a merge that would have landed with zero conflicts (exactly the surprise of "no mode works, but `--no-sync` does"). So when the pre-sync rebase conflicts _but rolls back cleanly_ (the agent's repo is left intact — signalled by `SyncConflictError.agentClean`), `merge` does **not** block: it proceeds to stage and attempt the boundary merge, landing like `--no-sync` (seed left put, catch-up hint printed). Only if that 3-way merge _genuinely_ overlaps does a conflict surface — and then `merge` **aborts the tentative host merge** (leaving your repo untouched, no `MERGE_HEAD`, nothing staged) and routes it back to resolving on the agent, exactly the guarantee the pre-sync gave before. The hard block is kept only for the case where the agent's repo is genuinely **wedged** (a pre-existing in-progress merge/rebase or unmerged index, a failed rebase-abort, or a stash-pop conflict — `agentClean` false), where the working tree can't be safely captured; there `merge` reports and points at resolving on the agent without crossing.

The pre-sync is gated on **merging into the branch the agent tracks** — the same gate as the post-advance (no `-b`, no divergent `-t`, `HEAD` at the agent's `syncRef` tip) — so both ends fire together for the ordinary iterate-on-its-branch case and both stand down for a deliberate off-branch merge. `--no-sync` skips it (and the post-advance) — the raw merge, host-side conflict resolution intact. `--rebase` forces it even off-branch.

### Advancing the seed after a merge (on by default)

An agent's diff is always its working tree against `quimby/seed` — **cumulative**. So when you iterate with one agent (merge its work, then ask it for a revision), its next diff still re-contains everything already merged. Re-merging that on a target that now has the earlier work is fragile: the moment the regenerated diff isn't byte-identical to what landed, git flags a conflict on lines the agent never touched. The fix is to advance the agent's seed onto what just landed, so the next diff carries only new work.

`merge` does this automatically on a clean, committed merge (`--no-sync` opts out of the whole alignment — this advance and the pre-sync above; `--sync <ref>` advances _and_ retargets the agent's sync ref to `<ref>`) by running `sync -f` for the agent — but only when it is provably lossless:

- **The merge settled onto the branch the agent tracks**, in the host repo — no `-b`, no divergent `-t`, and `HEAD` resolves to the agent's `syncRef` tip. Otherwise the work isn't on `syncRef`, and advancing would snap the agent to a base that lacks it (reintroducing the cumulative-diff conflicts). A landing-branch or foreign-target merge is a deliberate deferral, so the seed stays put.
- **The agent is unchanged since the snapshot the merge captured** — checked by recomputing the agent's live parcel name (its content hash) and comparing to the merged parcel's. Equal ⇒ identical tree ⇒ the `reset --hard` in `sync -f` loses nothing. If it drifted (the agent kept working), the seed is left alone with a pointer to `quimby sync <agent> --current -f`.

The advance's _mechanism_ follows the mode, mirroring what each mode leaves loose. **Squashed** commits the agent's entire tree, so nothing is left unlanded — it advances with a **hard reset** (`sync -f`) onto what landed, gated on a fully-committed landing (a "clean base hit") and no drift. **`--commits`** lands only the commits and leaves the uncommitted remainder loose, so it advances with a **soft** (safe) sync that _preserves_ that loose remainder on the agent: it pulls the committed work onto the base without discarding the work-in-progress, and without needing the agent idle (the safe sync stashes/pops rather than resets). So a `--commits` merge advances **even with a loose remainder**, and can pull down what a still-working agent produced **without interrupting it**. **`--patch`** (and the no-TTY squashed degrade) commits nothing, so there is nothing to advance past — the work lands loose and the seed stays put. In every case where the seed is _not_ advanced but a standard merge would have — a `--patch`/degrade landing, a condition-skip (`-b`/`-t`/off-branch, or drift on a hard advance), or `--no-sync` — `merge` prints the catch-up (`quimby sync <agent> --current -f`) so the agent doesn't silently go stale and walk back into the cumulative-diff trap. The soft advance logs `Advanced "<agent>" seed → <sha> (kept its loose work)`; the hard advance logs it without the qualifier. The celebratory quip fires whenever work settled onto the base (a squashed clean landing or any `--commits` advance), so an integrated landing reads as success and a `--patch`/degrade one reads as "more to do."

### Why merge, not patch

The previous approach applied the diff as a patch directly onto the target's working tree. This failed whenever the target had moved past the seed — which is the common case with multiple agents (you merge agent A's work, agent B's diff is now stale). The patch approach led to a cascade of workarounds: `--3way` mode, classification (settled/drifted/fresh), pre-emption, reduced diffs. The merge-based approach eliminates all of this by letting git do what it does best: three-way merge.

Persisting an agent's work is git's job, reached through merge: `quimby merge <agent> -b feature/x` lands it on a branch you keep. There is no separate "save this work" store.

## Sync Targets

An agent is a _synchronization relationship_, not a checkout. It records two things:

- **`seedCommit`** (mirrored by the `quimby/seed` tag) — the base the agent's work is measured from. A handoff's diff is the agent's working tree against this tag.
- **`syncRef`** — the ref the agent synchronizes against (e.g. `main`, `refs/heads/release`). Defaults to the host branch at `quimby add` time; an explicit `--sync` wins.

- **`quimby/base`** — the tag a sync moves to the resolved target. It is _delivery_: the base is available in the agent's repo whether or not the agent has moved onto it yet.

`quimby sync <agent>` resolves `syncRef`'s tip _in the host repo_ (not the host's live `HEAD`, so syncing is deterministic) and brings the agent onto it, with three behaviors:

- **default (deliver, and apply only when applying is not a rewrite)** — the sync always moves `quimby/base` to the target first. That is one ref write: it touches neither HEAD, the index, nor the working tree, so it cannot disturb in-flight work and runs even for an agent whose repo is wedged. Whether the agent is then _advanced_ onto it depends on what advancing would take:
  - The agent has **no commits and a clean tree** → fast-forward and retag `quimby/seed`. Nothing of the agent's is rewritten, so no SHA it may have recorded (a `quimby-attest` `atCommit`, a parcel's `CommitMeta`) changes meaning.
  - The agent has **commits of its own, or a dirty tree** → the advance is **deferred to the agent**. Its history, its uncommitted work, and its seed are left exactly as they were, and `sync` reports `base delivered … not applied`. The agent applies it with `./agent.sh rebase` when its tree is at a boundary it recognises.

  The split exists because only the agent knows when its floor can safely move. The host has `isDirty()`, which reads the same for "my formatter touched twelve files" and "I am three edits into a refactor" — and the old always-rebase path stashed (`--include-untracked`), rebased, then popped, so a **clean** pop silently reinstated the agent's pre-sync copies on top of work that had just landed. With no conflict and no signal, the agent could then commit a revert of a peer's work inside a commit named after its own feature, and nothing downstream catches that: to git the revert is a deliberate edit, so the boundary merge lands it cleanly. Deferring removes the stash, and with it the resurrection.

  A pre-existing wedge (a merge/rebase in progress, or unmerged index entries) still fails with an actionable error — naming what's blocking, the on-agent undo, `-f` as the hard-reset escape hatch, and a ready-to-paste `quimby nudge` — instead of git's cryptic `needs merge`. The base is delivered before that error, so the agent can see the new base while it resolves. (`-f` skips the gate: it hard-resets, which clears the conflict.)

  Three callers opt back into the rewriting behavior, because each is a deliberate, user-present act on work being harvested right then: `merge`'s pre-sync (so base-drift conflicts surface on the agent rather than in your repo), `merge`'s post seed-advance (without it the next diff re-carries everything that already landed), and the explicit **`--apply`** below.

- **`--apply` (rebase from the host, keeping the work)** — overrides the deferral: stash, replay the agent's commits onto the base, pop. This is the escape hatch for an agent that will not apply its own base — most commonly one whose tree is dirty, since `./agent.sh rebase` refuses there by design, so nudging it can never resolve the deferral until it commits. Without this the only ways out were `-f` (which discards the work) or running `quimby merge` for its pre-sync side effect. It carries the hazard the split exists to avoid — a clean stash-pop can reinstate the agent's pre-sync copies over work that just landed — which is exactly why it stays opt-in and off by default, and why `-f` and `--apply` cannot be combined: they differ on what happens to the agent's work, so the choice is made explicitly rather than by precedence.

- **`-f` (hard)** — `reset --hard` to the base, discarding the agent's commits and working changes — but its **mailbox** (`handoff/`, `status/`, `assignment.md`, `status.md`) is untouched. For "my work shipped; snap me to the latest and keep me in the conversation."
- **`--base <ref>`** — retarget `syncRef` to `<ref>` (persisted), then sync onto it. The way to move an agent to a different branch. (`set --sync` records the ref without syncing.)
- **`--current`** — sugar for `--base <the host's current branch>`, resolved once at call time. The everyday "snap onto where I am" — pair it with `-f` for the most common move after integrating (`quimby sync <agent> --current -f`: drop the agent's now-shipped work and rebase it on the branch you just landed work onto). It still **persists** the resolved branch as `syncRef`, so plain `sync` stays deterministic afterward; only the one-time read of live `HEAD` is implicit, and it errors on a detached HEAD (no branch to track). Orthogonal to `-f`: without `-f` it rebases the agent's work onto your branch; with `-f` it resets. Unlike `--base`, it is allowed with `--all` (retarget every agent onto your integration branch in one call).

`--all` syncs every agent, skipping any with conflicts. Agents created before sync targets existed are migrated on state load: a missing `syncRef` is backfilled from the workspace `sourceRef`. The merge target is independent of `syncRef` — `quimby merge <agent> -t <branch>` lands work wherever you choose.

Every sync also **re-resolves what config declares about the agent** — its `role`, coordination edges (`directs`/`escalatesTo`), `nudge` policy, and charter and writes them onto its state. Those edges are otherwise snapshotted at creation, so editing the graph in `quimby.yaml` would only reach an agent through a rebuild; `sync` makes it the non-destructive path — `quimby sync --all` after a graph edit, and the new edges govern the very next dispatch. Config is authoritative when it declares the agent (a preset entry, or edges on its role): an edge you **removed** is cleared, not merely added to. An agent config names nowhere keeps whatever it has, so hand-set edges survive. `sync` reports `coordination edges updated from config` when anything changed.

Every sync also **re-renders the agent's Quimby-tier scaffold** — `CLAUDE.md`/`AGENTS.md` and the `agent.sh`/`agent.cmd` tool — onto its on-disk agent dir (host, or remote over transport), exactly as a launch does. This is how a **quimby upgrade reaches an in-flight agent**: after upgrading quimby, `quimby sync --all` refreshes every agent's docs/tool to the new version while keeping their work _and_ their live tmux session/sandbox — it never touches the session, `assignment.md`, `status.md`, or the mailbox. The running agent still only _ingests_ the refreshed docs at its next context reset (a `/clear`, or a fresh instance), since neither Claude nor Codex re-reads its instruction files mid-session; `sync` makes the current file ready on disk without forcing a reboot (which is `restart`'s job). The refresh is best-effort across all three sync behaviors (safe/`-f`/`--base`): a write failure never fails the sync.

## Rebuild

`quimby rebuild <agent> --force` recreates the agent: it deletes the agent's repo, re-clones from the current source, **clears its mailbox** (`handoff/` and `status/`), and resets assignment/status to empty/idle. `--force` is required. This is for "this agent is done or broken — start a blank one." When you only want to reset the _code_ but keep the agent in the conversation, `sync -f` is the gentler tool (it leaves the mailbox alone).

For SSH agents, rebuild rsyncs the latest source to the remote, deletes and re-clones the remote repo, retags `quimby/seed`, and clears the remote mailbox.

The mailbox clear is done **in place** — the parcels inside each tray are removed, but the tray directories (and `handoff/in`/`handoff/out` above them) are kept as the same inodes; rebuild never does a blanket `rm -rf handoff` + recreate. This is a virtiofs/9p correctness requirement: an agent's root is often a guest bind-mount, and swapping the `handoff/{in,out}` inodes out from under the guest leaves it holding a **stale dentry** — the directory still lists via `getdents` but `stat` returns `ENOENT`, so the agent's next `mkdir -p handoff/out/draft/<recipient>` (in `agent.sh`) fails and no parcel can be staged until the guest cache is dropped (`sync; echo 2 | sudo tee /proc/sys/vm/drop_caches`, which needs root). Keeping the inodes stable avoids the window. As a backstop, `agent.sh`'s `mkdir` failures name this exact cause and remedy rather than dying on a bare `No such file or directory`, and stronger mount coherence (e.g. virtiofs `cache=none`) is the runtime-side complete fix, since it is outside Quimby's control.

## The Agent Pool

Agents are cheap to create and easy to forget, but a live agent is a running sandbox (an `sbx` container, an SSH tmux session) competing for one machine's resources. Past a point the honest mental model is a **pool** — a bounded set of live workers shared across every project — not a private roster per project. Two facts make the pool invisible without help: `quimby list` only ever sees **this** workspace's agents, while every quimby tmux session — local or SSH, every project — lives on **one shared socket** (`tmux -L quimby`). So the machine can be full of live agents no single `list` reveals.

`quimby sessions` is the pool-wide view. It reads every session on the shared socket and joins each back to the workspace that owns it (by the `qb-<agentId[:8]>` / `qb-dash-<projectId>` / `qbv-<projectId>-<n>` names quimby mints), grouping by project and reporting each session's kind (agent / dashboard / view), attached-vs-idle state, and idle age. A session no workspace claims — its project's `.quimby/` was removed, or the agent was — is an **orphan**: nothing will ever reattach to it, so it is pure waste, surfaced under its own heading. Because the pool is machine-wide, `quimby sessions` works from any directory, inside a quimby project or not.

`quimby sessions prune` reaps. `--idle <2h>` closes agent sessions idle at least that long; `--orphans` closes unclaimed ones at any age; `--here` scopes the sweep to the current project (the default is the whole machine). It previews by default and acts only with `-f`. Two invariants keep it safe: an **attached** session (someone is in `quimby run`) is never selected, and reaping ends only the _process_ — the agent's repo, `assignment.md`, `status.md`, and mailbox are on disk and untouched, so a reaped agent is restarted with `quimby start`/`run` and resumes from its `status.md`. What is lost is the idle session's live context, which is the point of reaping it.

Two `pool:` config keys, both counting sessions **across every project** (that is what actually competes for the machine):

- **`pool.maxLive: N`** — an advisory ceiling. When a `run`/`start` launch would push the live agent count to or past `N`, quimby prints a warning naming the idlest sessions and the prune command, then launches anyway. It is a budget you set for yourself, deliberately **warn-only** — refusing a launch mid-workflow would be worse than the pressure it prevents.
- **`pool.idleTimeout: <30s|45m|2h|1d>`** — opt-in auto-reap. A running `quimby serve` closes **this project's** idle agent sessions past the threshold on its poll cycle (the automatic twin of `sessions prune --idle`, scoped to the server's own project so two servers never fight over the pool). Unset (the default) means the server never reaps — auto-reaping ends a live context, so it is never on without asking.

## diff Semantics

- `quimby diff <agent>` — live diff of the agent's commits against its seed (a preview of what a handoff or merge would carry)
- `quimby diff <a> <b>` — show two agents' diffs side-by-side
- `--stat` — diffstat summary only

Diff operates on agents only. Handoffs are carried, not stored, so there is nothing frozen to diff — preview the live agent instead.

## Key Design Decisions

The full rationale log — every choice and what was rejected — lives in **[design-decisions.md](./design-decisions.md)**. It covers: courier-not-post-office; the one-shape handoff; content-derived names; the explicit-lifecycle `handoff/` tree (no dot-dirs); addressed-out / content-named-in; author-then-publish atomic rename; non-destructive delivery; a verb per movement; directed-handoff-vs-broadcast; the diff as wire format; squashed-merge-by-default; merge-is-a-merge-not-a-patch; merge-advances-the-seed-when-lossless; the-boundary-never-fabricates-a-commit-message; assign-syncs-by-default; server-as-infrastructure; status-mirrors-to-all-with-pull-on-demand; auto-dispatch; `serve -it`; the three coexisting interaction modes; stable-IDs-not-names; the UUID identity and path-hash sandbox naming; SSH lazy init; rsync as transport; tmux-as-universal-substrate and the dashboard viewport; quimby-owns-its-tmux; nudge policy per movement; headless = detached-tmux + nudge; `list` session-state probing; the agent-pool inventory + reaping (`quimby sessions`); the transport abstraction and its never-commit rule; the three levels of "catch up"; `remove --force`; the-layout-only-places-agents; and no-artificial-simplicity.
