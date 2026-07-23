# Quimby

Orchestrate multiple AI agents working on a single project in isolated environments — local or remote.

Named after Chief Quimby from Inspector Gadget: you dispatch the work, agents deliver, and Quimby hand-carries the briefings in between.

## Overview

Quimby manages the lifecycle of AI agent environments, carries work between them, and controls what crosses the boundary into your real repository. Each agent operates in its own clone of your source repo with a frozen baseline (`quimby/seed`). When an agent finishes, you review its diff and merge it — no stash/rebase churn.

**Core concepts:**

- **Agent** — an isolated environment with its own source clone. Agents run an AI tool (their _entrypoint_) inside a sandbox. They can't see each other — Quimby mediates all cross-agent communication.
- **Handoff** — a parcel Quimby hand-carries from one agent to another (or out to your repo). Contains a note, a diff, or both. Assembled on demand, carried, then discarded — durable history lives in git.
- **Seed** — the `quimby/seed` tag in each agent's repo marking the baseline all diffs are computed against.
- **Boundary** — the line between agent work and your real repo. Work only crosses it through explicit user action (`quimby merge`).
- **Server** — a host-side process that polls agent status and routes updates between agents via subscriptions.

## Installation

```bash
npm install -g quimby
```

## Quick Start

No config file or init command required. The first `quimby add` creates durable workspace storage automatically and links it into the repo as `.quimby/`.

```bash
# Create an agent (runs an interactive walkthrough, or pass flags to stay scriptable)
quimby add backend

# Launch an interactive session
quimby run backend

# Assign a task (wakes the agent via tmux by default)
quimby assign backend -m "Add JWT authentication to the /api/users endpoints"

# Check on progress
quimby status backend

# Preview the work
quimby diff backend

# Merge to your repo (squashed commit on a branch)
quimby merge backend -b feature/auth
```

### Multi-agent workflow

```bash
# Add a second agent
quimby add reviewer

# Carry backend's work to the reviewer
quimby handoff backend reviewer -m "Review this for security issues"

# The reviewer fills its outbox with feedback — deliver it
quimby dispatch reviewer

# Subscribe to get live status updates
quimby subscribe reviewer backend
quimby serve
```

## CLI Reference

All commands follow `verb target [qualifiers]`. Work moves along a few axes:

