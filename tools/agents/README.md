# Quimby — Agents Documentation

This directory is the home for Quimby's design, developer, and idea documentation. Quimby is a CLI tool for orchestrating multiple AI agents working on one project in isolated environments; see the root [`README.md`](../../README.md) for the product pitch and [`../../CLAUDE.md`](../../CLAUDE.md) for the working conventions.

## Two things live here

1. **How to develop the library** — the architecture, the build/test/check loop, and how to add a package, a command, or a type. Start at [`docs/developing.md`](./docs/developing.md).
2. **A living list of prospective ideas** — everything proposed, planned, deferred, blocked, or rejected-but-worth-revisiting, in one scannable catalog: [`docs/ideas.md`](./docs/ideas.md).

## Document map

| Doc | What it is | Authority |
| --- | --- | --- |
| [`docs/design.md`](./docs/design.md) | Product/architecture design — concepts, behaviors, lifecycles | **Authoritative** (shipped behavior) |
| [`docs/cli-surface.md`](./docs/cli-surface.md) | Complete command + flag reference | **Authoritative** |
| [`docs/design-decisions.md`](./docs/design-decisions.md) | Rationale log — every choice made and what was rejected | **Authoritative** |
| [`docs/user-workflow.md`](./docs/user-workflow.md) | The real multi-agent workflow Quimby is built to support | Context |
| [`docs/build-and-tooling.md`](./docs/build-and-tooling.md) | Build system, tsconfig layout, governance scripts, packaging | **Authoritative** (build) |
| [`docs/developing.md`](./docs/developing.md) | Contributor on-ramp: architecture tour + how to add things | Guide |
| [`docs/ideas.md`](./docs/ideas.md) | **Living** catalog of prospective ideas, with status | Backlog index |
| [`docs/coordination-proposals.md`](./docs/coordination-proposals.md) | Detailed, not-yet-built proposals for agent-side coordination | Proposal |
| [`docs/follow-up-todo.md`](./docs/follow-up-todo.md) | Pending-work log (VS Code extension, runtime resilience) | Work-log |

## The idea lifecycle (what "living" means)

An idea moves left-to-right; the document it lives in changes as it matures:

```
IDEA                 →  PROPOSAL                    →  DECISION            →  SHIPPED
ideas.md (a row)        coordination-proposals.md      design-decisions.md    design.md + cli-surface.md
                        or design.md "Proposed"        (the rationale)        + the code
```

- **Capture** a new idea as a row in [`docs/ideas.md`](./docs/ideas.md) first — even a one-liner.
- **Flesh it out** into a proposal when it's worth designing (a section in [`docs/coordination-proposals.md`](./docs/coordination-proposals.md) for agent-coordination ideas, or a "Proposed"/"Planned" section in `design.md` for product features).
- **When it ships**, migrate the rationale into `design-decisions.md`, document the behavior in `design.md`/`cli-surface.md`, and change the idea's status in `ideas.md` to _Shipped_ with a pointer — then prune it on the next pass. `ideas.md` stays forward-looking; the shipped log is `design-decisions.md`.

This keeps a single, honest answer to "what might we build next?" without letting shipped work and dead ends clutter it.
