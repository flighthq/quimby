# agent-orchestrator

Orchestrate multiple AI agents working on a single project in isolated sandboxes — local or remote.

## Overview

`ao` manages the lifecycle of agent sandboxes, the bundles of work they produce, and the routing of that work back into your real repository. Each agent operates in its own clone of your source repo with a frozen baseline (`ao/seed`). When an agent finishes, you review its bundle and apply it on a clean branch — no stash/rebase churn.

**Core concepts:**
- **Sandbox** — an isolated agent environment with its own source clone, runtime (Docker Sandbox, OpenShell, remote SSH), and role
- **Bundle** — a packaged unit of work: squashed diff + original commit sequence + metadata
- **Seed** — the `ao/seed` git tag in each sandbox marking the baseline all bundle diffs are computed against
- **Membrane** — the boundary between agent work and your real repo; only crossed explicitly via `ao bundle apply`
- **Transport** — how files move between the orchestrator and a sandbox (filesystem for local, rsync/SSH for remote)

## Installation

```bash
npm install -g agent-orchestrator
```

Or use it directly from source:

```bash
npm install
npm run build
```

## Quick Start

1. Add an `ao.config.ts` to your project root:

```typescript
import { defineWorkspace } from 'agent-orchestrator'

export default defineWorkspace({
  source: { ref: 'main' },
  sandboxes: {
    backend: {
      role: 'Backend engineer. Node/TypeScript API layer.',
      runtime: {
        type: 'docker-sandbox',
        launch: ({ sandbox }) => ['sbx', 'run', 'claude'],
      },
    },
    reviewer: {
      role: 'Code reviewer focused on correctness and security.',
      runtime: { type: 'docker-sandbox', launch: () => ['sbx', 'run', 'claude'] },
      receives: ['backend'],
    },
  },
})
```

2. Initialize the workspace:

```bash
ao init
```

3. Start a sandbox and give it a task:

```bash
ao sandbox start backend
ao sandbox assign backend "Add JWT authentication to the /api/users endpoints"
```

4. Watch for completed bundles:

```bash
ao watch
```

5. Review and apply work:

```bash
ao bundle review backend 001-add-auth
ao bundle apply backend 001-add-auth
```

## CLI Reference

```
ao init [repo]                              # create workspace from ao.config.ts
ao sandbox add <name>                       # add a sandbox dynamically
ao sandbox list                             # list sandboxes and status
ao sandbox start <name>                     # start a sandbox runtime
ao sandbox stop <name>                      # stop a running sandbox
ao sandbox assign <name> <task|@file>       # push assignment to sandbox
ao sandbox status [name]                    # show sandbox status
ao sandbox refresh <name> [--force]         # update sandbox baseline after source advances
ao bundle create <sandbox> --id --description --message  # package sandbox work into a bundle
ao bundle list [sandbox]                    # list bundles
ao bundle review <sandbox> <bundle>         # review bundle diff
ao bundle apply <sandbox> <bundle>          # apply bundle to repo (squashed by default)
  --commits                                 #   replay original commit sequence
  --patch                                   #   apply diff without committing
ao bundle send <from> <to> [bundle]         # route bundle to another sandbox's inbox
ao watch [--poll <seconds>]                 # watch + auto-route bundles based on receives config
ao workspace path                           # print workspace directory
ao workspace size                           # disk usage per sandbox
```

## Remote Sandboxes

Sandboxes can run on remote machines. The `.sandbox/` protocol is identical — only the transport changes:

```typescript
export default defineWorkspace({
  sandboxes: {
    'gpu-worker': {
      role: 'ML pipeline work requiring GPU',
      runtime: {
        type: 'remote',
        host: 'gpu-box.local',
        user: 'dev',
        launch: ({ sandbox }) => ['sbx', 'run', 'claude'],
      },
    },
  },
})
```

Remote sandboxes are scaffolded via SSH, polled by `ao watch` at a configurable interval, and communicate via rsync.

## Bundle Apply Modes

All apply modes create a branch `ao/<sandbox>/<bundle>` before touching your repo.

| Mode | Command | Description |
|------|---------|-------------|
| Squashed (default) | `ao bundle apply backend 001` | Single commit with suggested message |
| Commits | `ao bundle apply backend 001 --commits` | Replays original commit sequence via `git am` |
| Patch | `ao bundle apply backend 001 --patch` | Applies diff to working tree, no commit |

## Workspace Layout

```
~/.ao/workspaces/my-project/
  workspace.yaml          # materialized state
  sandboxes/
    backend/
      repo/               # cloned source tree (ao/seed tag at baseline)
      .sandbox/
        assignment.md     # current task
        status.md         # agent's self-reported status
        bundles/
          001-add-auth/
            commits/      # individual .patch files
            squashed.diff # combined diff against seed
            meta.yaml     # description, commit message, deps
        inbox/            # bundles received from other sandboxes
        messages/         # cross-lane dialogue
```

Default workspace location is `~/.ao/workspaces/<name>/`. Place it adjacent to your repo with `ao init --workspace ./ao-workspace` to match worktree-based workflows.

## Development

```bash
npm install
npm run build       # build with tsup
npm run dev         # build with watch
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run test:run    # vitest run (no watch)
```

## License

MIT
