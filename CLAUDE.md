# Agent Orchestrator (ao)

CLI tool for orchestrating multiple AI agents working on a single project in isolated sandboxes — local or remote.

## Design References

@docs/terminology.md
@docs/architecture.md
@docs/design.md
@docs/roadmap.md
@docs/user-workflow.md

## Tech Stack

- TypeScript, ESM, Node 22+
- Citty (unjs) for CLI
- tsup for bundling
- jiti for loading ao.config.ts at runtime
- execa for process spawning
- chokidar for file watching
- consola for logging
- vitest for testing

## Project Structure

- `src/cli.ts` — CLI entry point (citty root command)
- `src/index.ts` — public API (defineWorkspace, type exports)
- `src/commands/` — CLI command implementations
  - `bundle/` — create, list, review, apply, send
  - `sandbox/` — add, list, start, stop, assign, status, refresh
  - `workspace/` — path, size
  - `init.ts`, `watch.ts`
- `src/core/` — business logic
  - `transport/` — SandboxTransport interface, LocalTransport, RemoteTransport
  - `bundle.ts` — create, list, read, apply (direct + via transport)
  - `config.ts` — load ao.config.ts via jiti
  - `inbox.ts` — route bundles between sandboxes (direct + via transport)
  - `messaging.ts` — cross-lane messaging (send, list, parse/serialize)
  - `refresh.ts` — sandbox refresh (advance ao/seed baseline)
  - `registry.ts` — global workspace registry (~/.ao/workspaces.yaml)
  - `sandbox.ts` — scaffold local + remote sandboxes
  - `watcher.ts` — file watcher (local chokidar + remote polling)
  - `workspace.ts` — create, resolve, load/save state
- `src/runtime/` — runtime adapters (docker-sandbox, openshell, remote)
- `src/types/` — type definitions (config, workspace, bundle, message)
- `src/utils/` — utilities (git, fs, paths, yaml, logger, errors)
- `test/` — vitest tests mirroring src/ structure

## Development

```bash
npm install
npm run build         # build with tsup
npm run dev           # build with watch
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run test:run      # vitest run (no watch)
```

## CLI Commands

```
ao init [repo]                              # create workspace from ao.config.ts
ao sandbox add <name>                       # add a sandbox dynamically
ao sandbox list                             # list sandboxes and status
ao sandbox start <name>                     # start a sandbox runtime
ao sandbox stop <name>                      # stop a running sandbox
ao sandbox assign <name> <task|@file>       # push assignment to sandbox
ao sandbox status [name]                    # show sandbox status
ao sandbox refresh <name> [--force]         # update sandbox baseline
ao bundle create <sandbox> --id --description --message  # create bundle from sandbox work
ao bundle list [sandbox]                    # list bundles
ao bundle review <sandbox> <bundle>         # review bundle diff
ao bundle apply <sandbox> <bundle> [--commits|--patch]   # apply bundle to repo
ao bundle send <from> <to> [bundle]         # send bundle to another sandbox
ao watch [--poll <seconds>]                 # watch + auto-route bundles
ao workspace path                           # print workspace directory
ao workspace size                           # disk usage per sandbox
```

## Conventions

- Use the terminology defined in docs/terminology.md consistently
- Config is executable TypeScript (ao.config.ts), not static YAML
- All file paths use pathe for cross-platform consistency
- Prefer the unjs ecosystem (citty, consola, jiti, pathe, defu)
- Bundle meta.yaml is always written last (signals completion to watcher)
- Seed ref is always `ao/seed` tag in sandbox repos
- All sandbox file operations should go through the transport layer (local or remote)
- The `.sandbox/` directory protocol is the universal interface — transport handles the rest
- Design every feature to work identically for local and remote sandboxes
- Core modules expose both direct functions (for local) and `ViaTransport` variants (for remote)
- Tests: every exported function gets a `describe()` block in a corresponding `.test.ts` file
