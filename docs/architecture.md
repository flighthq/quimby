# Architecture

## Overview

`ao` is a CLI tool that orchestrates multiple AI agents working on a single project. Each agent operates in an isolated sandbox with its own copy of the source repo. Sandboxes can be local or remote — different machines, different models, different runtimes — unified by a common file-based protocol. The tool manages sandbox lifecycles, inter-sandbox communication, and the application of completed work back to the user's real repository.

## Directory Layout

### Source Repo (user's project)

```
my-project/
  ao.config.ts          # workspace definition (executable TypeScript)
  src/
  package.json
  ...
```

### Workspace (default: ~/.ao, overridable)

```
~/.ao/
  workspaces.yaml       # registry mapping repos to workspace locations
  workspaces/
    my-project/
      workspace.yaml    # materialized state (snapshot ref, sandbox statuses)
      .git/             # workspace's own history
      sandboxes/
        backend/
          repo/                     # cloned source tree, tagged ao/seed at baseline
          .sandbox/
            assignment.md           # current task
            status.md               # agent's self-reported status
            bundles/
              001-add-auth/
                commits/            # individual .patch files (git format-patch)
                squashed.diff       # combined diff against seed
                meta.yaml           # description, suggested commit msg, deps
            inbox/
              from-frontend/
                001-api-types/      # bundle copied from another sandbox
                  ...
            messages/               # cross-lane dialogue
              from-reviewer/
                001.md              # question or feedback from reviewer
```

### Workspace Location

Default: `~/.ao/workspaces/<name>/`. Overridable:
- `ao init --workspace ./ao-workspace` — adjacent to repo (matches existing worktree workflows)
- Config-level: `workspace: { path: './ao-workspace' }` — relative to repo root
- Environment: `AO_HOME=/custom/path` — moves the entire ao home

The global registry at `~/.ao/workspaces.yaml` tracks all workspaces regardless of location, enabling `ao` commands to resolve the active workspace from CWD.

For users who already structure their work as `project/main` + `project/worktrees/`, the adjacent mode preserves that pattern.

## Config System

