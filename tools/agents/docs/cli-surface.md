# Quimby — CLI Surface

The complete command and flag reference. See [design.md](./design.md) for the concepts and behaviors these commands enact, and [design-decisions.md](./design-decisions.md) for the rationale behind them.

## Commands

All commands follow `verb target [qualifiers]`. The first positional is the target — almost always an agent. Work moves along a few axes:

- **sideways**, agent → agent (direct), or host → agent: `handoff`
- **outbox routing**, an agent's authored queue → its recipients: `dispatch`
- **out**, agent → your repo (across the boundary): `apply`
- **in**, you → an agent's task: `assign`

```
quimby add <agent> [-H <host>] [--port <n>] [-s <ref>]   Create an agent; flag-less runs the interactive walkthrough (flags skip it, staying scriptable)
quimby config <agent>                                Interactively (re)configure an agent (runtime, entrypoint, local/remote, tmux, sync)
quimby run <agent> [--cmd <cmd>] [-r <runtime>]     Launch the agent interactively (default entrypoint: claude; local tmux agents attach to a named session)
quimby start <agent> [--cmd <cmd>] [-r <runtime>]   Launch the agent headless in a detached tmux session (idempotent; drive it with assign/nudge, attach with run, stop with stop)
quimby stop <agent>                                  Kill the agent's tmux session (headless or attached); work on disk is untouched
quimby set <agent> [-r <rt>] [--cmd <cmd>] [-H <host>] [--port <n>] [-s <ref>] [--local]   Update agent config (--local converts an SSH agent back to local)
quimby help [command]                                 Root help (grouped, with banner) or usage for a single command
quimby list                                           Show agents and subscriptions (with each agent's live session state: running / attached / stopped)
quimby status [agent] [--to <agent>] [-i]            Inspect agents: no-arg overview (session state, inbox/outbox counts, merge-state, behind-base); with an agent, a digest (assignment, base, work summary, inbox/outbox, status.md excerpt); -i pages the full status.md; `status <from> --to <agent>` pushes <from>'s status snapshot to <agent>'s inbox/status
quimby log <agent>                                   Show an agent's live tmux output (visible screen + scrollback), ANSI-stripped and paged
quimby assign <agent> -m "..." | @file [--sync <ref>] [--no-sync] [--no-nudge] [-c]  Set an agent's current task; syncs the agent to its base first (--sync <ref> retargets to <ref> first; --no-sync to skip), then writes assignment.md and wakes a running agent via its tmux session (--no-nudge to skip); -c/--clear types /clear before the nudge
quimby diff <agent> [agent2]                         Show an agent's live diff against its seed
quimby nudge <agent> [-m "..."] [-c] | --all [-m "..."] [-c]   Wake a running agent by typing a message (default "continue") into its tmux session; -c/--clear types /clear first to reset context; --all broadcasts to every agent with a live tmux session (probed); -m also carries CLI control commands ("/clear", "/model …")
quimby handoff <from> <to> | <to> [-m "..."] [--attach <w>] [--nudge|--no-nudge] [-c]   Carry <from>'s work to <to>; with one arg, the host's work → that agent (nudges the recipient by default only when a note is present); -c/--clear types /clear before the nudge
quimby dispatch <agent> | --all [--no-nudge]         Deliver the agent's queued outbox parcels to their recipients (--all dispatches every outbox; wakes each running recipient via its tmux session by default)
quimby apply <agent> [--commits|--patch] [--3way] [-b] [-t]   Apply the agent's work to your repo (the boundary)
quimby sync <agent...> [--all] [-f] [--base <ref>] [--current]   Sync agent(s) to their base, keeping work (-f hard-resets; --base/--current retarget)
quimby rebuild <agent> --force                       Recreate an agent from current source (discards its work and mailbox)
quimby rename <agent> <new-name>                     Rename agent
quimby remove <agent> [--force]                      Remove agent (destructive — bare warns; --force confirms, and for an SSH agent also skips remote cleanup)
quimby serve [-p <port>] [--poll <secs>] [-it] [--no-dispatch] [--stop]   Start the server (status routing + outbox auto-dispatch); -it stacks a live shell on top; --stop stops the running server and exits
quimby subscribe <agent> <target>                    Agent receives target's status
quimby unsubscribe <agent> <target>                  Remove subscription
```

