# Agent Coordination — Proposals (not yet implemented)

This captures a design thread on **mechanizing the agent's coordination routine** and **giving cross-agent needs a sanctioned channel**. Nothing here is built yet — it is proposal, not shipped behavior. Promote each item into the authoritative docs on implementation: mechanics into [design.md](./design.md), the command/flag surface into [cli-surface.md](./cli-surface.md), and the rationale into [design-decisions.md](./design-decisions.md).

## Motivating observations

- **The announce/parcel race.** A parcel is delivered across the machine boundary (rsync into the recipient's inbox) and, separately, the recipient is woken by a `tmux send-keys` injection carrying the parcel name (`quimby · parcel <name> from <agent>`). The wake line can win the race against the file becoming _visible on the recipient side_ — not because the host wrote late (delivery is awaited before the nudge in both `handoffWork` and `dispatch`), but because the agent reads its inbox through a sandbox guest bind-mount (virtiofs/9p) whose dentry/attribute cache lags the host write. This is the same cache-coherence class already handled for `mkdir` in `agent.sh` (the "stale virtiofs dentry" remedy). `agent.sh inbox show <name>` does a single `[ -d ]` stat and hard-`qa_die`s, so a transient miss becomes a reported "announced but not landed, please resend."
- **Agents thrash on rebase conflicts.** The `rebase onto <ref>` recovery lead hands the model a raw git script with no state introspection and no guards. Codex (and others) loop: they can't tell where they are (rebase in progress? markers still present? index unmerged?), run `git rebase --continue` on an unresolved tree, misread `needs merge`, and retry — often leaving the repo half-wedged, which then wedges the _next_ host-side `quimby sync`.
- **Artifact smuggling via git.** Agents write objects into git storage (`git pack`) to pass artifacts between sessions, because no sanctioned channel exists for "a file my next self needs" — and that becomes permanent repo traffic the user must know how to `gc`.
- **The nudge pastes over the user.** When a human is attached (`quimby run`) and typing, an auto-dispatch nudge injects text mid-line and corrupts their input.

## The load-bearing principle

**Durable files are the source of truth; the nudge is advisory. The agent-side tool gathers, orders, and guards; the model decides.** Everything below follows from these two. The tool never resolves a _judgment_ (which conflict side wins, whether to adopt a parcel, what a commit says) — it presents inputs and blocks illegal state transitions. Judgment stays in the generated CLAUDE.md.

---

## 1. `agent.sh wake` — one orientation entry point

The wake-up lead points at a single command instead of routing the model between `inbox show <name>` / `assignment` / `resume from status` by lead kind. `wake` emits an ordered orientation packet:

```
$ ./agent.sh wake
⚠ repo is mid-rebase, conflicts in a.ts, b.ts — resolve with `agent.sh rebase` first
── repo ─────────────  repo/: 4 files changed, on branch `main` (carried) ✓
── assignment ───────  (assignment.md)
── status ───────────  (your last status.md — your handoff to yourself)
── inbox (2 new) ────
  ★ host-stamped user-directed: host-9f3a — "prioritize the null-case fix"
    peer note: builder-1c22 — "review my diff" (+diff, 3 files)
── peers ────────────  reviewer(idle) builder(running)  [read one: peers <name>]
```

Why it also fixes the race: `wake` lists **all** unprocessed parcels (`in/received/` minus `in/processed/`), so it is **name-independent** — an early/lost/duplicated announce is self-healing, and the specific-name dependency that hard-`qa_die`s disappears. "N new" derives from durable state, not the announce.

- Subsumes the **orientation** leads (parcel / delegated / assignment-updated / resume). Keeps the **action** lead (`rebase onto <ref>`) separate — that's an instruction to _do_, not orient.
- Keeps the granular verbs (`inbox show`, `assignment set`, `status set`, `peers <name>`) for drill-down; `wake` is additive.
- Surfaces two **mechanism facts** (not policy): repo-health (wedged?) and carryability (which repo/branch you're in, and whether it's the branch Quimby seeds against — the "committed to the wrong repo / branched away and lost the work" guard).
- Backstop even if reconcile isn't enough: `inbox show`/`inbox list` should retry a few times over ~1–2s before dying (closing the guest-cache window), and draw the transient-vs-loss line at the retry boundary — surface a real miss only after the window, when the file truly isn't there.

## 2. `agent.sh rebase` — a guarded conflict-resolution driver

Converts the raw git script into a state machine that names the state and refuses illegal moves. Agent's own repo, no boundary crossing.

```
agent.sh rebase status    → exactly one of: CLEAN · IN_PROGRESS (conflicts: a.ts,b.ts) · READY · WEDGED
agent.sh rebase start     → fetch origin + git rebase origin/<ref>   (<ref> from the lead)
agent.sh rebase continue  → GUARDED (see below), then git rebase --continue
agent.sh rebase abort     → clean rollback, reports work intact
```

The highest-leverage guard is on `continue`, which is where the loop lives. Before running `git rebase --continue` it refuses, with a legible message, unless **both**:

1. `git diff --name-only --diff-filter=U` is empty (nothing still unmerged), and
2. `git diff --check` finds no leftover `<<<<<<<` markers.

> `rebase continue: b.ts still has conflict markers (line 42); a.ts is resolved but unstaged. Fix b.ts, then \`git add b.ts a.ts\`, then retry.`

The tool owns the machinery (fetch/start/continue-guard/abort/status); the model still resolves the conflict _content_. That removes the ambiguity that causes the loop.

## 3. `agent.sh scratch` — a per-agent artifact store (ends git-pack smuggling)

A `scratch/` (or `keep/`) directory as a **sibling of `repo/`** under the agent root, with `agent.sh scratch put|list|get|path`. Its properties fall out of where it lives — outside `repo/`:

- **Survives context resets** — on disk in the agent root; a `/clear` wipes chat, not disk.
- **Never pollutes git** — outside `repo/` ⇒ outside `.git` entirely. Nothing to `gc`.
- **Never accidentally carried** — the seed-diff is `repo/`'s tree against `quimby/seed`; siblings aren't in it. Carried only if the agent explicitly `handoff --file`s it.
- **Bounded by agent lifetime** — cleared by `rebuild`, consistent with courier-not-post-office.

Channels by _who the artifact is for_: next-self → `scratch`; a specific peer → `handoff --file` (already exists). CLAUDE.md steers off git object storage.

## 4. `agent.sh checkpoint` — a recurring verified-milestone savepoint

The closing ritual is **progressive, not terminal** — an agent reaches a coherent, verified state many times per session. `checkpoint` composes: ensure the tree is committed → run the check → attest (`atCommit` auto-filled, already implemented) → update status. Repeatable, stays inside the agent. The genuinely terminal marker remains `status done`.

- Named `checkpoint`, **not** `land` — landing = crossing the boundary = `merge`, which is host-only; an agent can't land its own work, so `land` would imply what it structurally can't.
- Open call: should `checkpoint` _run_ the check (assumes non-interactive, no TTY) or only guard the ordering (commit-before-attest) and leave the invocation to the model?

**Dropped: `agent.sh commit`.** Message format (one-line, no trailer) is _policy_ — another user may want something else — so it belongs in config if anywhere, not baked into the shared tool. The one worthwhile bit is a **mechanism fact**, not policy: work is carried only from `repo/` on the seeded branch, so an agent that branches away silently produces uncarryable work. Surface that as the carryability warning in `wake`/`checkpoint`/`rebase`; don't impose a commit style.

---

## 5. `commons/` — host-published, read-only shared references

For a reference the host wants **every** agent to see but **never** commit (and the observed failure: an agent forgetting which repo it's in and committing the reference into the wrong one).

- Host publishes into `.quimby/commons/` (`quimby share <file>`, or drop files in).
- The server mirrors it **one-way, read-only** into each agent's `commons/` — a **sibling of `repo/`, deliberately outside it** — local copy or rsync. This is the file twin of status mirroring: single writer (host), N readers, no write-back, no conflicts.
- Agent reads via `agent.sh commons list|get|path`.

The out-of-`repo/` placement is the fix, not a detail: the reference is in **no** git repo, so `git commit` cannot pull it in — the wrong-repo commit becomes _structurally impossible_, and it is never in the seed-diff so it is never carried or merged.

**Rejected: a shared _mutable_ drive all agents write to.** It breaks the isolation the courier model rests on, re-creates the integration bottleneck (concurrent writers = stash/rebase/conflict hell — the exact pain Quimby exists to escape), and turns the courier into a post office (a standing, ungoverned, mutable store). The distinction that resolves it: **shared _visibility_ (one writer, N readers) is safe and fits; shared _authorship_ (N writers) is the anti-goal.** Also note most shared-read need is _already met_ by `repo/` — every agent clones it, so anything committed is seen by all; `commons/` is only for shared read-only inputs that must **not** be in the repo.

## 6. Directed relationships — the `directs` edge

Two observed needs are one missing feature seen from two sides: in an "a directs b" arrangement, b should **see** a's work (visibility) and a should be able to **direct** b without the user relaying each order (authority). Declare the edge once; both fall out, each reusing existing machinery.

Declared in tracked `quimby.yaml`, on the director agent in the preset:

```yaml
presets:
  default:
    agents:
      review:
        role: review
        directs: [builder] # the whole feature — one enumerated line
      builder:
        role: builder
```

- **Authority (reuses `delegated → userDirected`).** Today an agent may only `delegate` when the user explicitly asks, because message text must never grant authority — the host stamps `delegated: true → userDirected: true`. A declared edge **is** the user asking, once, durably: within it, the director may direct on its own initiative and the host stamps those parcels `userDirected` _because the edge is host-established, not because the message said so_. Same promotion, gated on a relationship instead of a per-message user action.
- **Visibility, decoupled — stays open.** "b sees a's commits" is shared visibility (one writer), which is safe to leave open; it needs no permission. Solve it by **enriching the mirrored status** with a work summary (diffstat + recent commit subjects — `quimby diff` already computes this), so peers see each other's progress on the existing pull-on-demand channel; the actual code moves via `handoff --attach` (continuous inside a declared edge via auto-dispatch). The `directs` edge governs **authority only** — keeping it single-purpose is what stops it growing into a read/write ACL matrix.

**Right-sizing (explicit but small — these aren't in tension):**

- **Default-deny = purely additive.** No `directs` ⇒ ordinary advisory peer, _exactly today's behavior_. The feature changes nothing until a line is written.
- **Tracked config, no command.** Authority belongs in `quimby.yaml` where it is auditable and reviewable. Deliberately **not** a `quimby direct a b` command: tools auto-write only _ignored_ config, and an authority grant scribbled into ignored local state would be an invisible grant.
- **The list is the whitelist.** Enumeration _is_ default-deny as data.

**Rejected (each fails the test "does a new knob change behavior when nobody sets it?"):**

- **A per-verb permission matrix** (a may delegate, a may see diffs, …) — speculative surface that does nothing until configured; model exactly the one grant that's needed and add more only when a real second case appears.
- **An imperative `quimby direct` command** — would write to ignored config (invisible grant) and adds surface; hand-authored tracked config is the point.
- **Prose as permission** (a free-text description gating authority) — the host needs a structured, enumerable fact to decide stamping; English can't gate authority, and reading authority out of message/description text is the "message text never grants authority" line. A `note:`/comment is fine as a _human annotation_ beside the structured edge, never as the mechanism.

## 7. Attached-session nudge rule

**Never `send-keys` into a session a human is attached to.** Quimby already distinguishes `attached` (a client is in `quimby run`) from `running` (detached/headless). When attached, the human is the driver and injection is both a collision (types over their input) and unnecessary — the parcel is durable in the inbox and `wake` reconciles it on the agent's next turn. So an attached-session nudge is **deferred or skipped**; injection stays unchanged for **detached/headless** agents, where it is the only wake path (preserving the keep-awake property). Optionally surface `N parcels held for <agent> (queued while you're attached)`.

This is only safe _because_ of the principle at the top — durable inbox + name-independent `wake` mean a deferred nudge loses nothing. The chattiness half (agents over-handing-off) is also softened by §6's enriched status: agents handoff less when they can _see_ peer progress instead of sending a parcel to report it.

---

## Suggested build order

1. `wake` + inbox retry/reconcile, and the attached-session nudge rule (§1, §7) — they share the durability foundation and kill the race + the paste-over collision together.
2. `agent.sh rebase` (§2) — directly ends the Codex rebase loop.
3. `commons/` (§5) and `scratch` (§3) — the two missing artifact channels; both purely additive.
4. Directed relationships (§6) — the `directs` edge + status enrichment.
5. `checkpoint` (§4) — after deciding the run-the-check question.
