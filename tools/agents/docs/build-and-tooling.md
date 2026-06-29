# Build & Tooling

How the monorepo is compiled, kept consistent, and packaged. Read this before touching `tsconfig.*`, the build scripts, or `scripts/`.

## Build: TypeScript project references (`tsc -b`)

Library packages are **not** bundled with tsup. They compile via TypeScript project references:

```bash
npm run build         # tsc -b tsconfig.build.json  (then tsup for apps/cli)
npm run build:libs    # tsc -b tsconfig.build.json  (libraries only)
npm run typecheck     # tsc -b --noEmit
npm run clean         # tsc -b tsconfig.build.json --clean && rm -rf apps/cli/dist
```

One `tsc -b` walks the dependency DAG, builds each package once, emits `.js` + `.d.ts` together, and writes `.tsbuildinfo` so warm rebuilds only recompile what changed (and its dependents). Cold build ~4s; warm rebuild ~1s.

> Why not tsup for libraries: tsup/esbuild bundles in milliseconds, but it ran a separate `.d.ts` rollup per package with no cross-package caching — that sequential type-emission was the entire cost (~35s cold). Project references share one program and cache incrementally.

### tsconfig layout

- `tsconfig.base.json` — shared compiler options, `composite: true`, and the **centralized `paths` map** (every `@quimbyhq/*` → its `src`). Packages inherit it; they do not redefine `paths`.
- `packages/*/tsconfig.json` — `composite`, `rootDir: src`, `outDir: dist`, `references` to its dependency packages, `include: ["src"]`, `exclude: ["src/**/*.test.ts"]` (tests are typechecked by the root project, not emitted to `dist`).
- `tsconfig.build.json` — `{ files: [], references: [...all 12 packages] }`. The build-graph entry point. **Every new package must be added here** and to the `paths` map in `tsconfig.base.json` (enforced by `packages:check`).
- `tsconfig.json` (root) — `noEmit` monolith including all `src` + tests + `scripts`; what `typecheck` and the editor use. No references (separate invocation from the build graph, so no "file in two programs" conflict).
- `tsconfig.eslint.json` — project for type-aware lint; includes `scripts/**`.

`apps/cli` is **not** in the build graph — it is built by tsup (see Packaging).

## Packaging: private packages, CLI-only ship

All `@quimbyhq/*` packages are `private: true`. They are **dev-time boundaries** (DAG enforcement, isolated maturation, per-package tests), not published npm packages. Only the `quimby` CLI is meant to ship.

`apps/cli` keeps tsup and **bundles** the private packages into the binary:

```ts
// apps/cli/tsup.config.ts
const noExternal = [/^@quimbyhq\//] // inline the workspace packages
skipNodeModulesBundle: true // keep real deps (execa, yaml, …) external
```

This is required, not cosmetic: the library `dist/` that `tsc -b` emits uses **extensionless ESM imports** (`from './fs'`), which Node's ESM loader cannot resolve at runtime. The packages are only Node-runnable once bundled into the CLI. So:

- A published `quimby` must **not** list `@quimbyhq/*` as runtime deps (tsup inlines them); scrub them from the published manifest.
- If a public programmatic API is ever wanted, add **one** curated umbrella package (`@quimbyhq/sdk` — never `core`, which the conventions forbid) re-exporting the stable subset (`types`, `workspace`, `pack`, `agent`), and publish only that + the CLI. Do not publish the leaf packages.

## Governance scripts (`scripts/`, run via `tsx`)

Adapted from the sibling `flight` repo. They make written conventions executable.

| Script | Command | Enforces | In `check`? |
| --- | --- | --- | --- |
| `packages.ts` | `npm run packages:check` | per-package invariants: `src/index.ts` + `tsconfig.json` + `vitest.config.ts` exist; `private: true`; `type: module`; `build`/`typecheck`/`clean` scripts are the `tsc -b` forms; registered in `tsconfig.base.json` paths **and** `tsconfig.build.json` references; internal deps pin `"*"`; export targets resolve to real source | **Yes — gates** |
| `order.ts` | `npm run order:check` / `order:fix` | top-level `describe` blocks in test files are alphabetized | **Yes — gates**; `--fix` reorders |
| `completeness.ts` | `npm run exports:check` | every exported function has a colocated `describe(fnName)` block | **No — informational** |

`order` deliberately covers only `describe` blocks, **not** source-export order: the source-ordering convention is soft ("unless local readability strongly requires"), so it is not hard-gated. `exports:check` is informational because closing every pre-existing coverage gap is out of scope; `--json` mode exits non-zero for opt-in CI enforcement.

Adding a package? `packages:check` will tell you exactly what is missing (`tsconfig.build.json` reference, base-paths entry, scripts, etc.).

## Interactive config & the walkthrough

`quimby config <agent>` and a flag-less `quimby add <agent>` run an interactive walkthrough (`apps/cli/src/walkthrough.ts`, built on `@clack/prompts` — arrow-key selects, numbered labels) that collects an agent's full configuration: runtime, entrypoint, local vs SSH (host/port/base), tmux, sync ref, guard.

- Config is **per-agent** — there are **no** stored workspace-level defaults, so there is a single source of truth (the agent's own state). This is why `config` is effectively an interactive `set`, and why `add` walks through rather than applying saved defaults.
- `quimby add` honors flags when given (skips the walkthrough) so it stays scriptable for unattended use; it only prompts when no config flags are passed.

## tmux

SSH agents always run in a named tmux session for persistence. Local agents can **opt in** via the `tmux` field on `AgentState` (set through the walkthrough / `config`). When set, `quimby run` wraps the local agent in `tmux new-session -A -s <tmuxSessionName>` so the session is reattachable. The session name derives from stable IDs (`qb-<projectId[:8]>-<agentId[:8]>`), so it survives renames.
