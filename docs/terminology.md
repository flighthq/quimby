# Terminology

These terms are used consistently throughout the codebase, CLI, and documentation.

## Core Concepts

**Workspace** — The top-level materialized structure for orchestrating work on a project. Created by `ao init`, stored at `~/.ao/workspaces/<name>/` by default (overridable with `--workspace` or in config). Contains all sandboxes, their bundles, and communication channels. Has its own git history for tracking orchestration state.

**Sandbox** — An isolated agent environment that merges three concerns into one concept: the source tree copy, the runtime (Docker Sandbox, OpenShell, etc.), and the agent's role. Each sandbox gets its own clone of the source repo, can commit locally, and produces bundles of work. A sandbox may be local or remote — the comms protocol is the same regardless.

**Bundle** — A packaged unit of work output from a sandbox. Contains both a squashed diff and the full commit sequence, plus metadata (description, suggested commit message, dependencies). Bundles are what cross the membrane.

**Membrane** — The conceptual boundary between the workspace (where agents work) and the user's real repository. Work only crosses the membrane through explicit user action (`ao bundle apply`). This is not a CLI noun — it's an architectural concept.

**Assignment** — A task description pushed to a sandbox via `ao sandbox assign`. Written to the sandbox's `assignment.md` file.

**Inbox** — Where a sandbox receives bundles from other sandboxes. Populated automatically by `ao watch` based on the `receives` config, or manually via `ao bundle send`.

**Seed** — The `ao/seed` git tag in each sandbox's repo marking the baseline snapshot. All bundle diffs are computed against this tag. Can be updated via `ao sandbox refresh` when the source repo advances.

**Transport** — The mechanism for moving files between the orchestrator and a sandbox. Local sandboxes use filesystem operations. Remote sandboxes use rsync/SSH. The `.sandbox/` directory protocol is the same on both ends.

## CLI Nouns

These appear as subcommands:

- `ao sandbox` — manage sandboxes (add, list, start, stop, assign, status, refresh)
- `ao bundle` — manage bundles (list, review, apply, send)
- `ao watch` — watch for changes and auto-route bundles
- `ao workspace` — workspace introspection (path, size)

## File Conventions

- `ao.config.ts` — workspace definition, lives in the source repo root
- `workspace.yaml` — materialized workspace state, lives in the workspace directory
- `meta.yaml` — bundle metadata, lives inside each bundle directory
- `assignment.md` — current task for a sandbox
- `status.md` — sandbox's self-reported status
- `squashed.diff` — combined diff of all sandbox work against the seed
- `messages/` — cross-lane message files for questions and dialogue
