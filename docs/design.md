# Design Decisions

## Problem Statement

When orchestrating multiple AI agents across isolated sandboxes (Docker Sandbox, OpenShell, remote machines), the user faces compounding integration problems:

1. **Token exhaustion**: Reusing agent sessions leaves contexts open, burning through tokens
2. **Model flexibility**: Different tasks warrant different models (Opus for architecture, Sonnet for routine, Ollama for cheap exploration) across different compute
3. **Manual orchestration**: The user becomes a messenger relaying problems between agents — builder hits an issue, user manually tells reviewer, reviewer responds, user relays back
4. **Integration bottleneck**: Agent output outpaces human integration bandwidth. Git stash → rebase → stash pop → merge conflicts. The more agents, the worse this gets

`ao` addresses all four by providing a structured protocol for agent work that's transport-agnostic, model-agnostic, and designed around the membrane concept.

## Why Executable Config

Static YAML/JSON can't express conditional launch commands, computed network allowlists, or reusable runtime builders. Following the precedent of Vite (`vite.config.ts`), ESLint (`eslint.config.mjs`), and GitHub Actions (custom action repos), the config is executable TypeScript.

The `defineWorkspace()` pattern provides type safety without requiring users to install the package in their source repo — `jiti` handles the import resolution via alias mapping.

This becomes especially important with remote sandboxes, where launch commands may include SSH connection strings, environment-specific paths, or computed network policies.

## Why Sandbox (not Lane, Track, Cell)

"Lane" was the original working term (from the user's existing worktree-based workflow) but requires explanation. "Sandbox" is universally understood, maps directly to what the thing actually is (an isolated environment), and merges the source tree, runtime, and role into one concept without needing a separate abstraction for the container.

## Why Bundle (not Drop, Handoff, Artifact, Patch)

"Bundle" is concrete (a package of changes), works as both noun and verb without ambiguity ("bundle your changes" = package them up), and doesn't have destructive connotations ("drop a table"). "Artifact" is too long for frequent CLI use. "Patch" is too low-level and overloaded with git terminology.

"Drop" was considered — excellent as a noun ("the latest drop"), but as a verb it sounds destructive ("drop your changes" ≈ "drop a table"). "Handoff" is fine but clinical, and "handoff list" reads awkwardly.

## Why Watch + Copy (not Symlinks)

Symlinks break across container boundaries where filesystem semantics differ. File watching + copying is more robust, especially when sandboxes are Docker containers or remote environments. The orchestrator runs on the host side and handles all file movement.

For remote sandboxes, "copy" becomes "rsync over SSH" — the same directional model, different transport.

## Why Workspace Lives Outside the Repo (with Override)

The workspace is a staging area, not part of the source tree. Keeping it at `~/.ao/workspaces/<name>/` by default maintains clean separation (the "membrane").

However, users with existing worktree-based workflows (e.g., `project/main` + `project/worktrees/`) may prefer the workspace adjacent to their repo. `ao init --workspace ./ao-workspace` or a config-level `workspace.path` supports this.

The config lives in the repo so it's version-controlled and portable. The workspace lives outside by default so it doesn't pollute the project and can be recreated from the config at any time.

A VS Code extension could surface workspace contents regardless of location, but the CLI must work well standalone.

## Why Squashed Apply is Default

Agent commit history is useful context but shouldn't leak into the real repo by default. The membrane concept means the user curates what enters their repository. Squashed apply gives a clean single commit. `--commits` is available when the full history is wanted. `--patch` is available when the user wants to inspect changes before committing.

## Why ao/seed Tag (not Branch Diffing)

A tag is immutable and survives rebases. If we diffed against a branch, the baseline could shift. The tag marks "this is exactly what the sandbox started with" and never moves. The hash is also stored in `workspace.yaml` as a redundant backup.

The tag is also key to the `sandbox refresh` flow — moving `ao/seed` to a new commit is an explicit operation that resets the bundle baseline.

## Why Remote Sandboxes are In-Scope

The user's real workflow already spans machines (SSH to compute nodes, tmux for persistence). Making remote sandboxes first-class rather than an afterthought:

- Prevents architectural decisions that accidentally assume local filesystem access
- Enables heterogeneous compute (GPU boxes, beefy remote machines, cheap local instances)
- Forces the `.sandbox/` protocol to be truly transport-agnostic
- Matches the direction of the ecosystem — agents running on remote infrastructure is the norm, not the exception

The transport layer (local fs vs rsync/SSH) is the only thing that varies. Everything above the transport — assignments, bundles, inbox routing, messages, status — works identically.

## Why the Transport Abstraction

Every interaction between `ao` and a sandbox goes through the transport layer:

```typescript
interface SandboxTransport {
  pushFile(remotePath: string, content: string): Promise<void>
  pullFile(remotePath: string): Promise<string>
  pushDir(localPath: string, remotePath: string): Promise<void>
  pullDir(remotePath: string, localPath: string): Promise<void>
  exec(command: string[]): Promise<{ stdout: string; exitCode: number }>
  watch?(pattern: string, callback: (path: string) => void): Disposable
}
```

Local transport implements this with `fs` operations. Remote transport implements it with `rsync` and `ssh`. The `watch` method is optional — remote transports poll instead.

This means `ao sandbox assign backend "do X"` works the same whether backend is a local Docker container or a sandbox on a remote compute node.

## Cross-Lane Messaging

The user's pain point 3 (becoming a manual messenger) requires more than bundle routing. Agents need to ask questions, report blockers, and receive feedback from other agents.

The `messages/` channel provides this:
- A sandbox writes a message to `.sandbox/messages/outbox/001.md`
- The watcher routes it to the recipient's `.sandbox/messages/from-<sender>/001.md`
- The recipient can read and respond

Messages are structured markdown with YAML frontmatter (type: question/feedback/blocker, priority, references). This keeps the protocol file-based and inspectable.

## Sandbox Refresh

The integration bottleneck occurs when the source repo advances (after applying bundles) but sandboxes are still working against the old baseline. Without refresh, every subsequent bundle from a stale sandbox risks merge conflicts.

`ao sandbox refresh` solves this by:
1. Fetching the latest source state
2. Handling in-progress work (warn, stash, or rebase)
3. Moving `ao/seed` to the new HEAD
4. Resetting the bundle baseline

This is the critical operation that keeps the multi-agent workflow sustainable at scale.
