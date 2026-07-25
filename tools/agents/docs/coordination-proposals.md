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

**Implemented** as `agent.sh wake` (POSIX `.sh` only — the `.cmd` twin omits it, and the guest-mount race it heals is a Linux-sandbox concern). The core packet is built: repo-health warning (mid-rebase/merge), an assignment/status preview, the **name-independent** unprocessed-inbox listing (the race fix), and peers. The carryability/branch mechanism-fact line below is the one deferred refinement. `QUIMBY.md` now points at `wake` as the first move on any wake-up.

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
- Backstop even if reconcile isn't enough: `inbox show`/`inbox list` should retry a few times over ~1–2s before dying (closing the guest-cache window), and draw the transient-vs-loss line at the retry boundary — surface a real miss only after the window, when the file truly isn't there. **Implemented** for the name-carrying path: `agent.sh inbox show`/`done` now poll via `qa_await_dir` (default 3 tries ≈ 2s, `QA_INBOX_RETRIES`-tunable) and report "announced but not landed" only after the window. `inbox list` is deliberately left non-retrying (it would add ~2s to the common genuinely-empty check); the coalesced-courier prose instead tells the agent to re-run if the list looks empty right after the wake. The name-independent `wake` (above) remains the fuller fix.

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

### 6a. The same edge gates _interruption_: active vs passive channels

A second, sharper reading of the edge: `directs` also answers _who may interrupt whom_. Split the two ways a message reaches a recipient:

- **Passive** (never interrupts): the status mirror, and _any advisory handoff_. It lands in the inbox and is read on the recipient's own turn. Open to everyone — this is collaboration, and it costs the recipient nothing until it chooses to look.
- **Active** (interrupts — a `tmux send-keys` nudge): a **directed** handoff, i.e. one that travels a `directs` edge (host-stamped `userDirected`). Only these wake a running agent.

So a `directs` edge means "may interrupt on its own initiative" — the _same_ fact as "may direct." This **moves handoff's nudge trigger from note-presence to directed-ness** (superseding the "handoff nudges when a note is present" rule in the nudge-policy decision): a note without authority is passive; authority is what earns the interrupt.

Two operator desires fall out with no extra mechanism:

