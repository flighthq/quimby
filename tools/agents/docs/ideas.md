# Quimby — Ideas Catalog (living)

The forward-looking backlog: prospective ideas that are **not yet shipped**. Shipped work lives in [`design.md`](./design.md) / [`design-decisions.md`](./design-decisions.md), not here — when an idea lands, flip its status to _Shipped_ with a pointer and prune it on the next pass. See [`../README.md`](../README.md) for the idea lifecycle.

**Status legend**

- **Proposed** — designed (or sketched); ready to build, not started.
- **Planned** — designed with a build order; committed direction.
- **Partial** — some of it exists (e.g. config declared but the mechanism isn't wired).
- **Blocked** — waiting on an external unknown (an upstream CLI, a decision).
- **Deferred** — deliberately postponed; a cheaper thing covers the common case for now.
- **Rejected (revisit)** — decided against, kept here so the reasoning isn't relitigated.

## At a glance

| # | Idea | Area | Status | Detail |
| --- | --- | --- | --- | --- |
| A1 | `agent.sh wake` — one orientation entry point | agent tool | Proposed | [coordination-proposals §1](./coordination-proposals.md) |
| A2 | `agent.sh rebase` — guarded conflict driver | agent tool | Proposed | [§2](./coordination-proposals.md) |
| A3 | `agent.sh scratch` — per-agent artifact store | agent tool | Proposed | [§3](./coordination-proposals.md) |
| A4 | `agent.sh checkpoint` — recurring savepoint | agent tool | Proposed | [§4](./coordination-proposals.md) |
| A5 | `inbox show`/`list` retry + reconcile-on-wake | agent tool | Proposed | [§1](./coordination-proposals.md) |
| B1 | `commons/` — read-only shared references | cross-agent | Proposed | [§5](./coordination-proposals.md) |
| B2 | Directed relationships — the `directs` edge | cross-agent | Partial | [§6](./coordination-proposals.md) |
| B3 | Enriched status mirror (peer work summary) | cross-agent | Proposed | [§6](./coordination-proposals.md) |
| B4 | Attached-session nudge rule (don't paste over the user) | cross-agent | Proposed | [§7](./coordination-proposals.md) |
| B5 | `handoff <agent> host` — deliver an artifact to the user | cross-agent | Proposed | this file |
| C1 | VS Code: single-driver server lease | vscode/server | Planned | [follow-up-todo](./follow-up-todo.md) |
| C2 | VS Code: run the server out-of-process | vscode/server | Planned | [follow-up-todo](./follow-up-todo.md) |
| C3 | VS Code: agent editor UI beyond terminal tabs | vscode | Proposed | [follow-up-todo](./follow-up-todo.md) |
| C4 | VS Code: resolve `quimby` binary from ext host PATH | vscode | Proposed | [follow-up-todo](./follow-up-todo.md) |
| C5 | VS Code: opt-in suppress shell-integration badge | vscode | Proposed | [follow-up-todo](./follow-up-todo.md) |
| D1 | `quimby layout --json` — shared plan API | tooling | Planned | [design.md](./design.md), [cli-surface.md](./cli-surface.md) |
| D2 | `@quimbyhq/sdk` — curated public umbrella package | packaging | Proposed | [build-and-tooling.md](./build-and-tooling.md) |
| E1 | `execSpec` in-sandbox verification guard | runtimes | Deferred | this doc |
| E2 | Merge ledger (`{agent, parcelHash, landedCommit}`) | merge | Deferred | this doc |
| E3 | openshell/sbx provisioning parity | runtimes | Blocked | this doc |
| E4 | Windows host audit (shell/quoting/tmux/rsync) | platform | Open | [follow-up-todo](./follow-up-todo.md) |
| R1 | Shared **mutable** drive all agents write to | cross-agent | Rejected (revisit) | [§5](./coordination-proposals.md) |
| R2 | `agent.sh commit` (enforced message policy) | agent tool | Rejected (revisit) | [§4](./coordination-proposals.md) |
| R3 | `assign --status <agent>` | CLI | Rejected | this doc |

---

## A. Agent-side coordination tool (`agent.sh`)

The tool enacts mechanics; judgment stays in the generated CLAUDE.md. Full designs in [`coordination-proposals.md`](./coordination-proposals.md); the throughline is **durable files are the source of truth, the nudge is advisory**.

- **A1 · `agent.sh wake` — one orientation entry point.** _Proposed._ A single command the wake-up lead points at, emitting an ordered orientation packet (repo-health + carryability, assignment, status, all unprocessed inbox parcels, peers). Name-independent, so it dissolves the announce/parcel visibility race and shrinks the model's routing surface.
- **A2 · `agent.sh rebase` — guarded conflict driver.** _Proposed._ A state machine (`status`/`start`/`continue`/`abort`) that names where the rebase is and refuses `continue` on an unresolved/unstaged tree. Ends the loop where an agent (notably Codex) reruns `git rebase --continue` and misreads `needs merge`.
- **A3 · `agent.sh scratch` — per-agent artifact store.** _Proposed._ A `scratch/` sibling of `repo/` that survives context resets, never pollutes git, and is never carried unless explicitly handed off. Replaces the `git pack` artifact-smuggling habit.
- **A4 · `agent.sh checkpoint` — recurring verified savepoint.** _Proposed._ Composes the milestone ritual (commit-guard → check → attest → status) as a repeatable in-agent action, distinct from the terminal `status done`. Named `checkpoint`, not `land` (landing = `merge` = host-only). Open call: should it run the check or only guard the ordering?
- **A5 · `inbox show`/`list` retry + reconcile-on-wake.** _Proposed._ Retry the inbox stat over ~1–2s before failing (closing the sandbox guest-mount cache window), and have `wake` reconcile the whole inbox rather than hard-depending on a specific announced parcel name. Draw the transient-vs-loss line at the retry boundary.

## B. Cross-agent channels

- **B1 · `commons/` — host-published read-only references.** _Proposed._ A one-way host→all mirror (file twin of status mirroring) placed as a sibling of `repo/`, so a shared reference is _seen by all_ yet **structurally uncommittable** (outside every git repo) and never carried. Fixes the "agent committed the reference into the wrong repo" failure.
- **B2 · Directed relationships — the `directs` edge.** _Partial._ A one-line, default-deny `directs: [b]` in tracked `quimby.yaml` grants a standing authority edge: `a`'s handoffs to `b` are host-stamped user-directed (reusing the `delegated → userDirected` promotion). **Declared today in this repo's `quimby.yaml` (`review` directs `builder`) but the host does not yet read it** — the build step is teaching the dispatch/handoff path to honor the edge.
- **B3 · Enriched status mirror (peer work summary).** _Proposed._ Fold a work summary (diffstat + recent commit subjects) into each agent's mirrored status, so peers see each other's progress on the existing pull-on-demand channel — the visibility half of directed relationships, decoupled from the authority edge (reads stay open).
- **B4 · Attached-session nudge rule.** _Proposed._ Never `send-keys` into a session a human is attached to; defer/skip it (the parcel is durable, `wake` reconciles it), keeping injection for detached/headless agents where it's the only wake path. Fixes the nudge pasting over the user mid-type.

- **B5 · `handoff <agent> host` — deliver a non-code artifact to the user.** _Proposed._ `host` is already reserved and already a valid parcel **sender** (`quimby handoff <agent>` is host→agent); this is the missing inverse. The gap it fills is real: an agent that produces something **for the human that is not a code change** — a report, an analysis, a CSV, a captured log — has no route today. `merge --patch` lands it uncommitted in the working tree, which works but conflates a deliverable with a code change and puts it in the repo; committing it makes history you may not want; `status.md` is text-only and overwritten. The parcel format already carries arbitrary files (`--file`), so only the destination is missing.

  **The resolution that makes it fit the courier model: date it, drop it, and never track it.** The objection is that a host-side tray is a standing archive, which "courier, not a post office" refuses. It stops being an archive if quimby is **write-only** at the drop point — a date-prefixed directory per delivery (`2026-07-31-105322-review-<hash>/`), sorted by name rather than by an index, with no listing command, no state, no lifecycle and no GC. Two identical sends produce two dated drops, because it is a log of deliveries rather than a set of parcels. If it grows, it is the user's directory to clear, exactly like a Downloads folder.

  **It must NOT land under `.quimby/`.** That is the trap: `.quimby` is frequently a symlink into durable storage, so drops would accumulate inside `~/.local/share/quimby/workspaces/<id>/` — inflating the workspace, riding along in every rsync, and being **deleted by `quimby storage remove`** together with the workspace. Anything inside quimby's own tree becomes quimby's inventory whether the design wants it or not, which is precisely what this idea is trying to avoid. The drop point should be a directory the **user** owns (gitignored, configurable, defaulting to something obvious at the repo root), so no storage verb ever reasons about it.

  Open: the default path and config key; whether `merge --patch` already covers enough of the common case to make this Deferred; and whether the agent-side verb is a plain `handoff … host` or a distinct one, since "deliver an artifact" and "hand work to a peer" differ in that only the latter can be acted on.

## C. VS Code extension

Broad extension design is in [`design.md`](./design.md) ("VS Code Extension"); the concrete pending work and its root-cause diagnosis are in [`follow-up-todo.md`](./follow-up-todo.md).

- **C1 · Single-driver server lease.** _Planned._ Multiple `quimby serve` processes may coexist and poll, but only the elected primary performs the two side-effecting ops (status mirroring, auto-dispatch), arbitrated via a `heartbeat` in `.quimby/server.json`. Removes the "two servers driving one workspace" contention that wedged the extension host.
- **C2 · Server out-of-process.** _Planned._ The extension spawns `quimby serve` as a child process (tracked, killed on `deactivate`) instead of `startServer` in-process, so a server hiccup can't wedge the extension host. Layered on C1 so the child is a warm standby.
- **C3 · Agent editor UI beyond terminal tabs.** _Proposed._ Move past native terminal tabs as the primary agent surface toward structured transcript/state panes with dedicated controls, terminal fallback only where raw TTY interaction is needed.
- **C4 · Resolve `quimby` from the ext-host PATH.** _Proposed._ The extension host's PATH may differ from a login shell; resolve the binary robustly and degrade cleanly when absent.
- **C5 · Suppress the shell-integration badge (opt-in).** _Proposed._ claude-in-tmux breaks VS Code's shell integration; the warning badge is cosmetic, so offer to disable pane decorations.

## D. Shared tooling APIs

- **D1 · `quimby layout --json` — shared plan API.** _Planned._ Resolve a saved layout/preset through the same config semantics as `quimby run --layout` and emit a renderer-neutral JSON plan (cols/rows/tabs, terminal leaves, host/service tokens, weights as hints). Move the layout parser/planner out of `apps/cli` into reusable package code so the CLI and the VS Code extension share one resolver instead of the extension re-parsing the grammar.
- **D2 · `@quimbyhq/sdk` — curated public umbrella.** _Proposed._ If a public programmatic API is ever wanted, publish one curated umbrella re-exporting the stable subset (`types`, `workspace`, `handoff`, `agent`) plus the CLI — never the private leaf packages, and never a `core` package.

## E. Runtime & platform

- **E1 · `execSpec` in-sandbox verification guard.** _Deferred._ `RuntimeAdapter.execSpec` is defined but called nowhere; wiring it would let quimby run a check _inside_ the agent's sandbox (the only place the deps live), unblocking a real pre-handoff/pre-merge guard and sandbox-native headless exec. Deferred in favor of the shipped **cooperative self-attestation** (agent runs its own check, writes a `quimby-attest` block, quimby relays it). Revisit if the cooperative model proves too weak — it needs its own design doc (touches runtimes + a new flow).
- **E2 · Merge ledger.** _Deferred._ Record `{agent, parcelHash, landedCommit, time}` on merge for a precise "did I already merge this?" even for `-b`/`--patch`/`--no-sync` landings (which don't advance the seed). The shipped cheap merge-signal (empty-diff-after-seed-advance) covers the common path; the ledger closes the blind spot.
- **E3 · openshell/sbx provisioning parity.** _Blocked._ OpenShell agents fail auth where `sbx` succeeds; the fix is to match sbx's provisioning/auth flow, but it's **blocked on discovering the exact `sbx`/`openshell` CLI flags** for sandbox naming, reuse, and teardown (those verbs are still settling upstream). Track alongside the runtime `setup`/`teardown` maturity already shipped.
- **E4 · Windows host audit.** _Open._ Beyond platform-aware path defaults, a deliberate strategy for shell assumptions (`bash`, POSIX quoting, `sh -c`), tmux availability, and rsync/OpenSSH packaging on Windows hosts — or explicit unsupported-host diagnostics. The `agent.cmd` twin is best-effort and unverified.

## R. Rejected — kept so the reasoning isn't relitigated

- **R1 · A shared _mutable_ drive all agents write to.** _Rejected (revisit)._ Breaks the isolation the courier model rests on, re-creates the integration bottleneck (concurrent writers → conflict hell — the exact pain Quimby exists to escape), and turns the courier into a post office. The safe slice — shared _visibility_, one writer, N readers — is B1 (`commons/`) and is already mostly met by `repo/`. Revisit only if a genuinely single-writer shared-input need appears that `commons/` can't serve.
- **R2 · `agent.sh commit` with an enforced message policy.** _Rejected (revisit)._ One-line / no- trailer is _one user's policy_; baking it into the shared tool is over-reach. The worthwhile bit — a mechanism fact, that work is carried only from `repo/` on the seeded branch — is surfaced as the carryability warning in `wake`/`checkpoint`/`rebase` instead. Revisit as a `quimby.yaml` config knob if teams ask for enforced agent-side commit hygiene.
- **R3 · `assign --status <agent>`.** _Rejected._ Embedding a peer's status into an assignment was cut — the need is served by the shipped `quimby status <from> --to <agent>` (a one-shot status push), and an assignment is the user's authoritative task, not a place to inline a peer's transient status.
