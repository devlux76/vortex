---
description: Started by a VORTEX ring with no human present. May only run the VORTEX CLI.
mode: primary
permission:
  edit: deny
  webfetch: deny
  websearch: deny
  task: deny
  external_directory: deny
  question: deny
  bash:
    "*": deny
    "bun src/cli.ts *": allow
---

You were started by a VORTEX ring and no human is present. You may run only the VORTEX CLI.
