# Developing Quimby

A contributor on-ramp. This ties the authoritative references together and shows the common "how do I add X?" paths. It does **not** restate them — when this doc and an authoritative one disagree, the authoritative one wins:

- [`../../CLAUDE.md`](../../../CLAUDE.md) — coding conventions (naming, types, errors, layout).
- [`build-and-tooling.md`](./build-and-tooling.md) — build system, tsconfig layout, governance, packaging. **Read before touching `tsconfig.*`, build scripts, or `scripts/`.**
- [`design.md`](./design.md) — what the thing does and why.

## Mental model

Quimby is an npm-workspace monorepo. The domain is split **one package per capability**, each with a clean dependency boundary; `apps/cli` is a thin command layer over them. There is deliberately no catch-all `core` package — new domains get their own package even when small.

The dependency flow is a DAG, leaves → root:

```
types · errors · utils · paths · reporter · template      (leaves — no quimby deps)
        └─→ git · transport · runtimes · session
                        └─→ workspace
                                └─→ pool
                                        └─→ agent · handoff
                                                └─→ launch
                                                        └─→ server
                                                                └─→ apps/cli
```

A command in `apps/cli` parses args, calls **one operation** in a capability package, then renders the result and enacts CLI-only side effects (tmux `execa`, `process.exit`, the live-session nudge). The domain logic lives in the packages, never in the command. Packages never import consola — they take a `Reporter` (`@quimbyhq/reporter`); the one consola binding lives in `apps/cli/src/reporter.ts`.

## The dev loop

```bash
npm install
npm run build         # tsc -b project references (libs) + tsup (CLI binary)
npm run typecheck     # tsc -b --noEmit
npm test              # vitest run (no watch); npm run test:watch to watch
npm run fix           # order:fix + lint:fix + format — run after editing
npm run check         # packages:check + typecheck + lint + format + order:check — before committing
npm run ci            # build + check + test — the full gate; before broad changes
```

Libraries compile via `tsc -b` project references (fast incremental rebuilds); only the `quimby` binary is bundled (tsup inlines the private `@quimbyhq/*` packages). See `build-and-tooling.md` for why, and for the tsconfig layout you must respect.

## Conventions in one screen

Full rules live in [`../../CLAUDE.md`](../../../CLAUDE.md); the ones you'll hit first:

- **Naming** — exported function names are globally unique and carry the full type name they operate on (`resolveAgentPath`, not `resolvePath`). `get*` accessors; `has*`/`is*` booleans.
- **Types** — `Readonly<T>` for params/stored refs by default. `import type { Foo }` on its own line, never mixed with value imports.
- **Errors** — return sentinels (`null`/`false`/`-1`) for _expected_ failures; `throw` only for programmer errors (precondition violations that should never happen in correct code). The taxonomy is `@quimbyhq/errors`.
- **Imports** — cross-package via the package name (`@quimbyhq/<pkg>`), never a deep relative path; within a package, relative. No `.js` extensions (bundler resolution). Paths use `pathe`.
- **Layout** — exported functions alphabetized; module constants/private helpers at the bottom; no divider comments; comments only where a name can't carry a hidden constraint.
- **Tests** — one `*.test.ts` colocated per source file; `describe` blocks alphabetized, mirroring exported names. `test-files:check` gates on a missing test file.

## How to add a …

### …capability package

1. `packages/<name>/` with `src/index.ts` (barrel), `tsconfig.json` (`composite`, `references` its deps), `vitest.config.ts`, and a `package.json` that is `private: true`, `type: module`, with the `tsc -b`-form `build`/`typecheck`/`clean` scripts and internal deps pinned `"*"`.
2. Register it in `tsconfig.build.json` `references` **and** the `tsconfig.base.json` `paths` map.
3. Run `npm run packages:check` — it names exactly what's missing.

Pick the capability name by what it _does_; don't reach for `utils` (that package is only tiny generic fs/yaml/logger helpers).

### …CLI command

1. `apps/cli/src/commands/<verb>.ts` exporting a module-level `run<Name>Command` function (not inline in `defineCommand`).
2. It parses args, calls **one** package operation, renders via the reporter, and does any CLI-only side effect. No domain logic here.
3. Wire it into `apps/cli/src/cli.ts` (flat subcommand). Follow the CLI grammar `verb target [qualifiers]`; flags are `-x` short + `--xxx` long (`--cmd` is long-only so `-c` stays `--clear`).

### …shared type

Add one PascalCase file per interface under `packages/types/src/` and export it from the barrel. The `types/` listing is meant to read as the API surface.

### …backend-agnostic algorithm

When logic must run over both a local git CLI and SSH-over-transport (sync, parcel assembly), write the algorithm **pure** over a small backend interface (`RepoSyncOps`, `RepoAssembleOps`) and test it against a fake — the local and SSH backends then share one tested algorithm. See `packages/agent/src/syncAlgorithm.ts` and `packages/handoff/src/assembleParcel.ts`.

## Governance (what `check` enforces)

| Script | Enforces | Gates? |
| --- | --- | --- |
| `packages:check` | per-package structure + registration invariants | yes |
| `order:check` (`order:fix`) | `describe` blocks alphabetized | yes |
| `test-files:check` | every logic-bearing source file has a colocated test | yes |
| `exports:check` | additionally, a `describe(fnName)` per exported function | informational |

## Turning an idea into shipped code

The backlog is [`ideas.md`](./ideas.md). To pick one up:

1. **Design it** — if it isn't already a proposal, write one (a section in [`coordination-proposals.md`](./coordination-proposals.md) for agent-coordination ideas, or a "Proposed" section in `design.md` for product features). Record rejected alternatives.
2. **Build it behind the conventions** — one operation in the right capability package, a thin command, colocated tests, `npm run ci` green.
3. **Promote the docs** — move the rationale into `design-decisions.md`, document the behavior in `design.md` + `cli-surface.md`, and flip the idea's status in `ideas.md` to _Shipped_ (then prune it next pass). The living catalog stays forward-looking; the shipped record is the decision log.