The config file `ao.config.ts` uses the `defineWorkspace()` pattern (like Vite's `defineConfig`). It's executable TypeScript — not static YAML — because runtime configuration (network allowlists, launch commands, environment-specific paths) requires logic.

Config is loaded at runtime via `jiti` without a build step. The `defineWorkspace` function is a passthrough that provides type inference and autocomplete.

```typescript
import { defineWorkspace } from 'agent-orchestrator'

export default defineWorkspace({
  source: { ref: 'main' },
  sandboxes: {
    backend: {
      role: 'Backend engineer. Node/TypeScript API layer.',
      runtime: {
        type: 'docker-sandbox',
        launch: ({ sandbox, source }) => [
          'sbx', 'run', 'claude',
          '--network-allow', 'registry.npmjs.org,api.anthropic.com',
        ],
      },
      receives: ['frontend'],
    },
    gpu-worker: {
      role: 'ML pipeline work requiring GPU',
      runtime: {
        type: 'remote',
        host: 'gpu-box.local',
        user: 'dev',
        launch: ({ sandbox }) => ['sbx', 'run', 'claude', ...],
      },
    },
  },
})
```

## Runtime Adapters

Each sandbox has a `runtime` that defines how to launch and manage it. The `launch` function receives a `LaunchContext` and returns an argv array. Built-in adapters normalize this into a `LaunchSpec` (command, args, cwd, env, log paths).

Adapters are resolved by the `type` string:
- `docker-sandbox` — local Docker Sandbox (sbx)
- `openshell` — local OpenShell
- `remote` — sandbox on a remote machine via SSH/rsync

Third-party adapters can be imported in the config file.

### Transport Layer

The transport layer abstracts how files move between the orchestrator and a sandbox:

```
┌─────────────────┐         ┌─────────────────────┐
│  ao (host)      │         │  Sandbox             │
│                 │         │                      │
│  workspace.yaml │ ──push──▶  .sandbox/           │
│  assignments    │         │    assignment.md      │
│                 │ ◀─pull──│    status.md          │
│  bundles/       │         │    bundles/           │
│  inbox routing  │         │    inbox/             │
└─────────────────┘         └──────────────────────┘
```

For local sandboxes, push/pull is filesystem copy. For remote sandboxes, push/pull is rsync over SSH. The `.sandbox/` directory protocol is identical on both ends — the transport is the only thing that changes.

Key transport operations:
- `pushAssignment(sandbox, content)` — write assignment.md into sandbox
- `pullStatus(sandbox)` — read status.md from sandbox
- `pullBundles(sandbox)` — sync bundles/ directory from sandbox
- `pushInbox(sandbox, bundle)` — copy bundle into sandbox's inbox
- `pullMessages(sandbox)` — sync messages/ from sandbox

## Bundle Lifecycle

1. Agent works inside sandbox, commits to local git repo
2. Bundle is created: `git format-patch ao/seed` produces individual patches, `git diff ao/seed` produces squashed diff
3. `meta.yaml` is written last (signals completion to the watcher)
4. Watcher detects the new bundle and routes it to sandboxes that have the sender in their `receives` list
5. User reviews the bundle: `ao bundle review <sandbox> <bundle>`
6. User applies the bundle to their real repo: `ao bundle apply <sandbox> <bundle>`

### Apply Modes

- **Squashed** (default): Single commit with the suggested message
- **`--commits`**: Replays the original commit sequence via `git am`
- **`--patch`**: Applies the diff to the working tree without committing

All modes create a branch `ao/<sandbox>/<bundle>` before applying.

## Seed Ref and Sandbox Refresh

When `ao init` clones the source repo into a sandbox, it tags HEAD as `ao/seed`. This is the baseline that all bundle diffs are computed against. The seed commit hash is also stored in `workspace.yaml` as a backup.

After applying bundles to the real repo, other sandboxes may be working against a stale baseline. `ao sandbox refresh <name>` updates a sandbox:

1. Pull the latest state from the source repo
2. If the sandbox has uncommitted/unbundled work, warn and offer to stash
3. Fast-forward or rebase the sandbox repo to the new baseline
4. Move the `ao/seed` tag to the new HEAD
5. Update `workspace.yaml` with the new seed commit

This prevents the integration bottleneck where agents produce work faster than the user can merge it — stale baselines lead to merge conflicts.

## Communication Model

Sandboxes communicate through the filesystem, mediated by `ao`:

| Channel | Direction | Mechanism |
|---------|-----------|-----------|
| Assignment | orchestrator → sandbox | Write to `assignment.md` |
| Status | sandbox → orchestrator | Agent writes to `status.md` |
| Bundle | sandbox → sandbox | Copy bundle dir to recipient's `inbox/` |
| Messages | sandbox ↔ sandbox | Message files in `messages/from-<sender>/` |

### Auto-routing

`ao watch` monitors `.sandbox/` directories (locally) or polls (remotely) and auto-routes bundles based on the `receives` config. For local sandboxes, the watcher uses chokidar and copies files. For remote sandboxes, the watcher polls via rsync at a configurable interval.

### Cross-lane messaging

For questions, feedback, and dialogue between sandboxes (not just artifact routing), the `messages/` channel provides structured communication. A sandbox can write a question; the watcher routes it to the appropriate recipient. This prevents the user from becoming a manual messenger between agents.

## Workspace Resolution

When a user runs an `ao` command, the tool needs to find the active workspace:

1. Check if CWD is inside a workspace directory
2. Check if CWD is in a git repo mapped in `~/.ao/workspaces.yaml`
3. Error if neither matches

## Scaling Model

The architecture supports heterogeneous compute:

```
┌──────────────────────────────────────────────┐
│  ao orchestrator (user's machine)            │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ local    │  │ local    │  │ remote    │  │
│  │ sandbox  │  │ sandbox  │  │ sandbox   │  │
│  │ (Opus)   │  │ (Sonnet) │  │ (GPU box) │  │
│  │ Docker   │  │ OpenShell│  │ SSH+sbx   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│       │              │              │        │
│       └──────────────┼──────────────┘        │
│              .sandbox/ protocol              │
└──────────────────────────────────────────────┘
```

Different sandboxes can use different models, different runtimes, and different machines. The `.sandbox/` protocol (assignment.md, status.md, bundles/, inbox/, messages/) is the universal interface — the transport layer handles the rest.
