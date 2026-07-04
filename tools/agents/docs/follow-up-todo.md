# Follow-up TODO

## Cross-platform and Runtime Resilience

- Done: user-level config/data roots are platform-aware. Linux keeps XDG-style defaults, macOS uses `~/Library/Application Support/quimby`, Windows uses AppData (`Roaming` for config, `Local` for durable data), and explicit XDG/Quimby env overrides still win.
- Done: SSH transport errors distinguish missing local OpenSSH/rsync from unreachable hosts and from missing remote tools, so add/run/restore/doctor surfaces can point at the right machine.
- Done: existing SSH agents always re-check remote `tmux` before launch, not only during first-run provisioning.
- Done: aggregate remote probes in `list` and `status` are bounded by `QUIMBY_REMOTE_PROBE_TIMEOUT_MS` (`QUIMBY_REMOTE_STATUS_TIMEOUT_MS` remains accepted as a compatibility alias). Timed-out remote probes degrade to the normal fallback value and print `remote timeout`.
- Decision: no standard-SSH fallback when remote tmux is unavailable. SSH persistence, reconnect, nudges, logs, and dashboard tabs are built around retained tmux sessions; silently dropping to a raw SSH command would look successful while losing those semantics.
- Decision: no local/host fallback for tmux-managed runs. Foreground local runs remain the non-tmux mode; host shells in dashboards are part of the dashboard tmux view, so missing tmux should fail clearly rather than create a different UI.
- Still open: a full Windows host audit beyond path defaults. Shell assumptions (`bash`, POSIX quoting, `sh -c`, tmux availability, rsync/OpenSSH packaging) still need a deliberate compatibility strategy or explicit unsupported-host diagnostics.
