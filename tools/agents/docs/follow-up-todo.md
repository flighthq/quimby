# Follow-up TODO

## Cross-platform and Runtime Resilience

- Audit whether the host machine can be Windows, and which local path, shell, process, and tmux assumptions must change or fail clearly.
- Audit whether the host machine can be macOS, including whether default config/data paths feel native and match platform expectations.
- Decide whether SSH agent runs can fall back gracefully to a standard SSH connection when remote tmux is unavailable, with a clear warning about lost persistence.
- Decide whether local/host runs can fall back gracefully when tmux is unavailable, with a clear warning about lost persistence.
- Ensure missing SSH client/server access fails with actionable diagnostics at add, doctor, run, restore, and status boundaries.
- Review `--all` commands and aggregate status flows for hanging remote connections: stream results as they arrive, show progress for pending hosts, and apply bounded timeouts where appropriate.