- **sideways** (agent-to-agent or host-to-agent): `handoff`
- **outbox routing** (agent's authored queue to recipients): `dispatch`
- **out** (agent to your repo, across the boundary): `merge`
- **in** (you to an agent's task): `assign`

### Agents

```
quimby add <agent> [--role <role>] [-H <host>] [--host-alias <alias>] [--port <n>] [-s <ref>]   Create an agent
quimby up <recipe>                                       Create missing agents/subscriptions from config
quimby config <agent>                                     Interactively (re)configure an agent
quimby run <agent> [-c <cmd>] [-r <runtime>]              Launch the agent interactively
quimby set <agent> [-r <rt>] [-c <cmd>] [-H <host>] [-s <ref>]  Update agent config
quimby list                                               Show agents and subscriptions
quimby status [agent]                                     Show agent-written status
quimby assign <agent> -m "..." [--no-nudge]               Set the agent's current task
quimby delegate <agent> -m "..." [-c]                     Send a conditional user-directed task
quimby diff <agent> [agent2]                              Show live diff against seed
quimby nudge <agent> [-m <task>]                          Wake an agent; -m durably assigns first
quimby nudge <agent> --raw -m <text> | --all --raw -m <text>  Type ephemeral session text
quimby sync <agent...> [--all] [-f] [--base <ref>]        Sync agent(s) to their base
quimby rebuild <agent> --force                            Recreate agent from scratch
quimby rename <agent> <new-name>                          Rename agent
quimby remove <agent> [--force]                           Remove agent
quimby restore [--host <alias>] [--id <id>]                Reconnect durable storage after .quimby is lost
quimby storage <path|list|prune|remove>                    Inspect and clean durable workspace storage
```

### Handoffs

```
quimby handoff <from> <to> [-m <note>] [--attach <w>]    Carry work between agents
quimby handoff <to> [-m <note>]                           Carry host's work to an agent
quimby delegate <to> -m <task> [-c]                       Send host-stamped user-directed work
quimby dispatch <agent> [--no-nudge]                      Deliver agent's outbox parcels
quimby merge <agent> [--commits|--patch] [--3way] [-b]    Merge agent work to your repo
```

### Server & Subscriptions

```
quimby serve [-p <port>] [--poll <secs>]                  Start the server (default port 7749)
quimby subscribe <agent> <target>                         Agent receives target's status
quimby unsubscribe <agent> <target>                       Remove subscription
quimby doctor [agent] [-r <runtime>] [--host-alias <a>]   Check local/remote dependencies
```

### SSH Agents

```
quimby add researcher -H user@gpu-box                     Add a remote agent
quimby sync researcher                                    Rsync project to remote
quimby run researcher                                     Sync, init if needed, attach tmux
```

SSH agents are initialized lazily on first `quimby run` — no SSH connection required at add time. Sessions run in named tmux sessions that persist across disconnects.

### Durable storage

Quimby's durable local state lives under your user data directory (`$QUIMBY_DATA_HOME` when set, otherwise `$XDG_DATA_HOME/quimby` or `~/.local/share/quimby`). The project `.quimby/` entry is a link to that durable storage, so a `git clean -xfd` can remove the link without deleting the stored agent state.

```bash
quimby restore                         # relink this repo from the local registry
quimby restore --host remote           # reconstruct state from remote agent storage
quimby storage path                    # show this project's durable storage path
quimby storage list                    # list known durable workspaces
quimby storage prune                   # preview unregistered storage cleanup
quimby storage prune --force           # remove unregistered storage
```

## Merge Modes

`quimby merge` is the one verb that moves work across the boundary into your real repo.

| Mode               | Flag        | Description                                |
| ------------------ | ----------- | ------------------------------------------ |
| Squashed (default) |             | Single commit with combined diff           |
| Commits            | `--commits` | Replays agent's individual commit sequence |
| Patch              | `--patch`   | Applies diff to working tree, no commit    |
| Three-way          | `--3way`    | Merge conflicts instead of aborting        |

Use `-b` to land on a named branch. On conflict the staged parcel is kept and its path reported.

## Configuration

Quimby works without a config file. For shared project workflow, a tracked `quimby.yaml` is the auditable source of team intent: roles, presets, dashboard layouts, runtime profiles, and defaults that it names win over hidden config. Ignored per-checkout config in `.quimby/local.yaml` and user config can add local-only names and fill private machine details such as host bindings, provider URLs, and env without committing worker names, IP addresses, or credentials.

```yaml
runtimeProfiles:
  sbx-claude:
    runtime: sbx
    entrypoint: claude
    args: [--dangerously-skip-permissions]

  openshell-ollama:
    runtime: openshell
    entrypoint: codex
    provider: ollama
    requiredTools: [codex]

roles:
  builder:
    runtimeProfile: sbx-claude
    check:
      command: npm run ci
      verifyByDefault: false

  reviewer:
    runtimeProfile: openshell-ollama

layouts:
  review:
    expr: 'reviewer | (builder integration) / ($ $):30'

recipes:
  review-loop:
    agents:
      builder:
        role: builder
        hostAlias: gpu
      reviewer:
        role: reviewer
      integration:
        role: builder
    subscriptions:
      reviewer: [builder]
      integration: [builder, reviewer]
    layout: review
```

Machine-specific details can layer onto a tracked profile name from ignored `.quimby/local.yaml` or user config. Shared launch fields such as `runtime` and `entrypoint` remain owned by `quimby.yaml` when it defines them; private fields such as provider hosts and env can be filled locally:

```yaml
runtimeProfiles:
  openshell-ollama:
    ollama:
      host: http://gpu:11434

hosts:
  gpu:
    host: me@gpu
```

```bash
quimby add builder --role builder
quimby up review-loop
quimby run --layout review
quimby doctor --host-alias gpu --runtime-profile openshell-ollama
```

Checks are advisory. `--verify` asks the agent to run its configured `check` in its own runtime and record an attestation; `merge` displays that signal but never blocks on it.

## Sync Targets

Each agent records a `syncRef` (the branch it synchronizes against, defaulting to the host branch at add time). `quimby sync` brings the agent onto that ref's latest tip:

- **default** — stashes work, rebases onto the new base, restores. Work is kept.
- **`-f`** — hard reset to the base (drops work, keeps mailbox). For "my work shipped, snap me forward."
- **`--base <ref>`** — retarget to a different branch, then sync.

`rebuild --force` goes further: recreates the agent entirely, clearing its mailbox.

## Communication

Agents run in sandboxes and can't see each other. Cross-agent communication is mediated by Quimby:

**Direct carry** — `quimby handoff` picks up a parcel and hand-delivers it:

```bash
quimby handoff builder reviewer -m "Review this"     # builder → reviewer
quimby handoff reviewer builder -m "Fix the null case"  # reviewer → builder
quimby handoff reviewer -m "Look at my local tweak"   # host → reviewer
```

**Delegation** — when a supervisor should relay the user's task rather than ordinary peer advice, it uses `agent.sh delegate`; the host stamps the delivered parcel as user-directed. From the host, use `quimby delegate <agent> -m "..."`.

**Nudging** — a bare `quimby nudge <agent>` wakes the agent with `continue`. Adding `-m` is an ergonomic alias for `quimby assign`: Quimby persists the new assignment, performs the normal sync, then wakes the agent. Use `quimby nudge <agent> --raw -m "..."` only for intentional ephemeral session input such as a CLI control command. Durable `-m` assignments cannot be broadcast with `--all`; explicit raw session input can.

**Agent-authored routing** — agents stage parcels in their outbox addressed by recipient. `quimby dispatch` carries them all:

```bash
quimby dispatch reviewer    # deliver everything in reviewer's outbox
```

**Live status** — `quimby serve` polls and routes status updates via subscriptions:

```bash
quimby subscribe reviewer backend    # reviewer gets backend's status changes
```

## Workspace Layout

```
my-project/
  .quimby/
    state.yaml                  # workspace state (agents, subscriptions, IDs)
    server.json                 # server pidfile (when running)
    staging/                    # host loading dock (parcels mid-merge)
    agents/
      <agent-id>/               # keyed by stable UUID, not name
        repo/                   # cloned source tree, tagged quimby/seed
        assignment.md           # current task (set by assign)
        status.md               # agent-written status
        CLAUDE.md               # generated agent instructions
        outbox/                 # parcels staged for pickup, addressed by recipient
          <recipient>/
        inbox/                  # parcels delivered by Quimby
          <from>-<hash>/        # a parcel (meta.yaml written last)
          status/               # live status mirrors from subscribed agents
  src/
  package.json
```

## Project Structure

An npm-workspace monorepo split by capability — one package per domain, no catch-all `core`.

| Package               | Path                 | Description                                    |
| --------------------- | -------------------- | ---------------------------------------------- |
| `quimby`              | `apps/cli`           | CLI binary (citty commands, tsup-bundled)      |
| `@quimbyhq/types`     | `packages/types`     | Shared type definitions                        |
| `@quimbyhq/errors`    | `packages/errors`    | Error taxonomy                                 |
| `@quimbyhq/utils`     | `packages/utils`     | Generic helpers (fs, yaml, logger)             |
| `@quimbyhq/paths`     | `packages/paths`     | On-disk and remote layout                      |
| `@quimbyhq/template`  | `packages/template`  | Agent CLAUDE.md generation                     |
| `@quimbyhq/git`       | `packages/git`       | Typed git CLI wrapper                          |
| `@quimbyhq/transport` | `packages/transport` | Local/SSH transport abstraction                |
| `@quimbyhq/runtimes`  | `packages/runtimes`  | Runtime adapters (local, sbx, openshell)       |
| `@quimbyhq/workspace` | `packages/workspace` | State lifecycle (resolve, load, save, migrate) |
| `@quimbyhq/agent`     | `packages/agent`     | Agent lifecycle (add, remove, rename, sync)    |
| `@quimbyhq/handoff`   | `packages/handoff`   | Parcel assembly, delivery, and merge support   |
| `@quimbyhq/server`    | `packages/server`    | HTTP server, status poller, client             |

Dependency flow: types/errors/utils/paths/template → git/transport/runtimes → workspace → agent/handoff → server → apps/cli.

## Development

```bash
npm install
npm run build           # tsc -b project references (libs) + tsup (CLI)
npm run typecheck       # tsc -b --noEmit
npm run fix             # auto-fix lint + formatting
npm run check           # typecheck + lint + format + governance checks
npm run ci              # build + check + test (full gate)
npm test                # vitest (watch mode)
npm run test:run        # single test pass
npm run test:coverage   # coverage report
```

**Tech stack:** TypeScript, ESM, Node 22+, citty (CLI), @clack/prompts (interactive config), tsup (CLI bundling), tsc -b (library builds), execa, consola, vitest.

## License

MIT
