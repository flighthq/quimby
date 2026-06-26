# Roadmap

## v0.1.0 — Local MVP (complete)

Working MVP with local sandboxes:

- `ao init` — clones repo, reads `ao.config.ts`, creates workspace, seeds sandboxes with `ao/seed` tag
- `ao sandbox add/list/start/stop/assign/status` — full sandbox lifecycle
- `ao bundle list/review/apply/send` — bundle review and three apply modes (squashed, commits, patch)
- `ao watch` — file watcher with auto-routing based on `receives` config
- Executable `ao.config.ts` with `defineWorkspace()` and jiti-based loading

## v0.2.0 — Transport Layer + Remote Sandboxes (complete)

All items from the original "Next" section are now implemented:

### Transport Abstraction ✓

`SandboxTransport` interface at `src/core/transport/types.ts` with two implementations:
- `LocalTransport` — filesystem operations via `pathe` + `node:fs`
- `RemoteTransport` — rsync/SSH (real implementation, not stubbed)

Factory at `createTransport(workspacePath, sandboxState)` auto-selects based on `host`/`user` fields.

### Remote Runtime Adapter ✓

`remote` runtime type registered in the adapter resolver. Config shape:

```typescript
{
  runtime: {
    type: 'remote',
    host: 'gpu-box.local',
    user: 'dev',
    launch: ({ sandbox }) => ['sbx', 'run', 'claude', ...],
  }
}
```

Remote sandboxes:
- Scaffolded via SSH (git clone on remote, .sandbox/ dirs created via transport)
- Watcher polls remote `.sandbox/bundles/` at configurable interval (default 10s)
- Bundles routed between local/remote/mixed sandbox pairs via transport
- `host`, `user`, `port`, `remotePath` persisted in `workspace.yaml` SandboxState

### Sandbox Refresh ✓

`ao sandbox refresh <name> [--force]`:
1. Checks for uncommitted changes and unbundled commits (rejects unless `--force`)
2. Stashes uncommitted changes if forced
3. Fetches latest from source repo via `ao-source` remote
4. Resets sandbox to new baseline, moves `ao/seed` tag
5. Updates `workspace.yaml` with new seed commit
6. Works for both local and remote sandboxes

### Cross-Lane Messaging ✓

`src/core/messaging.ts` — structured markdown files with YAML frontmatter:
- `sendMessage()` — delivers to recipient's `.sandbox/messages/from-<sender>/`
- `listMessages()` — reads all messages, optionally filtered by sender
- Message types: question, feedback, blocker
- Priority levels: low, normal, high
- Auto-incrementing message IDs (001, 002, ...)

### Bundle Creation CLI ✓

`ao bundle create <sandbox> --id <id> -d "description" -m "commit message"`:
- Creates bundle from sandbox's commits against `ao/seed`
- Works via direct git for local, via transport for remote
- Writes meta.yaml last (signals completion to watcher)

### Workspace Commands ✓

- `ao workspace path` — prints workspace directory
- `ao workspace size` — disk usage per sandbox (shows "(remote)" for remote sandboxes)

### Tests ✓

125 tests across 16 test files covering all core modules, utilities, and runtime adapters. Every exported function has a `describe()` block.

### Known Limitations

- `ao init --workspace <path>` not yet implemented (workspace location override)
- Messaging has no CLI commands yet (core API only — like bundle create was in v0.1)
- No message routing in watcher (outbox detection exists but no auto-delivery)
- Remote transport not tested against real remote machines (implementation is complete)
- No integration test for full `ao init` → `ao sandbox start` → `ao bundle create` → `ao bundle apply` flow

## Future

- `ao message send <from> <to> --type <type> --subject "..."` — CLI for messaging
- `ao message list <sandbox> [--from <sender>]` — CLI for reading messages
- `ao init --workspace <path>` — override workspace location
- VS Code extension for workspace visualization
- Model field as first-class config (not just implicit in launch args)
- Coordinator agent mode — an agent that reads all status/messages and dispatches follow-up assignments
- Sandbox templates / presets (reusable runtime configurations)
- Parallel bundle apply with conflict detection
- Bundle dependency graph visualization
