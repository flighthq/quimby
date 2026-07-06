# Follow-up TODO

## Cross-platform and Runtime Resilience

- Done: user-level config/data roots are platform-aware. Linux keeps XDG-style defaults, macOS uses `~/Library/Application Support/quimby`, Windows uses AppData (`Roaming` for config, `Local` for durable data), and explicit XDG/Quimby env overrides still win.
- Done: SSH transport errors distinguish missing local OpenSSH/rsync from unreachable hosts and from missing remote tools, so add/run/restore/doctor surfaces can point at the right machine.
- Done: existing SSH agents always re-check remote `tmux` before launch, not only during first-run provisioning.
- Done: aggregate remote probes in `list` and `status` are bounded by `QUIMBY_REMOTE_PROBE_TIMEOUT_MS` (`QUIMBY_REMOTE_STATUS_TIMEOUT_MS` remains accepted as a compatibility alias). Timed-out remote probes degrade to the normal fallback value and print `remote timeout`.
- Decision: no standard-SSH fallback when remote tmux is unavailable. SSH persistence, reconnect, nudges, logs, and dashboard tabs are built around retained tmux sessions; silently dropping to a raw SSH command would look successful while losing those semantics.
- Decision: no local/host fallback for tmux-managed runs. Foreground local runs remain the non-tmux mode; host shells in dashboards are part of the dashboard tmux view, so missing tmux should fail clearly rather than create a different UI.
- Still open: a full Windows host audit beyond path defaults. Shell assumptions (`bash`, POSIX quoting, `sh -c`, tmux availability, rsync/OpenSSH packaging) still need a deliberate compatibility strategy or explicit unsupported-host diagnostics.

## VS Code Extension (`apps/vscode`)

Context: a debugging session traced the extension's Home / Close-Layout / "crash" symptoms to two things that were **not** layout-logic bugs — (a) the extension host dying or hanging, and (b) invisible state spread across several stacked Extension Development Host windows. The instability's root cause was **two quimby servers driving one workspace at once**: the extension's in-process `@quimbyhq/server` plus a `quimby run` dashboard's `serve` service pane.

- Done: activation is defensively wrapped. `suppressTerminalKillConfirmation` and `startEmbeddedServer` run through a `safely()` helper that logs-and-continues, so one failure can no longer abort `activate` half-initialized (an un-awaited rejection there left the extension partially registered).
- Done: crash instrumentation. `installCrashLogging()` adds `process.on('unhandledRejection')` / `process.on('uncaughtException')` handlers that write a full stack to the Quimby `LogOutputChannel` and keep the host alive, so a future async throw is diagnosable instead of a silent ext-host death.
- Done: a status-bar item (`$(rocket) Quimby` idle / `$(layout) Quimby: <name>` when a layout is open) proves the extension is live in a given window — disambiguating stacked dev-host windows — and gives the layout its only discoverable open/close control (`package.json` contributes no menus or keybindings for the commands).
- Done: Close Layout returns a disposed-count and pops `closed N layout terminal(s)` / `no layout terminals to close`, so the command can no longer read as "no visible effect."
- Diagnosis: `terminal.integrated.confirmOnKill` is window-scoped and already `never` in this environment, so kill-confirmation was never the Close-Layout blocker; the real blocker each time was a dead/hung extension host, or the command being invoked in a different window than the live extension.
- Decision (root cause): **one workspace must not host two _driving_ servers.** The extension's in-process server and a dashboard's `serve` pane both polled the same SSH agents every 5s and both wrote `.quimby/server.json` + the shared `handoff/`/`status/` files. That contention surfaced as the ext host dying ~30–70s after activation and, later, an "Activating extensions" hang where `activate` never completed and no layout auto-opened. Closing the concurrent dashboard made the extension behave as designed.

### Planned: single-driver server coordination (`@quimbyhq/server`)

- Servers coexist; only one **sends**. Every `quimby serve` process keeps polling and maintaining its own read cache (cheap, idempotent, safe to duplicate), but the two side-effecting operations — status mirroring (`deliverStatusSnapshot` to peers) and auto-dispatch (`autoDispatchOutboxes`) — run only on the elected **primary**. Extra servers are warm standbys, never torn down (avoids the "spawn a process only to close it moments later" waste).
- Lease via the existing pidfile. `.quimby/server.json` gains a `heartbeat` timestamp the primary rewrites each poll cycle. Per cycle: hold a fresh lease → send + refresh heartbeat; lease stale or its pid dead → acquire it (write own pid) and become primary; another live + fresh lease → passive this cycle (observe, don't send). `server.json` continues to point CLI clients at the current primary; a new primary rewrites it on failover.
- No hard lock needed. quimby's existing invariants make a brief two-primary failover window safe: status mirrors are idempotent overwrites and parcels are content-hashed + attempt-once, so a momentary overlap can't double-deliver or double-dispatch harmfully. The lease stays simple.
- Uniform by construction. The rule lives in the server package, so a dashboard `serve` pane, a bare `quimby serve`, and the extension's child server all arbitrate identically — no extension-specific coordination logic.
- Tests: lease acquire / heartbeat refresh / failover-on-stale / passive-suppresses-the-two-sends, against the existing poller/autodispatch fakes.

### Planned: the extension runs its server out-of-process

- The extension spawns `quimby serve` as a **child process** (outside the extension host) instead of calling `startServer` in-process, so a server hiccup can never wedge the VS Code extension host again — that is the whole win of moving it out. It tracks the child pid and kills it on `deactivate`. Combined with the lease above, this child is a warm standby that drives only when no dashboard/CLI server is primary.
- Supersedes the current `startEmbeddedServer` (in-process `startServer`) in `apps/vscode/src/extension.ts`.
- The design note that the extension should prefer direct package calls over shelling out still holds for layout/plan resolution; the **server** is the deliberate exception, because out-of-process isolation is the point.

### Still open (VS Code extension)

- Implement the single-driver lease in `@quimbyhq/server` first (keeps the CLI usable at each step), then flip the extension to spawn-and-track a `quimby serve` child.
- Resolve the `quimby` binary from the extension host, whose PATH may differ from a login shell; fall back cleanly if it can't be found.
- Interim guidance until landed: run **either** the extension **or** a CLI `quimby run` dashboard against a given workspace, not both.
- Revisit whether editor-area agent terminals should exit their pane process before `dispose()` — a belt-and-suspenders for Close Layout on hosts where `confirmOnKill` is not `never`.
- Consider an opt-in to suppress VS Code's shell-integration warning badge on tmux/claude panes (`terminal.integrated.shellIntegration.decorationsEnabled: false`): claude-running-inside-tmux breaks VS Code shell integration, and the badge is cosmetic (the Claude Code IDE integration still connects via its `~/.claude/ide/` socket).
- Once the single-driver model and out-of-process server land, migrate their rationale from here into `design-decisions.md` (this section is the pending-work log, not the authoritative decision record).