## Planned (not yet implemented)

```
quimby assign <agent> --status <agent>    Embed another agent's status in assignment
```

### Deferred: a verification guard

An earlier version let each agent carry a `guard` command (e.g. `npm run ci`) that quimby ran before `handoff`/`apply`. It was **removed** because it could not be made honest: quimby is a host-side courier that runs _outside_ the agent's sandbox, while the agent installs its dependencies _inside_ it. So the guard ran in the wrong environment every time — wrong architecture, wrong permissions, missing version-manager PATH — failing on the environment rather than the work. Moving it host-side doesn't help either: the host has no copy of the agent's deps (and a worktree sharing the host's `node_modules` breaks the moment the agent adds a dependency), so the only correct host-side check is a full clean install per apply.

The only place a build is verifiable is where the deps were installed — inside the agent's sandbox. So a guard can return **only** once runtimes expose **headless command execution in the sandbox** (`RuntimeAdapter.execSpec`), letting quimby run the check in the agent's own environment, or once agents **attest** their own result (write the outcome into the parcel `meta.yaml`) for quimby to display rather than re-run. Until then there is no guard: `apply` lands work on a branch (the real boundary) and the user verifies in their normal dev loop, where a dependency change is just a natural `npm install`.

## Flag conventions

All flags support `-x` short and `--xxx` long forms:

- `-m` / `--message` (assign, handoff)
- `-m` / `--message` (merge — the commit message for the landed work; with no `-m`, squashed opens git's editor, or degrades to `--patch` when there's no TTY)
- `-m` / `--message` (nudge — the text to type; defaults to `"continue"`)
- `--all` (sync — every agent; dispatch — every outbox; nudge — every live tmux session)
- `--sync` / `--no-sync` (assign — sync the agent to its base before assigning, on by default; `--sync <ref>` retargets the agent's sync ref to `<ref>` and syncs onto it first, `--no-sync` skips)
- `--nudge` / `--no-nudge` (assign, dispatch — wake a running recipient via its tmux session, on by default; handoff — same, but auto-decided by note presence unless forced)
- `-c` / `--clear` (assign, nudge, handoff — type `/clear` into the recipient's session before the nudge, resetting its context). `-c` means `--clear` on every command that has it; it is never an alias for `--cmd`.
- `--attach` (handoff — carry a different agent's diff than the source)
- `-p` / `--port` (serve, add, set)
- `--cmd` (run, start, set, add — the agent's entrypoint command; long-form only, so `-c` stays reserved for `--clear`)
- `-r` / `--runtime` (run, start, set)
- `-H` / `--host` (add, set)
- `--local` (set — convert an SSH agent back to local, dropping its remote location; errors if already local)
- `-b` / `--branch` (apply)
- `-t` / `--target` (apply)
- `-s` / `--sync` (add, set)
- `--base` / `--current` (sync — retarget the sync ref; `--current` uses the host's current branch)
- `-f` / `--force` (sync — hard reset; rebuild, remove — confirm)
- `--to` (status — push `<from>`'s status snapshot to another agent's `inbox/status`)
- `-i` / `--interactive` (status — page the agent's full status.md instead of the digest)
- `--stat` (diff)
- `--commits`, `--patch` (apply)
- `--3way` (apply — accepted for compatibility; the merge-based flow is inherently 3-way)
- `--advance` / `--no-advance` (merge — advance the agent's seed onto a clean, committed merge that landed on its branch, on by default). Renamed from the former `--sync`/`--no-sync` so `--sync` is a ref-string everywhere and never an overloaded boolean; `--no-sync` on `merge` no longer exists.
- `--rebase` (handoff, dispatch, apply)
- `--poll` (serve)
- `-i` / `--interactive`, `-t` / `--tty` (serve — stack a live shell on top; `-it` reads like `docker run -it`)
- `--dispatch` / `--no-dispatch` (serve — auto-carry settled outbox drafts, on by default)
- `--stop` (serve — stop the running server for this workspace: reads `server.json`, signals the pid, removes the pidfile; a clean message when none is running)
