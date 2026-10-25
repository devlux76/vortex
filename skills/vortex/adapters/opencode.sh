#!/bin/sh
set -u
here="$(dirname "$(realpath "$0")")"
bun "$here/opencode.mjs"
code=$?
# Only a genuine adapter failure (exit 1) means OpenCode could not be woken.
# Exit 76 means the prompt was accepted but ack is pending: do not tell peers
# it is offline.
if [ "$code" -eq 1 ]; then bun "$here/away.mjs" OpenCode || true; fi
exit "$code"