- _"Only the manager decides when to interrupt a worker."_ The manager is the builder's only inbound edge, so only its parcels nudge; a peer's note or a critic's finding lands passively. The manager keeps the _timing_ lever too — `--no-nudge` queues a directive without interrupting, for "pick this up when you finish your turn."
- _"No one interrupts the principal."_ Nothing `directs` the principal (nothing is above it), so no handoff ever nudges it — reinforced by §7 (you're attached to it). "Never," for free, no special case.

Escape hatches keep this safe to commit to: the **human at the CLI** (`quimby nudge`/`assign`) overrides everything — these rules govern _agent↔agent_ nudges only; and "tell the human a decision awaits" is a _notification to you_ (out-of-band), never an agent nudging into your pane. **Escalation** is the inverse of `directs`, derived (builder→manager, manager→principal, critic→principal); an explicit `escalatesTo: <agent>` overrides it. There is deliberately **no handoff allow-list** — a rare hard partition is a default-OPEN `peers:` deny naming the few forbidden edges, never a per-pair allow-list.

### 6b. Escalation is the active _upward_ channel — summon, not command

The active/passive rule as stated in §6a has a gap: if only _directed_ (downward, authority) handoffs interrupt, an agent with no inbound `directs` edge can never be woken by those below it. That breaks the cheap **manager** — builders don't direct it, so a blocked builder's report lands passively, and an idle manager (a cheap model that acts only when nudged, not a continuous process) never wakes to read it. The coordinator role becomes unreachable from below.

The missing distinction is **summon vs. command**. Directing is downward authority ("do X"); _escalating_ is upward attention ("I need you") — it must interrupt, but grants no authority. A builder must be able to **summon** its manager without **directing** it. So escalation is a third channel: a **bounded, non-authoritative upward interrupt**.

- **`escalate`** (agent-side verb / `--escalate`) marks a parcel as an active upward summon. It nudges the recipient exactly like a directed handoff, but stamps **no** `userDirected` — "wake up and look," not "obey."
- **Bounded to your director.** The host honors the escalation-interrupt only along the _inverse_ `directs` edge — to the agent that directs you (builder→manager, manager→principal) — or an explicit `escalatesTo: <agent>` override. An `--escalate` aimed anywhere else is normalized down to an ordinary advisory (passive), the same non-destructive normalize-don't-reject rule as authority, so escalation never becomes sideways interrupt-spam.
- **Sender-chosen, so routine stays passive.** Only the parcels the builder _chooses_ to escalate wake the manager; progress reports still land passively. This is the "only blockers wake the coordinator" property that keeps the token cost down.

The three channels now cover every direction: **down** = directed handoff (authority interrupt), **up** = escalate (summon interrupt, no authority), **lateral/ambient** = advisory + status (passive). Escalation reuses the existing `directs` graph (its inverse), so there is no new graph — only the `escalate` verb and the optional `escalatesTo` override. It stays safe against the original token/clobbering problem because it is bounded (director only), sender-chosen (routine passive), coalesced (§7a), and aimed at the coordinator's pane, never the operator's.

### 6c. A question expecting a response — request/reply as a correlation, not a new direction

The three channels (§6a/§6b) are fire-and-forget. A **question that expects a response** is a round-trip, and its load-bearing problem is the _return leg_: a cheap idle manager that asks a builder a question and ends its turn is never woken by the answer — the round-trip deadlocks on the async substrate. So the answer must be able to wake the asker.

The resolution: **a reply interrupts the asker by _correlation_, not by edge** — authorized by "you asked," a one-shot per-exchange grant, never a standing relationship.

- The **question** goes out on whatever channel its direction warrants (manager→builder = directed, interrupts; a builder's _blocking_ question upward = escalate; a lateral question = passive unless escalated), marked `expectsReply` — "open a reply window; I'll want to be woken by the answer." `ask` is _not_ a new interrupt channel: the question's own interrupt still follows the §6a/§6b rules.
- The **reply** carries `replyTo: <question>`. The host honors an interrupt back to the asker **because the asker opened the exchange** — even across an edge the answerer could not otherwise interrupt (a builder answering its manager). The grant is scoped to that one reply and spent on use; it confers no standing upward-interrupt.
- **§7 still wins:** a reply to an _attached_ asker (e.g. you, in principal) is not injected — it lands in the inbox to read. The correlation authorizes an interrupt; attachment still suppresses the injection.

So request/reply is not a fourth direction — it is a **correlation overlaid on the existing channels**, the answer riding a consent-based, one-shot interrupt home. Safe by construction: bounded (one asker, one reply, only while outstanding), consent-based (the asker asked for it), granting no standing channel, and coalesced (§7a). A never-answered question simply expires (durable, non-destructive, no deadlock — re-ask or escalate). Mechanism: `expectsReply` on the question + `replyTo` on the answer + one host rule (a reply to an outstanding question interrupts the asker, once); `agent.sh ask <recipient>` / `agent.sh reply <parcel>` are sugar, both `handoff` underneath.

### 6d. One mechanism — every interaction but status is the same handoff parcel

None of §6a–§6c adds a delivery pipe. Direct, escalate, ask, reply, and even advisory are all the **one handoff parcel** delivered to an inbox — they differ only by **intent metadata on `meta.yaml`** (`userDirected` / `escalation` / `expectsReply` / `replyTo` / none), which the host reads together with the `directs` graph and the recipient's attachment to decide the nudge. `status` is the sole exception: the continuously-mirrored channel, never a parcel. So "direct" is not even a distinct verb — it is an ordinary handoff the host recognizes as directed _because of the edge_; only `escalate`/`ask`/`reply` set a tag. This keeps the courier's "a handoff is one shape, carrying whichever halves exist" invariant: the interaction shapes are tags on one object, and the interrupt behavior is derived, never a new mechanism.

## 7. Attached-session nudge rule

**Never `send-keys` into a session a human is attached to.** Quimby already distinguishes `attached` (a client is in `quimby run`) from `running` (detached/headless). When attached, the human is the driver and injection is both a collision (types over their input) and unnecessary — the parcel is durable in the inbox and `wake` reconciles it on the agent's next turn. So an attached-session nudge is **deferred or skipped**; injection stays unchanged for **detached/headless** agents, where it is the only wake path (preserving the keep-awake property). Optionally surface `N parcels held for <agent> (queued while you're attached)`.

This is only safe _because_ of the principle at the top — durable inbox + name-independent `wake` mean a deferred nudge loses nothing. The chattiness half (agents over-handing-off) is also softened by §6's enriched status: agents handoff less when they can _see_ peer progress instead of sending a parcel to report it.

### 7a. Coalesce, don't drop — one nudge per poll window

The attached guard defers; it should also **coalesce**. Delivery and nudging are already separable (parcels land in the inbox immediately, losslessly); only the _wake_ is debounced. So a per-recipient pending-nudge accumulates the directed parcels arriving within a poll window and emits **one** nudge ("3 new directives") rather than N. This cuts the token cost (one wake, not three) and the collision surface (one injection, not three) with the same buffer §7 uses to hold-while-attached. Since a nudge only ever means "go look," coalescing loses nothing.

## 8. Fleet management — enable/disable, seat-swap, heterogeneous workers

Running a fleet on one machine, the binding constraint is **live sessions (sandboxes/tmux), not disk**. Three operator needs follow; two are already met, one is new.

**Seat-swap (already supported).** Sub a different engine into a seat — Claude out of tokens → Codex — with `quimby set <agent> --runtime-profile codex-engine` then `quimby restart <agent>`. The agent dir, mailbox, `assignment.md`, and `status.md` are UUID-keyed and stay on disk; only the resolved command changes, and `restart` reboots the session on the new engine, resuming from `status.md`.

**Heterogeneous workers (already expressible).** A role is a _type_, an instance is one worker; the two are already decoupled. Declare multiple preset entries sharing one `role` with different profiles (and `count`s); all instances land in the `@role` layout slot as tabs:

```yaml
builders-claude: { role: builder, runtimeProfile: builder-engine, count: 2 }
builders-codex: { role: builder, runtimeProfile: codex-engine, count: 2 }
```

`@builder` then tabs all four. No new mechanism — the role-slot + `count` + per-entry-profile primitives composing.

**Enable/disable (new).** The one missing piece: temporarily drop a seat from what _runs_ without editing the layout `expr` or losing its work. Because the constraint is sessions-not-disk, disable means exactly: **free the live session, keep everything on disk, exclude the agent from layout placement.**

- `quimby disable <agent>` sets a persistent `AgentState.enabled: false` and **stops** its session (freeing the sandbox/tmux slot). Its repo, mailbox, assignment, and status are untouched.
- `quimby enable <agent>` clears the flag; the next `run`/`start` brings it back, resuming from `status.md`.
- The **layout planner prunes disabled leaves**: a disabled agent named in a layout (directly, or via a `@role` slot) is _skipped_, not a hard error, and a pane left empty by the pruning collapses. So `quimby run` on your saved layout opens exactly the enabled set — "disable one without redoing the whole layout."
- `up` does not recreate or start a disabled agent; `list`/`sessions` show it as `disabled` (distinct from `stopped`, which is transient).

Disable is deliberately distinct from `stop` (transient — a stopped-but-enabled agent is still placed and relaunches on the next `run`) and from `remove` (destructive — clears disk). It is the middle rung the pool needs: _keep the work, drop the footprint._ It composes with `pool.maxLive` — disabling is how you stay under a session ceiling without discarding an agent.

---

## Suggested build order

1. `wake` + inbox retry/reconcile, and the attached-session nudge rule (§1, §7) — they share the durability foundation and kill the race + the paste-over collision together.
2. `agent.sh rebase` (§2) — directly ends the Codex rebase loop.
3. `commons/` (§5) and `scratch` (§3) — the two missing artifact channels; both purely additive.
4. Directed relationships (§6/§6a) — the `directs` edge = authority **and** interruption (active/passive), moving handoff's nudge trigger to directed-ness; coalesce directed nudges (§7a).
5. Fleet management (§8) — enable/disable (new; layout-planner pruning) atop the existing seat-swap and heterogeneous-worker primitives.
6. `checkpoint` (§4) — after deciding the run-the-check question.
