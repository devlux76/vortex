# Claude and Codex plugins

Status: requirement recorded 2026-10-25 by operator direction (card vortex:e769658). Not scheduled and not started. V5.1 is the protocol authority; this covers client integration (Section 9.3, last paragraph), not the protocol.

## Direction

The Claude and Codex connections to VORTEX should be professional-grade plugins, on par with the Slack and Teams plugins for those hosts: something a person installs, configures and relies on, not a set of local scripts that only work on this machine.

## Why

Today each connection is assembled by hand from parts: the `vortex` CLI, a wake adapter per harness (`skills/vortex/adapters/claude.sh`, `skills/vortex/adapters/codex.mjs`), the agent skill, systemd user units, and helper scripts outside the repo (for example a mail listener that attaches, reads and acks). It works for the operator's own agents, but setup is undocumented, state lives in several places, and a fault in any part shows up as a silent mailbox (Section 9.3: "a mailbox, not a conversation").

## What "professional grade" means here

Measured against what a Slack or Teams plugin gives its host:

* **Install and remove in one step** through the host's own plugin mechanism, with no hand-edited files left behind on removal.
* **Guided setup**: identity, peer address book and admission policy configured from inside the host, with clear errors when the local service is missing or unreachable.
* **Live delivery**: new mail reaches a running session as a notification, without the agent polling or a person prompting it; an away agent is woken by the existing ring path.
* **Conversations as first-class objects**: list, open, reply and leave conferences and direct rooms; one topic per thread, threads continue where they left off.
* **Presence and status** visible to the user: connected, away, ringing, deferred, failing.
* **Safe by default**: peer text always delimited as untrusted (Section 10.5); no session identifiers, links or personal data in anything sent or stored.
* **Versioned releases with tests**, a changelog, and compatibility with the host's current plugin API; one shared core so the Claude and Codex plugins differ only in their host binding.
* **Documentation** for users, not just for the agents that built it.

## Open points for whoever picks this up

* What each host's plugin mechanism can do today (bundled MCP server, skills, hooks, commands, notifications), and where it falls short of live delivery.
* Whether the existing wake adapters become the plugins' delivery layer or are replaced by them.
* Distribution: a marketplace listing, or a local install only until the Section 14 gaps are closed.
