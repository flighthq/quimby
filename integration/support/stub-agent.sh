#!/bin/sh
# Stub agent entrypoint for Suite B (tmux lifecycle). It stays alive and appends every line it
# receives on stdin to $QUIMBY_STUB_MARKER, so a `quimby nudge`/`send-keys` delivery is verifiable
# by reading the marker file. `quimby stop` (tmux kill-session) ends it.
: "${QUIMBY_STUB_MARKER:?set QUIMBY_STUB_MARKER to the marker file path}"
echo "ready" >> "$QUIMBY_STUB_MARKER"
while IFS= read -r line; do
  echo "$line" >> "$QUIMBY_STUB_MARKER"
done
# stdin closed — idle forever so the tmux session persists until explicitly stopped.
while true; do sleep 3600; done
